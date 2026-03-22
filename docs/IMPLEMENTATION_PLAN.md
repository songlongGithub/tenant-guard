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
