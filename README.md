# tenant-guard

> OpenClaw 多租户授权、配额、隔离与画像插件

## 功能概览

| 能力 | 说明 |
|------|------|
| **配额管控** | Token/Calls 计数、超限拦截（reject/downgrade）、滑动窗口自动重置 |
| **工具权限** | 可配置 allow/deny 列表，默认禁止 exec/write/edit |
| **系统提示词** | 模板变量替换、首次欢迎、语言约束（zh/en/ja/auto） |
| **Owner 通知** | JSONL 队列、超限/过期自动通知、drain 注入主对话 |
| **多管理员** | ownerAgents 列表、/tenant owner add/remove，支持手机端管理 |
| **租户管理** | /tenant 命令（create/delete/list/quota/config/owner/cleanup/profile） |
| **租户画像** | before_reset 会话采集、关键词提取、profile 聚合统计 |
| **超限降速** | 可配置 downgrade 模式，切换到更便宜的模型 |

## 安装

### Docker 环境（推荐）

```bash
# 1. 打包插件
cd tenant-guard
tar -cf /tmp/plugin.tar --exclude=node_modules --exclude=.git \
  src package.json openclaw.plugin.json

# 2. 上传到容器
docker cp /tmp/plugin.tar openclaw_1:/tmp/

# 3. 容器内解压 + 安装依赖
docker exec openclaw_1 sh -c "
  mkdir -p /tmp/tenant-guard-src
  cd /tmp/tenant-guard-src
  tar xf /tmp/plugin.tar
  npm install --production
"

# 4. OpenClaw CLI 安装
docker exec openclaw_1 openclaw plugins install /tmp/tenant-guard-src

# 5. 重启生效
docker restart openclaw_1
```

### 验证安装

```bash
docker logs openclaw_1 --tail 20 | grep tenant-guard
# 应看到：
# [tenant-guard] SQLite initialized: /app/data/usage.sqlite
# [tenant-guard] Registering hooks...
# [tenant-guard] ✅ tenant-guard loaded successfully
```

## 配置

### tenants.json（租户配额配置）

```json
{
  "ownerAgents": ["main"],
  "defaults": {
    "quota": { "maxTokens": 100000, "maxCalls": 50, "resetInterval": "daily" },
    "tools": { "allow": ["read", "web_search", "image"], "deny": ["exec", "write", "edit"] },
    "language": "auto",
    "overLimit": { "action": "reject" }
  },
  "systemPromptTemplate": "你是 {name}。\n{language_hint}\n额度：{maxTokens} tokens.",
  "tenants": {}
}
```

### openclaw.json 兼容性

`package.json` 必须包含：
```json
{
  "openclaw": { "extensions": ["./src/index.js"] }
}
```

`openclaw.plugin.json` 必须包含：
```json
{
  "configSchema": { "type": "object", "properties": {} }
}
```

## 管理命令

```
/tenant create <id> --channel <ch> [--model <m>] [--tools <list>] [--language <lang>]
/tenant delete <id>
/tenant list
/tenant quota <id> [--tokens <n>] [--calls <n>] [--expires <ISO>] [--reset]
/tenant config <id> [--model <m>] [--tools <list>] [--language <lang>]
/tenant owner [list|add|remove] <agentId>
/tenant cleanup [--expired] [--inactive-days <N>] [--dry-run]
/tenant profile <id>
```

## 自测

```bash
# 需要 node_modules（better-sqlite3）
node test/self-test-m2.mjs  # 配额核心 (30 tests)
node test/self-test-m3.mjs  # 管理命令 (25 tests)
node test/self-test-m4.mjs  # 租户画像 (14 tests)
node test/self-test-m5.mjs  # 通知队列 (15 tests)
```

## 调试

```bash
# 启用详细日志
TENANT_GUARD_DEBUG=1 openclaw gateway start

# 查看用量数据
sqlite3 usage.sqlite "SELECT * FROM usage"

# 查看事件日志
sqlite3 usage.sqlite "SELECT * FROM quota_events ORDER BY created_at DESC LIMIT 10"
```

## 技术栈

- **运行时**：Node.js 18+、ESM
- **数据库**：better-sqlite3（WAL 模式）
- **依赖**：仅 better-sqlite3（零其他依赖）

## License

MIT
