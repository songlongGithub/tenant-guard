# Changelog

## v1.0.0 (2026-03-23)

### 新增

#### M2 — 配额执行核心
- `src/store/usage-db.js`：SQLite WAL 模式用量数据库（原子递增、CAS 防重复、事务重置）
- `src/store/tenants-config.js`：tenants.json 热加载（mtime 缓存 + 默认合并）
- `src/hooks/quota.js`：三个核心 hook
  - `llm_output`：Token/Calls 计数 + 超限通知
  - `before_tool_call`：工具权限拦截 + 配额拦截 + 过期检查
  - `before_prompt_build`：系统提示词注入 + 语言约束 + 用量预警 + 首次欢迎
- 自测：30/30 通过

#### M5 — Owner 通知队列
- `src/store/notifications.js`：JSONL append + atomic drain + 格式化
- `src/hooks/notify.js`：Owner before_prompt_build 通知注入
- 自测：15/15 通过

#### M3 — 管理命令
- `src/commands/tenant.js`：8 个子命令
  - `create`：6 项 pre-write 验证 + writeConfigFile + post-write 验证
  - `delete`：移除 agent + binding + tenants.json + SQLite
  - `list`：状态指示器（活跃/即将超限/已超限/已过期）
  - `quota`：显示/设置/重置配额
  - `config`：修改 tools/language/overLimit/systemPrompt（无需重启）
  - `owner`：多管理员 add/remove/list（main 不可移除）
  - `cleanup`：批量清理过期/不活跃租户（支持 --dry-run）
  - `profile`：查看租户画像
- 自测：25/25 通过

#### M4 — 租户画像
- `src/utils/keywords.js`：中英文关键词提取（停用词过滤 + 频率排序）
- `src/hooks/profile.js`：before_reset 会话画像（SQLite upsert）
- 自测：14/14 通过

#### M6 — Docker 集成验证
- OpenClaw 兼容性修复：`openclaw.extensions`、`configSchema`、同步 register
- Docker 安装验证：`openclaw plugins install` 成功
- 重启持久化验证：重启后插件正常加载

### 基础设施
- `src/index.js`：插件入口，注册全部 hook + 命令
- `src/utils/logger.js`：日志工具（支持 TENANT_GUARD_DEBUG 环境变量）
- `data/tenants.json`：默认配置模板
- `openclaw.plugin.json`：插件清单
- `package.json`：依赖声明 + openclaw 扩展点

### 测试
- `test/self-test-m2.mjs`：配额核心 30 个测试
- `test/self-test-m3.mjs`：管理命令 25 个测试
- `test/self-test-m4.mjs`：租户画像 14 个测试
- `test/self-test-m5.mjs`：通知队列 15 个测试
- **总计：84 个自测全部通过**
