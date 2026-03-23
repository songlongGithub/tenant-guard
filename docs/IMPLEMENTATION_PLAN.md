# tenant-guard 实施方案

> 版本：v1.0 → **v1.0-final**
> 日期：2026-03-22（初稿） → 2026-03-23（完成）
> 基于 OpenClaw Plugin SDK v2 源码验证

## 实施状态

| 里程碑 | 状态 | 自测 | 提交 |
|--------|------|------|------|
| M2 配额执行核心 | ✅ 完成 | 30/30 | `4362646` |
| M5 Owner 通知队列 | ✅ 完成 | 15/15 | `23bfc79` |
| M3 管理命令 | ✅ 完成 | 25/25 | `d4e5220` |
| M4 租户画像 | ✅ 完成 | 14/14 | `49304f7` |
| M6 Docker 集成验证 | ✅ 完成 | — | `b91d145` |

### Docker 验证结果

- ✅ `openclaw plugins install` 安装成功
- ✅ SQLite + 所有 hooks + /tenant command 注册正常
- ✅ 重启后插件持久化加载正常

### OpenClaw 兼容性修复

| 发现的问题 | 修复方式 |
|-----------|---------|
| `package.json missing openclaw.extensions` | 添加 `openclaw.extensions: ["./src/index.js"]` |
| `plugin manifest requires configSchema` | `openclaw.plugin.json` 添加 `configSchema` |
| `async registration is ignored` | `register()` 改为同步 |


---

## 1. 设计决策

基于对本地 OpenClaw 安装 (`/Users/long/.npm-global/lib/node_modules/openclaw/dist/`) 源码的逐行验证，确定以下关键设计决策：

| 问题 | 原始方案 | 最终方案 | 原因 |
|------|---------|---------|------|
| 记忆隔离 | `before_reset` 拦截 bundled session-memory | **独立 workspace 目录** | `before_reset` 是 void hook（fire-and-forget IIFE），无法阻止 |
| 会话画像触发 | `session_end` + 手动拼 sessionFile 路径 | **`before_reset` 用 `event.messages`** | event 已含完整消息数组，无需路径 |
| Topic 提取 | 动态 import `generateSlugViaLLM` | **简单关键词提取（v1）** | 零成本、无外部依赖 |
| LLM topic（v2） | — | **`runtime.subagent.run()`** | 公开 API，稳定 |
| 配置写入 | 手动粘贴配置 | **`writeConfigFile`（merge patch）** | 内部实现增量合并 + 自动备份 |
| 并发安全 | — | **`better-sqlite3` 原子 SQL + CAS** | maxConcurrent > 1 也安全 |
| 多租户响应 | 默认串行 | **`maxConcurrent = 租户数 + 2`** | 避免排队等待 |

---

## 2. 项目结构

```
tenant-guard/
├── src/
│   ├── index.js              # 插件主入口
│   ├── hooks/
│   │   ├── quota.js           # llm_output / before_tool_call / before_prompt_build
│   │   ├── memory-guard.js    # before_tool_call 写入拦截
│   │   ├── profile.js         # before_reset 会话画像
│   │   └── notify.js          # Owner 通知队列
│   ├── commands/
│   │   └── tenant.js          # /tenant 命令处理
│   ├── store/
│   │   ├── usage-db.js        # SQLite 用量数据库
│   │   ├── tenants-config.js  # tenants.json 热加载
│   │   ├── notifications.js   # JSONL 通知队列
│   │   └── profiles.js        # 租户画像存储
│   └── utils/
│       ├── keywords.js        # 关键词提取
│       └── logger.js          # 日志封装
├── data/                      # 运行时数据（gitignored）
│   └── tenants.json           # 配额配置
├── docs/
├── openclaw.plugin.json
├── package.json
└── README.md
```

---

## 3. Plugin SDK API 映射

### 3.1 Hook 注册

| Hook | 用途 | 返回值 |
|------|------|--------|
| `llm_output` | Token/Calls 计数、超限通知 | void |
| `before_tool_call` | 工具拦截 + 配额拦截 | `{ block, blockReason }` |
| `before_prompt_build` | 预警注入 + Owner 通知 drain | `{ prependContext }` |
| `before_reset` | 会话画像生成 | void |

所有 hook priority 设为 `-10`，确保优先于其他插件执行。

### 3.2 命令注册

```javascript
api.registerCommand({
  name: "tenant",
  description: "多租户管理",
  acceptsArgs: true,
  requireAuth: true,  // 仅 Owner
  handler: (ctx) => { /* ctx.args 解析子命令 */ }
});
```

### 3.3 配置写入

```javascript
// writeConfigFile 内部流程：
// 1. loadConfig() 读取当前配置
// 2. structuredClone() 深拷贝
// 3. 修改 agents.list + agents.bindings
// 4. writeConfigFile(newConfig) — 自动 merge patch + 备份
```

---

## 4. 数据库 Schema

```sql
-- 启用 WAL 模式
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS usage (
  agent_id    TEXT PRIMARY KEY,
  tokens      INTEGER NOT NULL DEFAULT 0,
  calls       INTEGER NOT NULL DEFAULT 0,
  notified    INTEGER NOT NULL DEFAULT 0,  -- CAS 防重复通知
  last_reset  INTEGER NOT NULL DEFAULT 0   -- 毫秒时间戳
);

CREATE TABLE IF NOT EXISTS quota_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  event_type TEXT NOT NULL,  -- 'created' | 'exceeded' | 'reset' | 'expired'
  detail     TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  agent_id        TEXT PRIMARY KEY,
  label           TEXT,
  channel         TEXT,
  account_id      TEXT,
  first_seen      TEXT,
  last_seen       TEXT,
  session_count   INTEGER NOT NULL DEFAULT 0,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  total_calls     INTEGER NOT NULL DEFAULT 0
);
```

### 并发安全要点

```javascript
// ✅ 原子递增（不是 SELECT-then-UPDATE）
db.prepare("UPDATE usage SET tokens = tokens + ?, calls = calls + 1 WHERE agent_id = ?")

// ✅ CAS 防重复通知
db.prepare("UPDATE usage SET notified = 1 WHERE agent_id = ? AND notified = 0")

// ✅ 事务保证滑动窗口重置
const resetIfNeeded = db.transaction((agentId, now) => { ... });
```

---

### 4.6 openclaw.json 编辑安全

#### 写入前验证

```javascript
const TENANT_ID_REGEX = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const RESERVED_IDS = new Set(["main", "system", "cron", "heartbeat", "probe"]);
const MAX_TENANTS = 20;

function validateBeforeWrite(config, tenantId, options) {
  const errors = [];

  // 1. ID 格式
  if (!TENANT_ID_REGEX.test(tenantId)) {
    errors.push(`ID "${tenantId}" 格式无效（仅小写字母/数字/连字符，3-32 字符）`);
  }

  // 2. 保留 ID
  if (RESERVED_IDS.has(tenantId)) {
    errors.push(`"${tenantId}" 是保留 ID`);
  }

  // 3. 唯一性
  const existingIds = new Set(config.agents?.list?.map(a => a.id) || []);
  if (existingIds.has(tenantId)) {
    errors.push(`Agent ID "${tenantId}" 已存在`);
  }

  // 4. 租户上限
  const tenantCount = (config.agents?.list || []).filter(a => a.id !== "main").length;
  if (tenantCount >= MAX_TENANTS) {
    errors.push(`已达租户上限 ${MAX_TENANTS}`);
  }

  // 5. Model 引用有效性
  if (options.model) {
    const slash = options.model.indexOf("/");
    if (slash === -1) {
      errors.push(`Model 格式无效，需 "provider/modelId"`);
    } else {
      const provider = options.model.slice(0, slash);
      const modelId = options.model.slice(slash + 1);
      const providerConfig = config.models?.providers?.[provider];
      if (!providerConfig) {
        errors.push(`Provider "${provider}" 不存在，可用: ${Object.keys(config.models?.providers || {}).join(", ")}`);
      } else {
        const modelExists = providerConfig.models?.some(m => m.id === modelId);
        if (!modelExists) {
          errors.push(`Model "${modelId}" 在 provider "${provider}" 中未找到`);
        }
      }
    }
  }

  // 6. Binding 冲突
  if (options.channel) {
    const conflict = (config.agents?.bindings || []).find(b =>
      b.channel === options.channel &&
      (!options.account || b.accountId === options.account) &&
      (!options.peer || b.match?.["peer.id"] === options.peer)
    );
    if (conflict) {
      errors.push(`该 channel+peer 已绑定到 agent "${conflict.agentId}"`);
    }
  }

  return errors;
}
```

#### 安全写入 + 写入后验证

```javascript
async function safeWriteConfig(api, newConfig, { expectAgentId, expectRemoved = false }) {
  try {
    // 写入（内部自动 .bak 备份 + Zod 校验）
    await api.runtime.config.writeConfigFile(newConfig);
  } catch (err) {
    return { ok: false, error: `配置写入失败: ${err.message}\n.bak 备份已自动创建` };
  }

  // 写入后验证
  if (expectAgentId) {
    const reloaded = api.runtime.config.loadConfig();
    const found = reloaded.agents?.list?.some(a => a.id === expectAgentId);
    if (expectRemoved && found) {
      log.warn(`writeConfigFile 成功但 agent "${expectAgentId}" 仍出现在配置中`);
    }
    if (!expectRemoved && !found) {
      log.warn(`writeConfigFile 成功但 agent "${expectAgentId}" 未出现在配置中`);
    }
  }

  return { ok: true };
}
```

#### handleCreate 完整流程

```javascript
async function handleCreate(api, tenantId, options) {
  const config = api.runtime.config.loadConfig();

  // 1. 写入前验证
  const errors = validateBeforeWrite(config, tenantId, options);
  if (errors.length > 0) {
    return { text: `❌ 创建失败:\n${errors.map(e => `  • ${e}`).join("\n")}` };
  }

  // 2. 构建新配置
  const newConfig = structuredClone(config);
  newConfig.agents ??= {};
  newConfig.agents.list ??= [];
  newConfig.agents.bindings ??= [];

  const agentEntry = {
    id: tenantId,
    workspace: { dir: `~/.openclaw/workspaces/${tenantId}` },
    tools: {
      profile: "minimal",
      allow: ["read", "web_search", "image", "memory_search", "memory_get"],
      deny: ["exec", "write", "edit", "session_status"]
    }
  };
  if (options.model) {
    agentEntry.model = { primary: options.model, fallbacks: [] };
  }
  newConfig.agents.list.push(agentEntry);

  newConfig.agents.bindings.push({
    agentId: tenantId,
    channel: options.channel,
    ...(options.account && { accountId: options.account }),
    ...(options.peer && { match: { "peer.id": options.peer } })
  });

  // maxConcurrent 调整
  const tenantCount = newConfig.agents.list.filter(a => a.id !== "main").length;
  const recommended = tenantCount + 2;
  newConfig.agents.defaults ??= {};
  if ((newConfig.agents.defaults.maxConcurrent ?? 1) < recommended) {
    newConfig.agents.defaults.maxConcurrent = recommended;
  }

  // 3. 安全写入 + 验证
  const result = await safeWriteConfig(api, newConfig, { expectAgentId: tenantId });
  if (!result.ok) return { text: result.error };

  // 4. 更新 tenants.json + SQLite
  addTenantQuota(tenantId, options.quota);
  ensureUsageRow(db, tenantId);

  return {
    text: `✅ 租户 ${tenantId} 已创建\n` +
      (options.model ? `📦 模型: ${options.model}\n` : "") +
      `⚠️ 需要重启 gateway 生效`
  };
}
```

### 4.7 租户回收

```javascript
async function handleCleanup(api, db, config, options) {
  const tenants = loadTenantsSync(tenantsPath);
  const now = Date.now();
  const candidates = [];

  for (const [id, quota] of Object.entries(tenants)) {
    const usage = db.prepare("SELECT * FROM usage WHERE agent_id = ?").get(id);
    const profile = db.prepare("SELECT * FROM profiles WHERE agent_id = ?").get(id);

    if (options.expired && quota.expiresAt && new Date(quota.expiresAt).getTime() < now) {
      candidates.push({ id, reason: `过期于 ${quota.expiresAt}` });
    }
    if (options.inactiveDays && profile?.last_seen) {
      const daysSince = (now - new Date(profile.last_seen).getTime()) / 86400000;
      if (daysSince > options.inactiveDays) {
        candidates.push({ id, reason: `不活跃 ${Math.floor(daysSince)} 天` });
      }
    }
  }

  if (candidates.length === 0) {
    return { text: "✅ 没有需要清理的租户" };
  }

  if (options.dryRun) {
    const list = candidates.map(c => `  • ${c.id}: ${c.reason}`).join("\n");
    return { text: `🔍 预览（不执行删除）:\n${list}` };
  }

  let success = 0, failed = 0;
  for (const c of candidates) {
    const result = await handleDelete(api, c.id);
    if (result.text.startsWith("✅")) success++; else failed++;
  }

  return { text: `🧹 清理完成: ${success} 成功, ${failed} 失败` };
}
```

---

## 5. 开发里程碑

| 阶段 | 内容 | 依赖 |
|------|------|------|
| **M1** | 文档更新（本文档） | ✅ 完成 |
| **M2** | 配额执行核心（SQLite + 3 个 Hook） | — |
| **M5** | Owner 通知队列（与 M2 耦合，紧跟开发） | M2 |
| **M3** | `/tenant` 管理命令 + 配置验证 | M2 |
| **M4** | 租户画像 + 关键词提取 | M2 |
| **M6** | 集成测试 + 部署 | ALL |

---

## 6. 租户 Agent 配置模板

`/tenant create` 命令格式：

```
/tenant create <id> --channel <channel> [--peer <peerId>] [--account <accountId>] [--model <provider/model>]
```

**Owner 可通过 `--model` 参数指定租户使用的模型**，不指定则继承 `agents.defaults.model`。

示例：

```bash
# 使用便宜快速模型
/tenant create demo-bot --channel openclaw-weixin --model bailian/qwen3.5-plus

# 使用本地模型（零成本）
/tenant create free-bot --channel telegram --peer 99999999 --model ollama/llama3.3

# 不指定，继承默认模型
/tenant create vip-bot --channel telegram --peer 88888888
```

写入 `openclaw.json` 的 agent 配置：

```jsonc
// agents.list 新增项
{
  "id": "{tenantId}",
  "model": {                              // 仅当指定 --model 时
    "primary": "{provider/model}",
    "fallbacks": []                        // 可扩展
  },
  "workspace": { "dir": "~/.openclaw/workspaces/{tenantId}" },
  "tools": {
    "profile": "minimal",
    "allow": ["read", "web_search", "image", "memory_search", "memory_get"],
    "deny": ["exec", "write", "edit", "session_status"]
  }
}

// agents.bindings 新增项
{
  "agentId": "{tenantId}",
  "channel": "{channel}",
  "accountId": "{accountId}",  // 可选
  "match": { "peer.id": "{peerId}" }  // 可选
}

// agents.defaults.maxConcurrent 自动调整为 租户数 + 2
```

---

## 7. 验证环境（Docker）

使用已部署的 Docker OpenClaw 实例进行验证：

| 实例 | 容器名 | 端口 | 配置目录（宿主机） |
|------|---------|------|------------------|
| 1 | openclaw_1 | 28789 | `/Users/long/Documents/projects/dockers/config/` |
| 2 | openclaw_2 | 28790 | `/Users/long/Documents/projects/dockers/config_2/` |

### 7.1 插件安装

```bash
# 方式 A：从 npm 安装（发布后）
docker exec -it openclaw_1 openclaw plugins install tenant-guard@latest

# 方式 B：本地开发挂载（开发期）
# 修改 docker-compose.yml 添加 volume：
#   - /Users/long/Documents/projects/tenant-guard:/home/node/.openclaw/extensions/tenant-guard
# 然后在 openclaw.json 中添加 plugins 配置：
#   "plugins": { "allow": ["tenant-guard"], "entries": { "tenant-guard": { "enabled": true } } }
docker restart openclaw_1
```

### 7.2 验证流程

```bash
# 1. 安装插件并重启
docker restart openclaw_1

# 2. 查看插件是否加载
docker exec openclaw_1 openclaw plugins list

# 3. 通过 Control UI 测试 /tenant 命令
# 访问 http://127.0.0.1:28789/#token=60451f988b545bbe5fab48e67027b17a3284bda8198dc590
# 发送: /tenant create test-bot --channel openclaw-weixin --model bailian/qwen3.5-plus

# 4. 检查配置是否更新
cat /Users/long/Documents/projects/dockers/config/openclaw.json | grep test-bot

# 5. 重启生效
docker restart openclaw_1

# 6. 查看日志确认租户 agent 加载
docker logs openclaw_1 2>&1 | tail -50

# 7. 从微信发消息测试租户配额拦截
# （设置极低 maxTokens，观察第 2 条消息是否被拦截）
```

### 7.3 当前环境可用模型

基于 Docker 实例 1 的 `openclaw.json`，租户可使用的模型：

| 模型 | Provider | 建议用途 |
|------|----------|----------|
| `bailian/kimi-k2.5` | 百炼 DashScope | Owner / VIP 租户 |
| `bailian/qwen3.5-plus` | 百炼 DashScope | **推荐租户默认** |
| `bailian/glm-5` | 百炼 DashScope | 备选 |
| `minimax/MiniMax-M2.7-highspeed` | MiniMax | 高速体验 |
| `bailian/qwen3-coder-plus` | 百炼 DashScope | 代码场景 |
