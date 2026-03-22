# tenant-guard 需求规格文档

> 版本：v1.1（基于 Plugin SDK 源码验证修订）
> 日期：2026-03-22
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

### 2.1 Owner（主对话）

判定条件：`agentId === "main"` 且来自 OpenClaw 配置中 `channel.allowFrom` 列表的发送方。

权限：
- 全部工具无限制
- 全局记忆读写
- 执行所有管理命令（`/tenant`）
- 查看 API Key、系统信息、配置

### 2.2 Tenant（租户 Bot）

判定条件：`agentId !== "main"`，且在 `tenants.json` 中有对应配置。

权限：
- 工具仅限：`read`、`web_search`、`image`、`memory_search`（只读）、`memory_get`（只读）
- 明确禁止：`exec`、`write`、`edit`、`session_status` 及所有 shell/管理操作
- 全局记忆只读（不可触发 session-memory hook 写入）
- 受配额约束（tokens / calls / 时间）

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

> **v1.1 新增**：Owner 可通过 `--model` 为租户指定独立模型，不指定则继承 `agents.defaults.model`。

执行流程：
1. 检查 `isAuthorizedSender`，否则拒绝
2. 检查 `tenantId` 不重复
3. 向 `openclaw.json` 的 `agents.list` 添加受限 agent 配置（含独立 model 和 workspace）
4. 向 `openclaw.json` 的 `agents.bindings` 添加路由规则
5. 自动调整 `agents.defaults.maxConcurrent`（租户数 + 2）
6. 向 `tenants.json` 写入默认配额
7. 初始化 `data/profiles/{tenantId}/` 目录
8. 提示 Owner 重启 gateway 生效

#### 3.1.2 删除租户

命令：`/tenant delete <tenantId>`

执行流程：
1. 权限检查
2. 从 `openclaw.json` 移除 agent + binding
3. 从 `tenants.json` 移除配额配置
4. 保留 `data/profiles/{tenantId}/` 历史数据（不删除，供分析）
5. 提示重启生效

#### 3.1.3 列出租户

命令：`/tenant list`

输出示例：
```
租户列表（共 3 个）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
tenant-a  qqbot:bot1       tokens: 12000/500000  calls: 8/200   ✅ 活跃
tenant-b  telegram:123456  tokens: 498000/500000 calls: 195/200 ⚠️ 即将超限
tenant-c  discord:guild99  tokens: 501000/500000 calls: 201/200 🚫 已超限
```

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
  "defaults": {
    "quota": {
      "maxTokens": 100000,
      "maxCalls": 50,
      "expiresAt": null,
      "resetInterval": "daily"
    },
    "memory": {
      "globalRead": true,
      "globalWrite": false
    }
  },
  "tenants": {
    "tenant-a": {
      "label": "体验用户A",
      "quota": {
        "maxTokens": 500000,
        "maxCalls": 200,
        "expiresAt": "2026-04-01T00:00:00+08:00",
        "resetInterval": "daily"
      },
      "memory": {
        "globalRead": true,
        "globalWrite": false
      }
    }
  }
}
```

### 3.3 超额提示机制

#### 3.3.1 租户侧提示（三层）

| 层级 | Hook | 触发时机 | 呈现方式 |
|------|------|---------|---------|
| 预警 | `before_prompt_build` | 用量 ≥ 80% | Agent 回复末尾追加提醒 |
| 拦截 | `before_tool_call` | 用量 ≥ 100% 时所有 tool 调用 | `blockReason` 告知 agent，agent 转述用户 |
| 超时 | `before_prompt_build` | `expiresAt` 已过期 | Agent 直接告知无法服务 |

预警消息模板：
```
⚠️ 提示：你的额度已使用 {ratio}%（{tokens}/{maxTokens} tokens，{calls}/{maxCalls} 次调用），还剩约 {remaining} 重置。
```

超限消息模板：
```
🚫 你的体验额度已用完（{tokens}/{maxTokens} tokens，{calls}/{maxCalls} 次调用）。
下次重置时间：{resetTime}（约 {remaining}）。
如需继续使用，请联系管理员续期。
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

## 5. 技术约束

- OpenClaw 当前**不支持配置热重载**，`/tenant create` / `/tenant delete` 需重启 gateway 生效
- Plugin Hook `message_sending` / `message_received` 中无 `agentId`，需从 `sessionKey` 解析（格式：`agent:{agentId}:...`）
- ~~LLM 生成 slug 使用 `generateSlugViaLLM`~~ → v1 使用简单关键词提取，v2 可用 `runtime.subagent.run()`
- ~~`before_reset` hook 是否能阻止 bundled session-memory hook 触发~~ → **已验证：不能**。改用独立 workspace 方案
- `writeConfigFile` API 支持增量 merge patch（RFC 7386），可安全用于 `/tenant create`
- 默认 `maxConcurrent = 1`（全局串行），多租户需调大

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
