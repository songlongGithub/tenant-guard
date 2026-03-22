# 注意事项与已知坑

> 本文档记录实现过程中必须了解的约束、反直觉行为和历史踩坑。

---

## 一、Plugin Hook API 约束

### 1. `message_sending` / `message_received` 中没有 `agentId`

这两个 hook 的 context 只有 `{ channelId, accountId, conversationId }`，**拿不到 agentId**。

如果需要在这两个 hook 中判断是否为租户，必须从 `sessionKey` 解析：

```javascript
// sessionKey 格式: "agent:{agentId}:{channel}:{chatType}:{to}"
function extractAgentId(sessionKey) {
  if (!sessionKey) return null;
  const match = sessionKey.match(/^agent:([^:]+):/);
  return match?.[1] ?? null;
}
```

但 `message_sending` 的 event 也不含 `sessionKey`，只有 `{ to, content }`。**因此不要依赖这两个 hook 做租户身份判断**，改用 `before_prompt_build` 或 `before_tool_call`（这两个 hook 的 ctx 中有 `agentId`）。

### 2. `before_tool_call` 的 `block` 是软拦截

返回 `{ block: true, blockReason: "..." }` 后，OpenClaw 会将 blockReason 作为 tool 的错误结果注入 agent 上下文，agent 会继续运行并根据错误结果决定下一步。

这意味着：**agent 仍然会消耗一次 LLM token 来处理 block 反馈**，不是完全的硬中断。

对策：在 `before_prompt_build` 中同时注入"额度超限，直接回复用户，不要调用工具"的 system 上下文，双重保险。

### 3. `llm_output` 的 `usage` 字段可能为 null

某些模型/provider 不返回 usage（如部分 Ollama 模型）。代码中必须做空值防护：

```javascript
const tokens = (event.usage?.input ?? 0) + (event.usage?.output ?? 0);
// 如果 tokens === 0 且 provider 不是已知不返回 usage 的，记一次警告
```

### 4. `before_reset` hook 是否能阻止 bundled session-memory

`before_reset` 是 OpenClaw 内置 hook，bundled session-memory 也监听同一事件（`command:new` / `command:reset`）。

**不确定插件的 `before_reset` handler 是否能阻止 bundled hook 执行。**

测试方法见 TESTING.md §2.3。如果无法阻止，备选方案是：
- 给租户 agent 配置独立 workspace 目录（与 main 不同），session-memory 写入租户自己的 memory 目录，不污染全局记忆。

### 5. `session_end` 中无法直接读取 session 文件内容

`session_end` 的 event 只有 `{ sessionId, sessionKey, messageCount, durationMs }`，没有 sessionFile 路径。

需要自行拼接路径：

```javascript
// 路径规则（基于 OpenClaw 源码观察）
const agentDir = path.join(os.homedir(), ".openclaw", "agents", agentId);
const sessionFile = path.join(agentDir, "sessions", `${event.sessionId}.jsonl`);
```

路径格式可能随 OpenClaw 版本变化，需要在 `session_start` hook 时缓存 sessionFile 路径（从 sessions.json 读取），以 sessionId 为 key 备用。

---

## 二、OpenClaw 配置约束

### 6. 不支持配置热重载

`/tenant create` 和 `/tenant delete` 修改 `openclaw.json` 后，**必须重启 gateway 才能生效**。

提示语不能写"已生效"，必须写"需要重启 gateway 生效"：

```bash
openclaw gateway stop && openclaw gateway start
# 或
pkill -f "openclaw" && openclaw gateway start
```

### 7. `agents.bindings` 是全局字段，不在 `agents.list` 子项里

错误写法：
```jsonc
{ "agents": { "list": [{ "id": "tenant-a", "bindings": [...] }] } }
```

正确写法：
```jsonc
{ "agents": { "list": [...], "bindings": [...] } }
```

### 8. 受限 agent 的 tools 配置必须显式覆盖 defaults

`agents.defaults.tools.profile = "coding"` 会影响所有未覆盖的 agent。租户 agent 必须显式设置 `tools.profile: "minimal"` 加白名单，否则会继承 coding profile 的宽泛权限：

```jsonc
{
  "id": "tenant-a",
  "tools": {
    "profile": "minimal",
    "allow": ["read", "web_search", "image", "memory_search", "memory_get"],
    "deny": ["exec", "write", "edit", "session_status"]
  }
}
```

### 9. `memory_search` / `memory_get` 被 deny 后插件无法代理

如果在 agent tools 配置里 deny 了 `memory_search`，这两个 tool 就不会出现在 agent 的工具列表里，agent 根本不会调用它们，插件也就没有拦截机会。

**不要 deny memory 工具**，而是通过插件的 `before_tool_call` 拦截写操作，读操作放行。

---

## 三、SQLite 使用注意

### 10. 使用 `better-sqlite3`（同步），不用 `sqlite3`（异步）

OpenClaw Plugin 的 hook handler 混合了同步/异步场景。`better-sqlite3` 的同步 API 在 hook 中更安全，避免竞态条件：

```javascript
import Database from "better-sqlite3";
const db = new Database(dbPath);
// 所有操作同步，无 await
const row = db.prepare("SELECT * FROM usage WHERE agent_id = ?").get(agentId);
```

安装：
```bash
npm install better-sqlite3
```

### 11. WAL 模式必须开启（多进程安全）

OpenClaw 可能在多个进程中访问同一 SQLite 文件（如 gateway + CLI）：

```javascript
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
```

---

## 四、租户画像生成注意

### 12. LLM slug 生成使用 Owner 的 auth profile，不计入租户配额

`generateSlugViaLLM` 内部使用 OpenClaw 配置中的默认 LLM，默认情况下使用 main agent 的 auth profile。无需特殊处理，调用不计入当前 agentId（租户）的配额。

但如果 `session_end` hook 的 ctx 携带的是租户的 agentId，需要确认 LLM 调用使用的 profile 是全局默认而非租户绑定的。

### 13. `generateSlugViaLLM` 不在 Plugin SDK 公开 API 中

需要动态 import，路径在 `openclaw/dist/bundled/session-memory/handler.js`。该路径在 OpenClaw 版本更新后可能变化。

保险做法：提供一个简单的关键词提取 fallback，`generateSlugViaLLM` 失败时使用关键词拼接：

```javascript
async function generateTopicSlug(messages) {
  try {
    return await generateSlugViaLLM(messages);
  } catch {
    // fallback: 取第一条用户消息的前 20 字
    const first = messages.find(m => m.role === "user");
    return first?.content?.slice(0, 20).replace(/\s+/g, "-") ?? "unknown";
  }
}
```

---

## 五、进度报告插件（progress-reporter）兼容性

### 14. tenant-guard 与 progress-reporter 共享 `after_tool_call` hook

两个插件都监听 `after_tool_call`。执行顺序由 `priority` 决定（默认 0，数字越小越先执行）。

建议 tenant-guard 的 `before_tool_call` 和 `after_tool_call` 优先级设为高于 progress-reporter（如 `priority: -10`），确保配额拦截在进度上报之前发生。

---

## 六、版本记录

| 日期 | 变更 |
|------|------|
| 2026-03-22 | 初始版本，记录设计阶段发现的约束 |
