import {
  loadTenantsSync,
  getTenantConfig,
  isOwner,
  writeTenantsConfig,
  isExpired,
} from "../store/tenants-config.js";
import { getUsage, ensureUsageRow, deleteUsage, recordQuotaEvent } from "../store/usage-db.js";
import { startInviteFlow } from "../weixin/qr-invite.js";
import { appendNotification } from "../store/notifications.js";
import { log } from "../utils/logger.js";


// ── Constants ─────────────────────────────────────
const TENANT_ID_REGEX = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const RESERVED_IDS = new Set(["main", "system", "cron", "heartbeat", "probe"]);
const MAX_TENANTS = 20;

// ── Args parser ───────────────────────────────────
function parseArgs(argsStr) {
  const result = { _: [] };
  const tokens = argsStr.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].startsWith("--")) {
      const key = tokens[i].slice(2);
      // Check if next token is a value (not another flag)
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("--")) {
        result[key] = tokens[i + 1];
        i += 2;
      } else {
        result[key] = true;
        i += 1;
      }
    } else {
      result._.push(tokens[i]);
      i += 1;
    }
  }
  return result;
}

// ── Validation ────────────────────────────────────
function validateBeforeCreate(config, tenantId, options) {
  const errors = [];

  if (!TENANT_ID_REGEX.test(tenantId)) {
    errors.push(`ID "${tenantId}" 格式无效（仅小写字母/数字/连字符，3-32 字符）`);
  }
  if (RESERVED_IDS.has(tenantId)) {
    errors.push(`"${tenantId}" 是保留 ID`);
  }
  const existingIds = new Set(config.agents?.list?.map(a => a.id) || []);
  if (existingIds.has(tenantId)) {
    errors.push(`Agent ID "${tenantId}" 已存在`);
  }
  const tenantCount = (config.agents?.list || []).filter(a => a.id !== "main").length;
  if (tenantCount >= MAX_TENANTS) {
    errors.push(`已达租户上限 ${MAX_TENANTS}`);
  }
  if (options.model) {
    const slash = options.model.indexOf("/");
    if (slash === -1) {
      errors.push(`Model 格式无效，需 "provider/modelId"`);
    }
    // Full model validation requires openclaw config, done at create time
  }

  return errors;
}

// ── Command: create ───────────────────────────────
async function handleCreate(api, db, args) {
  const tenantId = args._[0];
  if (!tenantId) return { text: "❌ 用法: /tenant create <id> --channel <channel> [--token <bot_token>] [--model <m>] [--tools <list>] ..." };
  if (!args.channel) return { text: "❌ 必须指定 --channel" };

  const config = api.runtime.config.loadConfig();
  const errors = validateBeforeCreate(config, tenantId, args);
  if (errors.length > 0) {
    return { text: `❌ 创建失败:\n${errors.map(e => `  • ${e}`).join("\n")}` };
  }

  // Build new openclaw config
  const newConfig = structuredClone(config);

  // Register channel token if --token provided
  if (args.token) {
    const ch = args.channel;
    newConfig.channels ??= {};
    newConfig.channels[ch] ??= {};
    newConfig.channels[ch].botToken = args.token;
    newConfig.channels[ch].enabled = true;
  }
  newConfig.agents ??= {};
  newConfig.agents.list ??= [];
  newConfig.bindings ??= []; // 顶层 bindings，非 agents.bindings

  const agentEntry = {
    id: tenantId,
    tools: {
      profile: "minimal",
      allow: args.tools
        ? args.tools.split(",").map(s => s.trim())
        : ["read", "web_search", "image", "memory_search", "memory_get"],
      deny: ["exec", "write", "edit", "session_status"],
    },
  };
  if (args.model) {
    agentEntry.model = { primary: args.model, fallbacks: [] };
  }
  newConfig.agents.list.push(agentEntry);

  // bindings schema 要求 match 为嵌套对象，channel 不能放顶层
  const binding = {
    agentId: tenantId,
    match: { channel: args.channel },
  };
  if (args.account) binding.match.accountId = args.account;
  if (args.peer) binding.match.peer = { id: args.peer };
  if (args["peer-kind"] && binding.match.peer) binding.match.peer.kind = args["peer-kind"];
  newConfig.bindings.push(binding);

  // Adjust maxConcurrent
  const tenantCount = newConfig.agents.list.filter(a => a.id !== "main").length;
  const recommended = tenantCount + 2;
  newConfig.agents.defaults ??= {};
  if ((newConfig.agents.defaults.maxConcurrent ?? 1) < recommended) {
    newConfig.agents.defaults.maxConcurrent = recommended;
  }

  // Write openclaw.json
  try {
    await api.runtime.config.writeConfigFile(newConfig);
  } catch (err) {
    return { text: `❌ 配置写入失败: ${err.message}\n.bak 备份已自动创建` };
  }

  // Post-write verification
  const reloaded = api.runtime.config.loadConfig();
  const found = reloaded.agents?.list?.some(a => a.id === tenantId);
  if (!found) {
    log.warn(`writeConfigFile succeeded but agent "${tenantId}" not found in reloaded config`);
  }

  // Update tenants.json
  const tenantsConfig = loadTenantsSync();
  tenantsConfig.tenants ??= {};
  tenantsConfig.tenants[tenantId] = {
    label: args.name || tenantId,
    quota: {
      maxTokens: args.tokens ? parseInt(args.tokens) : (tenantsConfig.defaults?.quota?.maxTokens || 100000),
      maxCalls: args.calls ? parseInt(args.calls) : (tenantsConfig.defaults?.quota?.maxCalls || 50),
      expiresAt: args.expires || null,
      resetInterval: args["reset-interval"] || "daily",
    },
    ...(args.tools && { tools: { allow: args.tools.split(",").map(s => s.trim()), deny: ["exec", "write", "edit"] } }),
    ...(args.language && { language: args.language }),
    ...(args["over-limit"] && { overLimit: { action: args["over-limit"], downgradeModel: args["downgrade-model"] || null } }),
    ...(args["system-prompt"] && { systemPrompt: args["system-prompt"] }),
  };
  writeTenantsConfig(tenantsConfig);

  // Initialize SQLite row
  ensureUsageRow(db, tenantId);
  recordQuotaEvent(db, tenantId, "created", `channel=${args.channel}`);

  const parts = [`✅ 租户 ${tenantId} 已创建`];
  if (args.token) parts.push(`🔑 渠道 ${args.channel} token 已注册`);
  if (args.model) parts.push(`📦 模型: ${args.model}`);
  parts.push(`🔄 Gateway 正在重启以加载新配置...`);
  // 延迟退出，让响应先发回给用户；docker restart:always 会自动重启容器
  setTimeout(() => { log.info("Restarting gateway after tenant create"); process.exit(0); }, 3000);
  return { text: parts.join("\n") };
}

// ── Command: delete ───────────────────────────────
async function handleDelete(api, db, tenantId) {
  if (!tenantId) return { text: "❌ 用法: /tenant delete <id>" };
  if (tenantId === "main") return { text: "❌ 不能删除主 agent" };

  const tenantsConfigCheck = loadTenantsSync();
  const config = api.runtime.config.loadConfig();
  const newConfig = structuredClone(config);

  // 只要 tenants.json 或 openclaw.json 其中一处存在即可删除（兼容孤立残留状态）
  const inTenants = !!tenantsConfigCheck.tenants?.[tenantId];
  const agentIndex = newConfig.agents?.list?.findIndex(a => a.id === tenantId);
  const inConfig = agentIndex !== -1 && agentIndex !== undefined;
  if (!inTenants && !inConfig) {
    return { text: `❌ 租户 ${tenantId} 不存在` };
  }

  if (inConfig) {
    newConfig.agents.list.splice(agentIndex, 1);
  }

  // 从顶层 bindings 找出该租户绑定的 channel
  const tenantChannels = (newConfig.bindings || [])
    .filter(b => b.agentId === tenantId && b.channel)
    .map(b => b.channel);

  // 移除该租户的所有 bindings
  newConfig.bindings = (newConfig.bindings || []).filter(b => b.agentId !== tenantId);

  // 只删除没有被其他 binding 引用的 channel 配置，避免误删共享渠道
  const removedChannels = [];
  const remainingChannels = new Set((newConfig.bindings || []).map(b => b.channel).filter(Boolean));
  for (const ch of tenantChannels) {
    if (!remainingChannels.has(ch) && newConfig.channels?.[ch]) {
      delete newConfig.channels[ch];
      removedChannels.push(ch);
    }
  }

  try {
    await api.runtime.config.writeConfigFile(newConfig);
  } catch (err) {
    return { text: `❌ 配置写入失败: ${err.message}` };
  }

  // Clean tenants.json
  const tenantsConfig = tenantsConfigCheck;
  if (tenantsConfig.tenants?.[tenantId]) {
    delete tenantsConfig.tenants[tenantId];
    writeTenantsConfig(tenantsConfig);
  }

  // Clean SQLite
  deleteUsage(db, tenantId);
  recordQuotaEvent(db, tenantId, "deleted", null);

  const parts = [`✅ 租户 ${tenantId} 已删除`];
  if (removedChannels.length > 0) parts.push(`🗑️ 渠道配置已清除: ${removedChannels.join(", ")}`);
  parts.push(`🔄 Gateway 正在重启以加载新配置...`);
  // 延迟退出，让响应先发回给用户；docker restart:always 会自动重启容器
  setTimeout(() => { log.info("Restarting gateway after tenant delete"); process.exit(0); }, 3000);
  return { text: parts.join("\n") };
}

// ── Command: list ─────────────────────────────────
function handleList(db) {
  const tenantsConfig = loadTenantsSync();
  const tenants = tenantsConfig.tenants || {};
  const ids = Object.keys(tenants);

  if (ids.length === 0) return { text: "暂无租户。使用 /tenant create 创建。" };

  const lines = ids.map(id => {
    const t = getTenantConfig(id);
    const usage = getUsage(db, id) || { tokens: 0, calls: 0 };
    const quota = t?.quota || {};

    let status = "✅ 活跃";
    if (isExpired(quota)) status = "⏰ 已过期";
    else if (quota.maxTokens && usage.tokens >= quota.maxTokens) status = "🚫 已超限";
    else if (quota.maxTokens && usage.tokens / quota.maxTokens >= 0.8) status = "⚠️ 即将超限";

    return `${id.padEnd(16)} tokens: ${usage.tokens}/${quota.maxTokens || "∞"}  calls: ${usage.calls}/${quota.maxCalls || "∞"}  ${status}`;
  });

  return { text: `租户列表（共 ${ids.length} 个）\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${lines.join("\n")}` };
}

// ── Command: quota ────────────────────────────────
function handleQuota(db, args) {
  const tenantId = args._[0];
  if (!tenantId) return { text: "❌ 用法: /tenant quota <id> [--tokens <n>] [--calls <n>] [--expires <ISO>] [--reset]" };

  const tenantsConfig = loadTenantsSync();
  if (!tenantsConfig.tenants?.[tenantId]) return { text: `❌ 租户 ${tenantId} 不存在` };

  const tenant = tenantsConfig.tenants[tenantId];
  let changed = false;

  if (args.tokens) { tenant.quota.maxTokens = parseInt(args.tokens); changed = true; }
  if (args.calls) { tenant.quota.maxCalls = parseInt(args.calls); changed = true; }
  if (args.expires) { tenant.quota.expiresAt = args.expires; changed = true; }
  if (args["reset-interval"]) { tenant.quota.resetInterval = args["reset-interval"]; changed = true; }

  if (args.reset === true) {
    const db2 = db;
    db2.prepare("UPDATE usage SET tokens = 0, calls = 0, notified = 0, last_reset = ? WHERE agent_id = ?")
      .run(Date.now(), tenantId);
    recordQuotaEvent(db, tenantId, "reset", "manual");
    if (!changed) return { text: `✅ 租户 ${tenantId} 用量已重置` };
  }

  if (changed) {
    writeTenantsConfig(tenantsConfig);
    return { text: `✅ 租户 ${tenantId} 配额已更新` };
  }

  // Display current quota
  const usage = getUsage(db, tenantId) || { tokens: 0, calls: 0 };
  const q = tenant.quota;
  return {
    text: [
      `📊 ${tenantId} 配额信息：`,
      `  Tokens: ${usage.tokens} / ${q.maxTokens || "∞"}`,
      `  Calls:  ${usage.calls} / ${q.maxCalls || "∞"}`,
      `  重置:   ${q.resetInterval || "none"}`,
      `  过期:   ${q.expiresAt || "无限期"}`,
    ].join("\n"),
  };
}

// ── Command: config ───────────────────────────────
function handleConfig(args) {
  const tenantId = args._[0];
  if (!tenantId) return { text: "❌ 用法: /tenant config <id> [--model <m>] [--tools <list>] [--language <lang>] ..." };

  const tenantsConfig = loadTenantsSync();
  if (!tenantsConfig.tenants?.[tenantId]) return { text: `❌ 租户 ${tenantId} 不存在` };

  const tenant = tenantsConfig.tenants[tenantId];
  let changed = false;

  if (args.model) { tenant.model = args.model; changed = true; }
  if (args.tools) {
    tenant.tools = {
      allow: args.tools.split(",").map(s => s.trim()),
      deny: tenant.tools?.deny || ["exec", "write", "edit"],
    };
    changed = true;
  }
  if (args.language) { tenant.language = args.language; changed = true; }
  if (args["over-limit"]) {
    tenant.overLimit = {
      action: args["over-limit"],
      downgradeModel: args["downgrade-model"] || tenant.overLimit?.downgradeModel || null,
    };
    changed = true;
  }
  if (args["system-prompt"]) { tenant.systemPrompt = args["system-prompt"]; changed = true; }
  if (args["memory-read"]) {
    tenant.memory = { ...tenant.memory, globalRead: args["memory-read"] === "on" };
    changed = true;
  }

  if (!changed) return { text: `❌ 未指定要修改的配置项` };

  writeTenantsConfig(tenantsConfig);
  return { text: `✅ 租户 ${tenantId} 配置已更新（无需重启）` };
}

// ── Command: owner ────────────────────────────────
function handleOwner(args) {
  const subCmd = args._[0];
  const agentId = args._[1];
  const tenantsConfig = loadTenantsSync();
  tenantsConfig.ownerAgents ??= ["main"];

  if (subCmd === "list" || !subCmd) {
    return { text: `🔑 管理员 bot 列表：\n${tenantsConfig.ownerAgents.map(a => `  • ${a}`).join("\n")}` };
  }

  if (subCmd === "add") {
    if (!agentId) return { text: "❌ 用法: /tenant owner add <agentId>" };
    if (tenantsConfig.ownerAgents.includes(agentId)) {
      return { text: `${agentId} 已经是管理员` };
    }
    tenantsConfig.ownerAgents.push(agentId);
    writeTenantsConfig(tenantsConfig);
    return { text: `✅ ${agentId} 已添加为管理员` };
  }

  if (subCmd === "remove") {
    if (!agentId) return { text: "❌ 用法: /tenant owner remove <agentId>" };
    if (agentId === "main") return { text: "❌ 不能移除 main" };
    tenantsConfig.ownerAgents = tenantsConfig.ownerAgents.filter(a => a !== agentId);
    writeTenantsConfig(tenantsConfig);
    return { text: `✅ ${agentId} 已从管理员列表移除` };
  }

  return { text: "❌ 用法: /tenant owner [list|add|remove] <agentId>" };
}

// ── Command: cleanup ──────────────────────────────
async function handleCleanup(api, db, args) {
  const tenantsConfig = loadTenantsSync();
  const tenants = tenantsConfig.tenants || {};
  const now = Date.now();
  const candidates = [];

  for (const [id, tenant] of Object.entries(tenants)) {
    if (args.expired && tenant.quota?.expiresAt && new Date(tenant.quota.expiresAt).getTime() < now) {
      candidates.push({ id, reason: `过期于 ${tenant.quota.expiresAt}` });
    }
    if (args["inactive-days"]) {
      const profile = db.prepare("SELECT last_seen FROM profiles WHERE agent_id = ?").get(id);
      if (profile?.last_seen) {
        const daysSince = (now - new Date(profile.last_seen).getTime()) / 86400000;
        if (daysSince > parseInt(args["inactive-days"])) {
          candidates.push({ id, reason: `不活跃 ${Math.floor(daysSince)} 天` });
        }
      }
    }
  }

  if (candidates.length === 0) return { text: "✅ 没有需要清理的租户" };

  if (args["dry-run"] === true) {
    const list = candidates.map(c => `  • ${c.id}: ${c.reason}`).join("\n");
    return { text: `🔍 预览（不执行删除）:\n${list}` };
  }

  let success = 0, failed = 0;
  for (const c of candidates) {
    const result = await handleDelete(api, db, c.id);
    if (result.text.startsWith("✅")) success++; else failed++;
  }
  return { text: `🧹 清理完成: ${success} 成功, ${failed} 失败` };
}

// ── Command: profile ─────────────────────
function handleProfile(db, args) {
  const tenantId = args._[0];
  if (!tenantId) return { text: "❌ 用法: /tenant profile <id>" };

  const profile = db.prepare("SELECT * FROM profiles WHERE agent_id = ?").get(tenantId);
  if (!profile) return { text: `❌ 租户 ${tenantId} 暂无画像数据（还未进行过会话）` };

  return {
    text: [
      `👤 ${tenantId} 画像信息：`,
      `  名称:     ${profile.label || tenantId}`,
      `  首次使用: ${profile.first_seen || "N/A"}`,
      `  最后活跃: ${profile.last_seen || "N/A"}`,
      `  会话数:   ${profile.session_count}`,
      `  总 Token: ${profile.total_tokens}`,
      `  总调用:   ${profile.total_calls}`,
    ].join("\n"),
  };
}

// ── Command: invite ───────────────────────────────────
async function handleInvite(db, dataDir, args) {
  const label = args._[0] || "新用户";

  const result = await startInviteFlow({
    timeoutMs: 300_000,

    onResult: (res) => {
      if (res.success && res.userId) {
        // Auto-register tenant in tenants.json
        const peerKey = `peer:${res.userId}`;
        const config = loadTenantsSync();
        if (!config.tenants) config.tenants = {};

        if (!config.tenants[peerKey]) {
          config.tenants[peerKey] = {
            label,
            createdAt: new Date().toISOString(),
            weixinUserId: res.userId,
          };
          writeTenantsConfig(config);
          ensureUsageRow(db, peerKey);
          recordQuotaEvent(db, peerKey, "created", `via invite, label=${label}`);
          log.info(`Invite success: registered ${peerKey} as tenant "${label}"`);
        }

        // Notify owner
        appendNotification(dataDir, {
          agentId: peerKey,
          type: "invite_success",
          message: `✅ ${label} (微信用户) 已通过扫码成功注册为租户。`,
        });
      } else {
        // Notify owner about failure
        appendNotification(dataDir, {
          agentId: "system",
          type: "invite_failed",
          message: `❌ 邀请 "${label}" 失败：${res.message}`,
        });
      }
    },

    onRefresh: (refreshData) => {
      // Emit a notification when QR is refreshed
      appendNotification(dataDir, {
        agentId: "system",
        type: "invite_qr_refresh",
        message: `${refreshData.message}\n新二维码：${refreshData.qrcodeImgUrl}`,
      });
    },
  });

  if (result.error) {
    return { text: `❌ ${result.error}` };
  }

  return {
    text: [
      `🔗 邀请 "${label}" 加入`,
      "━━━━━━━━━━━━━━━━━━━━━━━━",
      result.message,
      "",
      "⏰ 有效期 5 分钟，过期将自动刷新（最多 3 次）",
      "✅ 扫码成功后将自动创建租户并通知您",
    ].join("\n"),
    mediaUrl: result.qrcodeImgUrl,
  };
}

// ── Main handler ──────────────────────────────────
export function createTenantCommandHandler(api, db) {
  return async (ctx) => {
    const argsStr = ctx.args || "";
    const tokens = argsStr.trim().split(/\s+/);
    const subCmd = tokens[0] || "help";
    const restArgs = parseArgs(tokens.slice(1).join(" "));

    switch (subCmd) {
      case "create":  return handleCreate(api, db, restArgs);
      case "delete":  return handleDelete(api, db, restArgs._[0]);
      case "list":    return handleList(db);
      case "quota":   return handleQuota(db, restArgs);
      case "config":  return handleConfig(restArgs);
      case "owner":   return handleOwner(restArgs);
      case "cleanup": return handleCleanup(api, db, restArgs);
      case "invite":  return handleInvite(db, api.resolvePath("data"), restArgs);
      case "profile": return handleProfile(db, restArgs);
      case "help":
      default:
        return {
          text: [
            "📋 tenant-guard 管理命令",
            "━━━━━━━━━━━━━━━━━━━━━━━━",
            "/tenant create <id> --channel <ch> [--token <bot_token>] [--model <m>] [--tools <list>] [--language <lang>]",
            "/tenant delete <id>",
            "/tenant list",
            "/tenant quota <id> [--tokens <n>] [--calls <n>] [--expires <ISO>] [--reset]",
            "/tenant config <id> [--model <m>] [--tools <list>] [--language <lang>]",
            "/tenant owner [list|add|remove] <agentId>",
            "/tenant cleanup [--expired] [--inactive-days <N>] [--dry-run]",
            "/tenant invite [名称]  ← 生成微信二维码邀请新用户",
            "/tenant profile <id>",
          ].join("\n"),
        };
    }
  };
}
