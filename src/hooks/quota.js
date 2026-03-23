import {
  addUsage,
  getUsage,
  checkAndReset,
  markNotified,
  ensureUsageRow,
  recordQuotaEvent,
} from "../store/usage-db.js";
import {
  getTenantConfig,
  getResetIntervalMs,
  isExpired,
  isOwner,
  getEffectiveTenantId,
  loadTenantsSync,
} from "../store/tenants-config.js";
import { appendNotification } from "../store/notifications.js";
import { log } from "../utils/logger.js";

const BLOCKED_TOOLS = new Set(["exec", "write", "edit", "session_status"]);
const WARNING_THRESHOLD = 0.8;

/**
 * Build language hint string from language config.
 */
function buildLanguageHint(language) {
  if (!language || language === "auto") return "";
  const map = {
    zh: "请始终使用中文回复用户。",
    en: "Please always reply in English.",
    ja: "常に日本語で返信してください。",
  };
  return map[language] || `请使用${language}回复用户。`;
}

/**
 * Build system prompt from template and tenant config.
 */
function buildSystemPrompt(agentId, tenantConfig) {
  const config = loadTenantsSync();
  const template = tenantConfig.systemPrompt || config.systemPromptTemplate || "";
  if (!template) return null;

  // If tenant has custom systemPrompt, use it directly (may still have variables)
  const languageHint = buildLanguageHint(tenantConfig.language);
  const quota = tenantConfig.quota || {};

  return template
    .replace(/\{name\}/g, tenantConfig.label || agentId)
    .replace(/\{language_hint\}/g, languageHint)
    .replace(/\{maxTokens\}/g, String(quota.maxTokens || "N/A"))
    .replace(/\{maxCalls\}/g, String(quota.maxCalls || "N/A"))
    .replace(/\{expiresAt\}/g, quota.expiresAt ? new Date(quota.expiresAt).toLocaleDateString() : "无限期");
}

// ═══════════════════════════════════════════════════
// llm_output hook — Token/Calls counting
// ═══════════════════════════════════════════════════

export function onLlmOutput(db, dataDir) {
  return (event, ctx) => {
    const tenantId = getEffectiveTenantId(ctx);
    if (!tenantId) return; // Owner or unknown

    const tenantConfig = getTenantConfig(tenantId);

    // Auto-reset check
    const intervalMs = getResetIntervalMs(tenantConfig.quota);
    if (intervalMs) {
      checkAndReset(db)(tenantId, intervalMs);
    }

    // Count tokens
    const inputTokens = event.usage?.input ?? 0;
    const outputTokens = event.usage?.output ?? 0;
    const tokens = inputTokens + outputTokens;

    if (tokens === 0) {
      log.warn(`Tenant ${tenantId}: usage is null/zero in llm_output`);
    }

    addUsage(db, tenantId, tokens);
    log.debug(`Tenant ${tenantId}: +${tokens} tokens (in=${inputTokens}, out=${outputTokens})`);

    // Check if first time exceeding limit → write notification
    const usage = getUsage(db, tenantId);
    const quota = tenantConfig.quota;
    if (
      usage &&
      quota.maxTokens &&
      usage.tokens >= quota.maxTokens &&
      markNotified(db, tenantId)
    ) {
      log.info(`Tenant ${tenantId}: exceeded token limit (${usage.tokens}/${quota.maxTokens})`);
      recordQuotaEvent(db, tenantId, "exceeded", `tokens=${usage.tokens}/${quota.maxTokens}`);
      appendNotification(dataDir, {
        agentId: tenantId,
        type: "exceeded",
        message: `Token 额度用尽（${usage.tokens}/${quota.maxTokens}）`,
      });
    }
  };
}

// ═══════════════════════════════════════════════════
// before_tool_call hook — Quota enforcement + tool blocking
// ═══════════════════════════════════════════════════

export function onBeforeToolCall(db) {
  return (event, ctx) => {
    const tenantId = getEffectiveTenantId(ctx);
    if (!tenantId) return; // Owner

    const tenantConfig = getTenantConfig(tenantId);

    // 1. Tool permission check (use tenant-specific tools config)
    const denyList = new Set(tenantConfig.tools?.deny || BLOCKED_TOOLS);
    if (denyList.has(event.toolName)) {
      log.info(`Tenant ${tenantId}: blocked tool "${event.toolName}"`);
      return { block: true, blockReason: `无操作权限：${event.toolName}` };
    }

    // If allow list is defined, check allowlist (allow takes precedence pattern)
    const allowList = tenantConfig.tools?.allow;
    if (allowList && allowList.length > 0) {
      const allowSet = new Set(allowList);
      if (!allowSet.has(event.toolName) && !event.toolName.startsWith("memory_")) {
        log.info(`Tenant ${tenantId}: tool "${event.toolName}" not in allow list`);
        return { block: true, blockReason: `不支持的工具：${event.toolName}` };
      }
    }

    // 2. Expiry check
    if (isExpired(tenantConfig.quota)) {
      return { block: true, blockReason: "授权已过期，请联系管理员续期。" };
    }

    // 3. Quota check
    const usage = getUsage(db, tenantId);
    if (!usage) return;

    const quota = tenantConfig.quota;
    const tokenExceeded = quota.maxTokens && usage.tokens >= quota.maxTokens;
    const callsExceeded = quota.maxCalls && usage.calls >= quota.maxCalls;

    if (tokenExceeded || callsExceeded) {
      const overLimit = tenantConfig.overLimit || { action: "reject" };

      if (overLimit.action === "downgrade") {
        // Downgrade mode: allow the call (don't block)
        // Model switching is handled in before_prompt_build
        return;
      }

      // Reject mode (default)
      const detail = tokenExceeded
        ? `Token 额度已用完 (${usage.tokens}/${quota.maxTokens})`
        : `调用次数已用完 (${usage.calls}/${quota.maxCalls})`;
      return { block: true, blockReason: `🚫 ${detail}。请联系管理员续期。` };
    }
  };
}

// ═══════════════════════════════════════════════════
// before_prompt_build hook — Warning injection + system prompt
// ═══════════════════════════════════════════════════

export function onBeforePromptBuild(db, dataDir) {
  return (event, ctx) => {
    const agentId = ctx.agentId;
    if (!agentId) return;

    // Owner: notifications injection will be handled in M5
    if (isOwner(ctx)) return;

    const tenantId = getEffectiveTenantId(ctx);
    if (!tenantId) return;

    const tenantConfig = getTenantConfig(tenantId);

    const parts = [];

    // 1. System prompt / language constraint
    const systemPrompt = buildSystemPrompt(tenantId, tenantConfig);
    if (systemPrompt) {
      parts.push(systemPrompt);
    }

    // 2. Expiry check
    if (isExpired(tenantConfig.quota)) {
      parts.push("🚫 你的授权已过期。请告知用户授权已过期，无法继续提供服务，请联系管理员续期。");
      return { prependContext: parts.join("\n\n") };
    }

    // 3. Auto-reset check
    const intervalMs = getResetIntervalMs(tenantConfig.quota);
    if (intervalMs) {
      checkAndReset(db)(tenantId, intervalMs);
    }

    // 4. Usage warning / downgrade notification
    const usage = getUsage(db, tenantId);
    if (usage) {
      const quota = tenantConfig.quota;
      const tokenRatio = quota.maxTokens ? usage.tokens / quota.maxTokens : 0;
      const callRatio = quota.maxCalls ? usage.calls / quota.maxCalls : 0;
      const maxRatio = Math.max(tokenRatio, callRatio);

      if (maxRatio >= 1) {
        const overLimit = tenantConfig.overLimit || { action: "reject" };
        if (overLimit.action === "downgrade") {
          parts.push(
            `⚠️ 你的快速额度已用完，已切换到快速模式。回复速度更快但质量可能略有下降。`
          );
        }
        // reject mode warning is handled by before_tool_call blockReason
      } else if (maxRatio >= WARNING_THRESHOLD) {
        const pct = (maxRatio * 100).toFixed(0);
        parts.push(
          `⚠️ 提示：额度已使用 ${pct}%（${usage.tokens}/${quota.maxTokens || "∞"} tokens，${usage.calls}/${quota.maxCalls || "∞"} 次调用）。`
        );
      }
    }

    // 5. First-use welcome
    const profile = db
      .prepare("SELECT session_count FROM profiles WHERE agent_id = ?")
      .get(tenantId);
    if (!profile || profile.session_count === 0) {
      const quota = tenantConfig.quota;
      const toolsList = (tenantConfig.tools?.allow || []).join("、") || "基础对话";
      const welcome = [
        `👋 你好！我是 ${tenantConfig.label || tenantId}。`,
        `📊 体验额度：${quota.maxTokens || "∞"} tokens / ${quota.maxCalls || "∞"} 次调用`,
        quota.expiresAt ? `⏰ 有效期至：${new Date(quota.expiresAt).toLocaleDateString()}` : "",
        `💡 支持的能力：${toolsList}`,
        "",
        "有任何问题都可以问我！",
      ].filter(Boolean).join("\n");
      parts.push(welcome);
    }

    if (parts.length > 0) {
      return { prependContext: parts.join("\n\n") };
    }
  };
}
