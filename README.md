# tenant-guard

OpenClaw 多租户授权与记忆隔离插件。

## 功能概述

为 OpenClaw 提供完整的多租户能力，支持将 AI Agent 能力安全地开放给第三方 Bot 接入：

- **租户隔离**：每个租户 Bot 对应独立的 Agent，工具权限最小化（仅 `read` / `web_search` / `image`）
- **记忆隔离**：全局记忆只读，租户会话记忆独立存储，不互相污染
- **配额管理**：按 Token 用量、调用次数、到期时间三维度控制，24 小时滑动窗口自动重置
- **超额提示**：租户侧三层提示（预警 / 拦截 / 兜底），Owner 侧通知队列下次对话时提醒
- **管理命令**：Owner 专属 `/tenant` 命令，支持动态创建 / 删除 / 查看租户
- **租户画像**：每次会话结束自动生成摘要，LLM 提取 topic，可追踪用户偏好优化模型

## 支持的 Channel

| Channel | 来源 | 典型匹配字段 |
|---------|------|-------------|
| telegram | 内置 | `peer.id`（用户 ID）|
| whatsapp | 内置 | `peer.id`（E.164 手机号）|
| discord | 内置 | `guildId` / `roles` / `peer.id` |
| slack | 内置 | `teamId` / `peer.id` |
| signal | 内置 | `peer.id`（E.164）|
| imessage | 内置 | `peer.id`（handle）|
| irc | 内置 | `peer.id`（频道名）|
| googlechat | 内置 | `peer.id`（用户/空间 ID）|
| line | 内置 | `peer.id` |
| feishu | 插件 | `peer.id`（用户/群 ID）|
| qqbot | 插件 | `accountId` / `peer.id` |
| openclaw-weixin | 插件 | `peer.id`（微信 ID）|

## 目录结构

```
tenant-guard/
├── src/
│   └── index.js           # 插件主入口
├── data/
│   ├── tenants.json       # 租户配额配置（热加载，Owner 直接编辑）
│   ├── usage.sqlite       # 用量统计数据库
│   ├── notifications.jsonl # Owner 通知队列
│   └── profiles/          # 租户会话画像
│       └── {tenantId}/
│           ├── profile.json
│           └── sessions-digest.jsonl
├── docs/
│   ├── SPEC.md            # 完整需求规格
│   ├── NOTES.md           # 注意事项与已知坑
│   └── TESTING.md         # 测试方法
├── openclaw.plugin.json   # 插件元数据
└── package.json
```

## 快速开始

### 安装插件

```bash
# 在 openclaw.json 中添加
{
  "plugins": {
    "allow": ["tenant-guard"],
    "installs": {
      "tenant-guard": {
        "source": "path",
        "sourcePath": "/path/to/tenant-guard"
      }
    }
  }
}
```

### 创建第一个租户

在 Owner 的主对话中：

```
/tenant create my-bot --channel qqbot --account bot1
/tenant quota my-bot --tokens 500000 --calls 200 --expires 2026-04-01
```

重启 gateway 后生效：

```bash
openclaw gateway restart
```

### 查看租户状态

```
/tenant list
/tenant usage my-bot
/tenant profile my-bot
```

## 详细文档

- [需求规格 SPEC.md](docs/SPEC.md)
- [注意事项 NOTES.md](docs/NOTES.md)
- [测试方法 TESTING.md](docs/TESTING.md)

## 技术栈

- **运行环境**：Node.js ESM（`type: "module"`）
- **数据库**：SQLite（`better-sqlite3`，同步 API）
- **配置格式**：JSON（`tenants.json` 支持热加载）
- **插件 API**：OpenClaw Plugin SDK v2

## License

MIT
