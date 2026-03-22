# 测试方法

> 本文档描述 tenant-guard 插件的完整测试策略，涵盖单元测试、集成测试和手动验证场景。

---

## 一、测试环境准备

### 1.1 前置条件

```bash
# 1. 确认 OpenClaw gateway 已启动
openclaw gateway status

# 2. 确认 tenant-guard 插件已加载
# 查看 gateway 启动日志中是否有：
# [plugins] [tenant-guard] Plugin loaded

# 3. 准备测试租户（创建后需重启 gateway）
# 在主 session 中执行：
/tenant create test-bot --channel telegram --peer 99999999 --name "测试租户"
/tenant quota test-bot --tokens 10000 --calls 10
```

### 1.2 本地开发调试方式

```bash
# 直接修改插件源码后，重启 gateway 加载新代码
cd ~/.openclaw
# 停止 gateway（根据你的启动方式）
pkill -f "openclaw"
# 重启，观察插件加载日志
openclaw gateway start 2>&1 | grep -i "tenant\|plugin\|error"
```

---

## 二、核心功能测试

### 2.1 配额执行测试

#### 测试 A：Token 超限拦截

**准备**：将 `test-bot` 的 `maxTokens` 设为 100（极低值以便快速触发）

```bash
# 在 tenants.json 中临时修改
"test-bot": { "quota": { "maxTokens": 100, "maxCalls": 999, "resetInterval": "daily" } }
```

**步骤**：
1. 以 test-bot 身份发送任意消息（触发 LLM 调用，消耗 token）
2. 再发一条消息

**预期结果**：
- 第 2 条消息时，agent 回复应包含超限提示，不能调用任何工具
- gateway 日志中应出现：`[INFO][tenant-guard:quota] Agent test-bot token limit hit`

**验证方式**：

```bash
sqlite3 ~/.openclaw/extensions/tenant-guard/usage.sqlite \
  "SELECT agent_id, tokens, calls, last_reset FROM usage WHERE agent_id = 'test-bot'"
```

#### 测试 B：调用次数超限

**准备**：将 `maxCalls` 设为 2

**步骤**：连续发送 3 条消息

**预期结果**：第 3 条时 agent 提示调用次数已达上限

#### 测试 C：到期时间拦截

**准备**：将 `expiresAt` 设为过去的时间

```jsonc
"expiresAt": "2024-01-01T00:00:00+08:00"
```

**预期结果**：发送任意消息后，agent 立即提示授权已过期，不执行任何操作

#### 测试 D：配额预警（80% 阈值）

**准备**：将 `maxTokens` 设为 1000，先消耗约 800 个 token

**预期结果**：agent 回复末尾出现剩余额度提醒

#### 测试 E：24 小时滑动重置

**准备**：修改 usage.sqlite 中的 `last_reset` 为 25 小时前

```bash
sqlite3 ~/.openclaw/extensions/tenant-guard/usage.sqlite \
  "UPDATE usage SET last_reset = strftime('%s','now','-25 hours') * 1000, tokens = 99999, calls = 999 WHERE agent_id = 'test-bot'"
```

**步骤**：发送一条消息

**预期结果**：用量自动清零，消息正常处理（不触发超限）

### 2.2 工具权限拦截测试

#### 测试 F：write 工具被拦截

租户 bot 尝试触发写文件操作（通过让 agent 执行写文件任务）

**预期结果**：
- `before_tool_call` 返回 block
- agent 告知用户无写入权限
- gateway 日志：`[WARN][tenant-guard:tools] Blocked write tool for test-bot`

#### 测试 G：exec 工具被拦截

询问租户 bot "帮我运行一段 Python 脚本"

**预期结果**：agent 告知不支持执行代码

#### 测试 H：memory_search 允许只读

询问租户 bot "帮我查找记忆中关于 xxx 的内容"

**预期结果**：
- `memory_search` 工具调用成功（未被 block）
- 返回全局 MEMORY.md 中的相关内容
- 租户不能修改记忆

### 2.3 session-memory hook 拦截测试

**关键验证点**：确认租户执行 `/new` 或 `/reset` 时不会写入全局 workspace/memory/

**步骤**：
1. 记录当前 `~/.openclaw/workspace/memory/` 目录下的文件列表
2. 以 test-bot 身份发送 `/new`
3. 检查目录是否新增文件

```bash
# 执行前
ls -la ~/.openclaw/workspace/memory/ > /tmp/before.txt

# 以租户身份发 /new 后
ls -la ~/.openclaw/workspace/memory/ > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```

**预期结果**：无新文件生成

**如果发现文件被写入（hook 无法拦截）**：
- 采用备选方案：给租户 agent 配置独立 workspace 目录
- 修改 `openclaw.json` 中租户 agent 的 `workspace` 字段指向隔离目录

### 2.4 Owner 通知队列测试

#### 测试 I：超限后通知队列写入

**步骤**：
1. 触发租户 test-bot 超限（参考测试 A/B）
2. 检查通知队列文件

```bash
cat ~/.openclaw/extensions/tenant-guard/data/notifications.jsonl
```

**预期结果**：有一条 `quota_exceeded` 事件

#### 测试 J：Owner 下次对话时收到提醒

**步骤**：
1. 触发超限（test-bot 配额用尽）
2. 切换到主 session（main agent）
3. 发送任意消息

**预期结果**：agent 回复开头出现类似：
```
[租户管理通知 - 1 条]
⚠️ test-bot: Token 额度用尽（10123/10000）...
使用 /tenant quota test-bot 更新配额。
```

#### 测试 K：通知队列 drain 后不重复提醒

**步骤**：收到通知后，再发一条消息

**预期结果**：第二条消息的回复中不再出现通知

---

## 三、管理命令测试

### 3.1 权限隔离测试

#### 测试 L：非 Owner 调用 /tenant 命令被拒绝

以 test-bot 身份发送 `/tenant list`

**预期结果**：返回 `🔒 仅 Owner 可执行此命令`

### 3.2 CRUD 命令测试

#### 测试 M：完整创建流程

```
/tenant create test-new --channel telegram --peer 88888888 --name "测试新建"
```

**验证**：
```bash
# 检查 openclaw.json 是否更新
python3 -c "
import json
with open(os.path.expanduser('~/.openclaw/openclaw.json')) as f:
    cfg = json.load(f)
agents = [a for a in cfg.get('agents',{}).get('list',[]) if a['id']=='test-new']
bindings = [b for b in cfg.get('agents',{}).get('bindings',[]) if b['agentId']=='test-new']
print('agent:', agents)
print('binding:', bindings)
"

# 检查 tenants.json 是否有对应配置
python3 -c "
import json
with open(os.path.expanduser('~/.openclaw/extensions/tenant-guard/data/tenants.json')) as f:
    t = json.load(f)
print(t['tenants'].get('test-new'))
"
```

#### 测试 N：删除租户

```
/tenant delete test-new
```

**验证**：agent + binding 从 `openclaw.json` 移除，但 `data/profiles/test-new/` 仍存在

#### 测试 O：查询用量

```
/tenant usage test-bot
```

**预期格式**：
```
📊 test-bot 用量统计
tokens: 8523 / 10000 (85.2%) ⚠️ 接近上限
calls:  7 / 10 (70.0%)
到期时间: 2026-04-01 00:00 (+08:00)
下次重置: 12h 30m 后（daily）
```

---

## 四、租户画像测试

### 4.1 会话摘要生成测试

#### 测试 P：session_end 生成摘要

**步骤**：
1. 以 test-bot 身份进行 5 轮对话
2. 发送 `/new` 结束会话
3. 检查摘要文件

```bash
cat ~/.openclaw/extensions/tenant-guard/data/profiles/test-bot/sessions-digest.jsonl | tail -1 | python3 -m json.tool
```

**预期**：最后一行是刚结束的会话摘要，包含 `slug`、`turns`、`tokens`、`keywords`

#### 测试 Q：LLM slug 生成失败时 fallback

**步骤**：临时破坏 `generateSlugViaLLM` 的导入路径，触发 fallback

**预期**：摘要中 `slug` 使用第一条用户消息的前 20 字，无异常抛出

---

## 五、并发与边界测试

### 5.1 并发配额更新

**步骤**：同时从同一租户发送多条消息（模拟并发）

**预期**：token/calls 计数正确，不出现负数或跳变，WAL 模式保证原子性

### 5.2 配置文件损坏恢复

**步骤**：手动向 `tenants.json` 写入非法 JSON

**预期**：插件捕获解析错误，使用缓存的上一次正确配置，不崩溃，日志输出 WARN

### 5.3 数据库文件不存在时自动创建

**步骤**：删除 `usage.sqlite`，重启 gateway

**预期**：插件自动创建数据库文件和表结构，正常运行

---

## 六、回归检查清单

每次代码变更后，快速执行以下检查：

```
[ ] main agent 发消息正常（不受任何拦截）
[ ] 租户 bot 工具权限正确（read/web_search/image 可用，exec/write/edit 被拦截）
[ ] 配额计数正确更新（SQLite 中 tokens/calls 递增）
[ ] 超限时租户收到明确提示
[ ] 超限时通知队列有写入
[ ] Owner 下次对话时收到通知提醒（且只提醒一次）
[ ] /tenant list 正确列出所有租户
[ ] /tenant create 写入 openclaw.json 格式正确（可被 OpenClaw 解析）
[ ] session-memory 不会在租户 /new 时写入全局 workspace/memory/
```

---

## 七、日志级别说明

调试时可通过 gateway 日志过滤插件输出：

```bash
# 实时查看 tenant-guard 相关日志
openclaw gateway start 2>&1 | grep "\[tenant-guard"

# 常见日志示例
[INFO][tenant-guard:quota]   Agent test-bot usage: tokens=8523/10000, calls=7/10
[WARN][tenant-guard:quota]   Agent test-bot token limit hit (10123/10000)
[INFO][tenant-guard:tools]   Blocked tool 'write' for agent test-bot
[INFO][tenant-guard:profile] Session digest written for test-bot: python-scraper
[INFO][tenant-guard:notify]  Queued quota_exceeded notification for test-bot
[INFO][tenant-guard:notify]  Drained 2 notifications for owner
[WARN][tenant-guard:config]  Failed to parse tenants.json, using cached config
```
