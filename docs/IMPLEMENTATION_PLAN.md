# tenant-guard 实施方案

> 版本：v1.0
> 日期：2026-03-22
> 基于 OpenClaw Plugin SDK v2 源码验证

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

## 5. 开发里程碑

| 阶段 | 内容 | 依赖 |
|------|------|------|
| **M1** | 文档更新（本文档） | ✅ 完成 |
| **M2** | 配额执行核心（SQLite + 3 个 Hook） | — |
| **M5** | Owner 通知队列（与 M2 耦合，紧跟开发） | M2 |
| **M3** | `/tenant` 管理命令 | M2 |
| **M4** | 租户画像 + 关键词提取 | M2 |
| **M6** | 集成测试 + 部署 | ALL |

---

## 6. 租户 Agent 配置模板

`/tenant create` 时自动写入 `openclaw.json`：

```jsonc
// agents.list 新增项
{
  "id": "{tenantId}",
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
