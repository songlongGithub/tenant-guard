# tenant-guard 需求规格文档

> 版本：v1.1-final（实施完成）
> 日期：2026-03-22（初稿） → 2026-03-23（完成）
> 作者：Long

---

## 1. 背景与目标

OpenClaw 是一个私有 AI Agent 网关，当前仅供 Owner 自用。随着需要向外部用户（租户）开放体验，需要在不修改 OpenClaw 核心的前提下，通过插件机制实现：

1. 多租户接入与隔离
2. 资源配额管控
3. 记忆权限分层
4. 租户画像积累

---

## 2. 角色定义

### 2.1 Owner（管理员）

判定条件：`agentId` 在 `ownerAgents` 列表中（默认包含 `"main"`），且来自 OpenClaw 配置中 `channel.allowFrom` 列表的发送方。

> **多端管理**：Owner 可添加额外的 bot 为管理员，方便从手机（微信等）执行 `/tenant` 命令。

权限：
- 全部工具无限制
- 全局记忆读写
- 执行所有管理命令（`/tenant`）
- 查看 API Key、系统信息、配置
- **管理其他 Owner bot**（`/tenant owner add/remove`）

##### Owner 身份判定逻辑

```javascript
function isOwner(ctx) {
  const ownerAgents = loadTenantsSync(tenantsPath).ownerAgents || ["main"];
  return ownerAgents.includes(ctx.agentId);
}
```

### 2.2 Tenant（租户 Bot）

判定条件：`agentId !== "main"`，且在 `tenants.json` 中有对应配置。

权限（均可由 Owner 自定义）：
- 工具默认：`read`、`web_search`、`image`、`memory_search`（只读）、`memory_get`（只读）
- 默认禁止：`exec`、`write`、`edit`、`session_status` 及所有 shell/管理操作
- **Owner 可通过 `--tools` 自定义工具集**，也可创建后通过 `/tenant config` 修改
- 全局记忆默认只读（可配置关闭）
- 受配额约束（tokens / calls / 时间）
- 受超限策略约束（拒绝 或 降速）
- 受回复语言约束（可配置）

---

## 3. 功能需求

### 3.1 租户生命周期管理

#### 3.1.1 创建租户

命令：`/tenant create <tenantId> --channel <channel> [options]`

完整 options：

| 参数 | 说明 | 示例 |
|------|------|------|
| `--channel` | Channel 标识符（必填） | `qqbot` / `telegram` / `discord` |
| `--account` | 多账号 Channel 的 accountId | `bot1` |
| `--peer` | 精确匹配用户/群 ID | `12345678` |
| `--peer-kind` | peer 类型 | `direct`（默认）/ `group` / `channel` |
| `--guild` | Discord 服务器 ID | `99887766` |
| `--team` | Slack 工作空间 ID | `T01ABCDEF` |
| `--roles` | Discord 角色 IDs（逗号分隔）| `admin,vip` |
| `--name` | 租户显示名称 | `"体验用户A"` |
| `--model` | 租户使用的 LLM 模型（可选） | `bailian/qwen3.5-plus` |
| `--tools` | 允许的工具列表（可选，逗号分隔） | `read,web_search,image` |
| `--language` | 回复语言约束（可选） | `zh` / `en` / `auto` |
| `--over-limit` | 超限行为（可选） | `reject`（默认）/ `downgrade` |
| `--downgrade-model` | 降速时切换的模型 | `bailian/qwen3.5-plus` |
| `--system-prompt` | 系统提示词（可选，支持模板） | `"你是客服助手"` |

> **v1.1 新增**：Owner 可通过以上参数自定义租户能力，所有可选参数均有默认值。

##### Agent 创建规则

| 规则 | 说明 |
|------|------|
| ID 命名 | 仅允许小写字母、数字、连字符，3-32 字符，正则：`/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/` |
| 保留 ID | `main`、`system`、`cron`、`heartbeat`、`probe` 不可用作租户名 |
| 唯一性 | 同一 gateway 内 agentId 不可重复 |
| Model 引用 | `--model` 指定的 `provider/modelId` 必须在当前 `openclaw.json` 的 models.providers 中已注册 |
| Binding 唯一 | 同一 channel + accountId + peer 组合不可绑定到多个 agent |
| Workspace | 自动创建独立目录 `~/.openclaw/workspaces/{tenantId}`，不与 main 共享 |
| Tools 约束 | 固定 profile `minimal`，deny 列表包含 `exec`/`write`/`edit`/`session_status` |
| 最大租户数 | v1 限制 20 个（防止 openclaw.json 过大和 maxConcurrent 过高） |

##### 执行流程

1. 检查 `isAuthorizedSender`，否则拒绝
2. 验证 tenantId 格式和唯一性
3. 验证 `--model` 引用有效性（provider 和 model 均存在）
4. 验证 binding 不冲突
5. 向 `openclaw.json` 的 `agents.list` 添加受限 agent 配置（含独立 model 和 workspace）
6. 向 `openclaw.json` 的 `agents.bindings` 添加路由规则
7. 自动调整 `agents.defaults.maxConcurrent`（租户数 + 2）
8. 写入后验证：重新加载配置，确认 agent 和 binding 已生效
9. 向 `tenants.json` 写入默认配额
10. SQLite 插入 usage 初始行
11. 初始化 `data/profiles/{tenantId}/` 目录
12. 提示 Owner 重启 gateway 生效

#### 3.1.2 删除租户

命令：`/tenant delete <tenantId>`

执行流程：
1. 权限检查
2. 确认 tenantId 存在且不是 `main`
3. 从 `openclaw.json` 移除 agent + 所有相关 binding
4. 写入后验证：重新加载配置，确认 agent 已移除
5. 从 `tenants.json` 移除配额配置
6. 从 SQLite 删除 usage 行
7. 保留 `data/profiles/{tenantId}/` 历史数据（不删除，供分析）
8. 提示重启生效

#### 3.1.3 租户回收规则

对过期或不活跃租户的自动/手动回收机制：

##### 自动标记（每次 hook 触发时检查）

| 条件 | 状态标记 | 行为 |
|------|---------|------|
| `expiresAt` 已过期 | `expired` | `before_prompt_build` 注入过期提示，`before_tool_call` 拦截所有调用 |
| Token 和 Calls 均超限 | `exhausted` | 同上 |
| 距离 `last_seen` 超过配置天数 | `inactive` | 仅标记，不自动拦截 |

> 自动标记**不会自动删除** agent 或修改 `openclaw.json`，仅在运行时拦截。

##### 手动回收

```
/tenant cleanup [--expired] [--inactive-days <N>] [--dry-run]
```

| 参数 | 说明 |
|------|------|
| `--expired` | 清理所有已过期租户 |
| `--inactive-days <N>` | 清理最后活跃超过 N 天的租户（默认 90 天） |
| `--dry-run` | 仅预览，不执行删除 |

执行流程：
1. 列出符合条件的租户
2. `--dry-run` 时仅输出列表后返回
3. 逐个执行删除流程（同 3.1.2），每个都独立验证
4. 汇总报告：成功数 / 失败数 / 跳过数

##### Workspace 清理

`/tenant delete` 默认**不删除** workspace 目录（保留聊天记录和 session-memory）。

```
/tenant purge <tenantId>
```

完全清除：删除 agent + binding + 配额 + usage + profile + workspace 目录。
**不可恢复**，执行前要求 Owner 二次确认（输入 tenantId 确认）。

#### 3.1.4 列出租户

命令：`/tenant list`

输出示例：
```
租户列表（共 3 个）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
tenant-a  qqbot:bot1       tokens: 12000/500000  calls: 8/200   ✅ 活跃
tenant-b  telegram:123456  tokens: 498000/500000 calls: 195/200 ⚠️ 即将超限
tenant-c  discord:guild99  tokens: 501000/500000 calls: 201/200 🚫 已超限
```

#### 3.1.5 修改租户配置

命令：`/tenant config <tenantId> [options]`

Owner 可在创建后随时修改租户配置：

| 参数 | 说明 | 示例 |
|------|------|------|
| `--model <m>` | 切换模型 | `--model bailian/kimi-k2.5` |
| `--tools <list>` | 修改工具列表 | `--tools read,web_search,code` |
| `--language <lang>` | 修改回复语言 | `--language en` |
| `--over-limit <mode>` | 修改超限行为 | `--over-limit downgrade` |
| `--downgrade-model <m>` | 修改降速模型 | `--downgrade-model bailian/qwen3.5-plus` |
| `--system-prompt <text>` | 修改系统提示词 | `--system-prompt "新提示"` |
| `--memory-read on\|off` | 全局记忆只读 | `--memory-read off` |

修改 `tenants.json` 中的配置，不修改 `openclaw.json`，无需重启。

#### 3.1.6 Owner Bot 管理

Owner 可添加额外的 agent 为管理员，方便从手机操作：

```
/tenant owner add <agentId>       ← 添加管理员 bot
/tenant owner remove <agentId>    ← 移除管理员 bot（不能移除 main）
/tenant owner list                ← 列出所有管理员 bot
```

**使用场景：**

1. Owner 在电脑上通过 Control UI 创建一个 `admin-wx` agent，绑定到自己的微信
2. 执行 `/tenant owner add admin-wx`
3. 之后在手机微信上直接发 `/tenant list`、`/tenant create` 等命令

**安全约束：**
- `ownerAgents` 列表存储在 `tenants.json` 中，不存 `openclaw.json`
- `main` 永远不能被移除
- 只有已在 `ownerAgents` 列表中的 agent 才能执行 `/tenant owner add`
- 添加的 agentId 必须已存在于 `openclaw.json` 的 `agents.list` 中

### 3.2 配额管理

#### 3.2.1 配额维度

| 维度 | 字段 | 说明 |
|------|------|------|
| Token 上限 | `maxTokens` | input + output tokens 累计 |
| 调用次数 | `maxCalls` | LLM API 调用次数（非消息数）|
| 到期时间 | `expiresAt` | ISO 8601，精确到分钟 |
| 重置周期 | `resetInterval` | `"daily"`（24h 滑动窗口）/ `"none"` |

#### 3.2.2 重置逻辑

24 小时滑动窗口，精确到毫秒：

```
重置触发条件：now() - last_reset >= 24 * 60 * 60 * 1000
重置内容：tokens = 0，calls = 0，notified = false
重置时机：每次查询 usage 时懒检查（无需 cron）
```

命令：`/tenant quota <tenantId> [options]`

| 参数 | 说明 |
|------|------|
| `--tokens <n>` | 设置 token 上限 |
| `--calls <n>` | 设置调用次数上限 |
| `--expires <ISO>` | 设置过期时间 |
| `--reset` | 立即手动重置用量计数 |
| `--reset-interval daily\|none` | 设置自动重置周期 |

#### 3.2.3 配额文件格式（tenants.json）

```jsonc
{
  "ownerAgents": ["main"],  // 具有管理权限的 agent 列表，可添加多个
  "defaults": {
    "quota": {
      "maxTokens": 100000,
      "maxCalls": 50,
      "expiresAt": null,
      "resetInterval": "daily"
    },
    "tools": {
      "allow": ["read", "web_search", "image", "memory_search", "memory_get"],
      "deny": ["exec", "write", "edit", "session_status"]
    },
    "memory": {
      "globalRead": true,
      "globalWrite": false
    },
    "overLimit": {
      "action": "reject",         // "reject" | "downgrade"
      "downgradeModel": null      // 降速时切换的模型
    },
    "language": "auto",            // "auto" | "zh" | "en" | "ja" 等
    "systemPrompt": null           // 默认无自定义提示词，使用模板
  },
  "systemPromptTemplate": "你是 {name}，一个 AI 助手。\n{language_hint}\n体验额度：{maxTokens} tokens / {maxCalls} 次调用。",
  "tenants": {
    "tenant-a": {
      "label": "体验用户A",
      "quota": {
        "maxTokens": 500000,
        "maxCalls": 200,
        "expiresAt": "2026-04-01T00:00:00+08:00",
        "resetInterval": "daily"
      },
      "tools": {
        "allow": ["read", "web_search", "image", "code"],  // 自定义
        "deny": ["exec", "write", "edit"]
      },
      "memory": {
        "globalRead": true,
        "globalWrite": false
      },
      "overLimit": {
        "action": "downgrade",
        "downgradeModel": "bailian/qwen3.5-plus"
      },
      "language": "zh",
      "systemPrompt": "你是一个客服助手，只回答产品相关问题"
    }
  }
}
```

### 3.3 超额提示与超限策略

#### 3.3.1 租户侧提示（三层）

| 层级 | Hook | 触发时机 | 呈现方式 |
|------|------|---------|---------|
| 预警 | `before_prompt_build` | 用量 ≥ 80% | Agent 回复末尾追加提醒 |
| 拦截/降速 | `before_tool_call` | 用量 ≥ 100% | 根据 `overLimit.action` 决定 |
| 超时 | `before_prompt_build` | `expiresAt` 已过期 | Agent 直接告知无法服务 |

#### 3.3.2 超限行为（overLimit）

Owner 可为每个租户指定超限后的行为：

| 模式 | 说明 |
|------|------|
| `reject`（默认） | 超限后 `before_tool_call` 返回 `{ block: true }`，拒绝所有工具调用 |
| `downgrade` | 超限后切换到更便宜的模型，继续服务但质量降低 |

**`downgrade` 模式实现：**

```javascript
// before_prompt_build 中检查超限
if (overLimit.action === "downgrade" && isOverLimit(usage, quota)) {
  // 动态切换 agent 的 session model
  // 通过 prependContext 告知 agent 已降速
  return {
    prependContext: `⚠️ 额度已用完，已切换到快速模式，回复质量可能降低。`
  };
}
```

配置示例：
```jsonc
{
  "overLimit": {
    "action": "downgrade",
    "downgradeModel": "bailian/qwen3.5-plus"  // 降速时使用的便宜模型
  }
}
```

预警消息模板：
```
⚠️ 提示：你的额度已使用 {ratio}%（{tokens}/{maxTokens} tokens，{calls}/{maxCalls} 次调用），还剩约 {remaining} 重置。
```

超限消息模板（reject 模式）：
```
🚫 你的体验额度已用完（{tokens}/{maxTokens} tokens，{calls}/{maxCalls} 次调用）。
下次重置时间：{resetTime}（约 {remaining}）。
如需继续使用，请联系管理员续期。
```

降速消息模板（downgrade 模式）：
```
⚠️ 你的快速额度已用完，已切换到快速模式。回复速度更快但质量可能略有下降。
```
```

#### 3.3.2 Owner 侧通知（通知队列）

通知队列文件：`data/notifications.jsonl`

写入时机：
- `llm_output` hook 中检测到用量首次越过 100%（`notified` flag 防重复）
- `expiresAt` 检查时首次发现过期

Owner 提醒时机：Owner 主对话的下一次 `before_prompt_build`

消息格式：
```
[租户管理通知 - {count} 条]
⚠️ tenant-a: Token 额度用尽（500123/500000），23h 12m 后自动重置
⏰ tenant-b: 授权已于 2026-03-21 00:00 过期
使用 /tenant quota <id> 更新配额。
```

读取后清空通知队列（drain 操作）。

#### 3.3.4 系统提示词与语言配置

##### 系统提示词模板

`tenants.json` 中定义全局模板和租户自定义提示词：

```jsonc
{
  "systemPromptTemplate": "你是 {name}，一个 AI 助手。\n{language_hint}\n体验额度：{maxTokens} tokens / {maxCalls} 次调用。",
  "tenants": {
    "tenant-a": {
      "systemPrompt": "你是一个客服助手，只回答产品相关问题"  // 覆盖模板
    }
  }
}
```

**模板变量：**

| 变量 | 说明 | 示例值 |
|------|------|--------|
| `{name}` | 租户显示名称（`label` 或 `tenantId`）| `体验用户A` |
| `{language_hint}` | 语言约束提示（根据 `language` 字段生成）| `请使用中文回复。` |
| `{maxTokens}` | Token 上限 | `500000` |
| `{maxCalls}` | 调用次数上限 | `200` |
| `{expiresAt}` | 过期时间 | `2026-04-01` |

**应用时机：** `before_prompt_build` hook 中，以 `prependContext` 注入。

##### 首次使用自动提示

租户首次发消息时（`profiles.session_count === 0`），自动在回复前注入欢迎提示：

```
👋 你好！我是 {name}。
📊 体验额度：{maxTokens} tokens / {maxCalls} 次调用
⏰ 有效期至：{expiresAt}
💡 支持的能力：{tools_list}

有任何问题都可以问我！
```

##### 语言约束

`language` 字段控制 Agent 的回复语言，通过系统提示词实现：

| 值 | 注入内容 |
|----|---------|
| `auto` | 无额外约束，Agent 自动匹配用户语言 |
| `zh` | `请始终使用中文回复用户。` |
| `en` | `Please always reply in English.` |
| `ja` | `常に日本語で返信してください。` |
| 其他 | `请使用{language}回复用户。` |

### 3.4 记忆隔离

#### 3.4.1 权限矩阵

| 操作 | main | tenant |
|------|------|--------|
| 读全局 MEMORY.md | ✅ | ✅（via memory_search / memory_get）|
| 写全局 MEMORY.md | ✅ | ❌（before_tool_call 拦截 write/edit）|
| session-memory hook（/new / /reset） | ✅ 写 workspace/memory/ | 写入租户独立 workspace/memory/（不影响全局）|
| 读租户自身历史画像 | ✅ | ❌（存储在插件 data/ 下，不在 workspace/）|
| 跨租户读取 | ✅ | ❌（agentId 隔离）|

#### 3.4.2 实现机制

> **设计变更**（v1.1）：经源码验证，`before_reset` 是 void hook（fire-and-forget IIFE），
> 无法阻止 bundled session-memory 写入。改用**独立 workspace 目录**方案。

**方案：每个租户 agent 配置独立 workspace 目录**

```jsonc
// openclaw.json 中租户 agent 配置
{ "id": "tenant-a", "workspace": { "dir": "~/.openclaw/workspaces/tenant-a" } }
```

session-memory hook 写入的是租户自己的 `workspace/memory/`，与全局记忆完全隔离。

写入拦截点：
- `before_tool_call`：拦截 `write` / `edit` → 返回 `{ block: true, blockReason: "无写入权限" }`

### 3.5 租户画像

#### 3.5.1 存储结构

```
data/profiles/{tenantId}/
├── profile.json           # 聚合画像
└── sessions-digest.jsonl  # 逐条会话摘要
```

#### 3.5.2 profile.json 格式

```jsonc
{
  "agentId": "tenant-a",
  "label": "体验用户A",
  "channel": "qqbot",
  "accountId": "bot1",
  "firstSeen": "2026-03-22T10:00:00+08:00",
  "lastSeen": "2026-03-22T18:30:00+08:00",
  "sessionCount": 12,
  "totalTokens": 312000,
  "totalCalls": 156,
  "topTopics": [
    { "topic": "代码生成", "count": 8 },
    { "topic": "文档翻译", "count": 3 }
  ],
  "preferredLanguage": "zh-CN",
  "avgSessionTokens": 26000,
  "avgSessionDurationMs": 720000
}
```

#### 3.5.3 sessions-digest.jsonl 格式

每条一行 JSON：

```jsonc
{
  "sessionId": "abc123",
  "endedAt": "2026-03-22T18:30:00+08:00",
  "turns": 8,
  "tokens": 12000,
  "calls": 6,
  "durationMs": 480000,
  "tools": ["web_search", "read"],
  "keywords": ["Python", "爬虫", "requests"]
}
```

> **设计变更**（v1.1）：移除 `slug` 字段，关键词通过简单的频率统计提取（v1，不依赖 LLM）。
> v2 可选通过 `runtime.subagent.run()` 调用 LLM 生成更精准的 topic。

#### 3.5.4 画像生成触发点

> **设计变更**（v1.1）：改用 `before_reset` hook（而非 `session_end`）。
> `before_reset` 的 event 直接提供 `messages` 数组，无需手动拼 sessionFile 路径。

```javascript
api.on("before_reset", (event, ctx) => {
  if (ctx.agentId === "main") return;
  const messages = event.messages || [];
  const keywords = extractTopics(messages);  // 简单关键词提取
  appendDigest(ctx.agentId, { keywords, ... });
});
```

#### 3.5.4 查看命令

```
/tenant profile <tenantId>    # 查看聚合画像 + 最近 5 条会话摘要
/tenant sessions <tenantId>   # 查看所有会话摘要列表
/tenant usage <tenantId>      # 查看当前用量 vs 配额
```

---

## 4. 非功能需求

### 4.1 性能

- SQLite 操作全部同步（`better-sqlite3`），避免 async 死锁风险
- `tenants.json` 懒加载 + 5 秒文件修改时间缓存，热加载无需重启
- 通知队列读写使用 append-only JSONL，避免大文件重写

### 4.2 安全

- `/tenant` 命令严格检查 `isAuthorizedSender`，非 Owner 调用直接拒绝
- `before_tool_call` 双重拦截（tool deny 配置 + 插件运行时检查）
- `agentId` 从 OpenClaw runtime 上下文取得，不信任用户输入

### 4.3 可观测性

- 所有关键操作输出结构化日志：`[INFO][tenant-guard:quota] Agent tenant-a exceeded token limit (500123/500000)`
- 日志格式：`[Level][Module:Method] Message`

### 4.4 配置文件安全

- `tenants.json` 中不存储任何 API Key 或密钥
- 租户配额变更记录到 `data/quota_events` 表，可审计

---

## 5. openclaw.json 编辑安全

`openclaw.json` 是 gateway 的核心配置文件，写坏可能导致 gateway 无法启动。所有配置修改必须遵循以下流程：

### 5.1 写入前验证（业务层）

`writeConfigFile` 内部有 Zod schema 校验（格式层），但插件需额外做业务层验证：

| 验证项 | 检查内容 | 失败行为 |
|--------|---------|----------|
| Agent ID 唯一 | `agents.list` 中无重复 ID | 返回错误，不写入 |
| 保留 ID | 不使用 `main`/`system`/`cron`/`heartbeat`/`probe` | 返回错误 |
| ID 格式 | 匹配 `/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/` | 返回错误 |
| Model 引用 | `provider` 在 `models.providers` 中存在，`modelId` 在该 provider 的 models 列表中 | 返回错误 |
| Binding 冲突 | 同一 channel+account+peer 不重复绑定 | 返回错误 |
| 租户上限 | 不超过 20 个 | 返回错误 |
| 配置完整性 | `agents`/`agents.list`/`agents.bindings` 结构存在 | 自动初始化 |

### 5.2 写入后验证

每次 `writeConfigFile` 成功后立即执行：

1. `loadConfig()` 重新加载配置
2. 确认目标 agent 出现/消失在 `agents.list` 中
3. 确认目标 binding 出现/消失在 `agents.bindings` 中
4. 验证不通过则记录警告日志（不回滚，因为 Zod 已通过）

### 5.3 错误恢复

`writeConfigFile` 内置安全机制：
- 写入前自动创建 `.bak` 备份（最多保留 5 个）
- 原子写入（先写 `.tmp` 再 `rename`）
- Zod 校验不通过直接 `throw`，不写入

插件层额外保证：
- 所有验证失败在 `writeConfigFile` 调用**之前**返回错误
- 捕获 `writeConfigFile` 的异常并返回友好错误信息
- 错误信息中包含 `.bak` 路径提示，方便手动恢复

---

## 6. 技术约束

- OpenClaw 当前**不支持配置热重载**，`/tenant create` / `/tenant delete` 需重启 gateway 生效
- Plugin Hook `message_sending` / `message_received` 中无 `agentId`，需从 `sessionKey` 解析（格式：`agent:{agentId}:...`）
- ~~LLM 生成 slug 使用 `generateSlugViaLLM`~~ → v1 使用简单关键词提取，v2 可用 `runtime.subagent.run()`
- ~~`before_reset` hook 是否能阻止 bundled session-memory hook 触发~~ → **已验证：不能**。改用独立 workspace 方案
- `writeConfigFile` API 支持增量 merge patch（RFC 7386），可安全用于 `/tenant create`
- 默认 `maxConcurrent = 1`（全局串行），多租户需调大
- `agents.list` 在 merge patch 中是全量替换（非元素级），但 `/tenant create` 不会并发，安全

---

## 6. 里程碑

| 阶段 | 内容 | 状态 | 备注 |
|------|------|------|------|
| M1 | 设计文档 + 项目结构 | ✅ 完成 | v1.1 已修订 |
| M2 | 配额执行核心（SQLite + Hook）| 待开发 | 核心模块 |
| M5 | Owner 通知队列 | 待开发 | 与 M2 耦合，紧跟开发 |
| M3 | `/tenant` 管理命令 | 待开发 | 依赖 M2 |
| M4 | 租户画像 + 关键词提取 | 待开发 | 简单关键词 v1 |
| M6 | 集成测试 + 生产部署 | 待开发 | |
