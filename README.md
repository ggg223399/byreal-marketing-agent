# Byreal Marketing Agent

Twitter 营销情报采集 + AI 分类 + Discord 团队审核，封装为 NanoClaw Skill。

## 功能概览

- 定时采集 Twitter 推文（支持指定账号 + 关键词）
- Claude Haiku AI 三级分类（`reply_needed` / `watch_only` / `ignore`）
- 告警等级路由（red/orange/yellow → 不同 Discord 频道）
- Discord 机器人命令：查看信号、生成回复草稿、审批流程
- 每日摘要自动推送

## 数据源支持

| 数据源 | 认证方式 | 计费 | 适用场景 |
|--------|---------|------|---------|
| `mock` | 无 | 免费 | 本地开发测试 |
| `twitterapi_io` | X-API-Key | $0.15/1K tweets | 初期上线，按量付费 |
| `twitter_v2` | Bearer Token | $100/月起 | 官方 API，高配额需求 |

所有数据源共享 `max_tweets_per_query` 配置（默认 5），控制每次查询返回数量。

## 项目结构

```
├── collector/          # 数据采集（adapters: mock, twitterapi_io, twitter_v2）
├── classifier/         # AI 分类（Claude Haiku）
├── generator/          # 回复草稿生成
├── approval/           # 审批工作流
├── notifications/      # 告警路由
├── digest/             # 每日摘要
├── governance/         # 限流 & 风控
├── db/                 # SQLite schema & migrations
├── config/             # YAML 配置加载
├── prompts/            # 分类 prompt
├── tests/              # 单元测试（vitest）
├── scripts/            # cron 脚本
├── groups/             # Discord bot 命令处理（CLAUDE.md）
├── src/channels/       # Discord channel 实现
├── types/              # TypeScript 类型定义
├── config.yaml.example # 配置模板
└── SKILL.md            # NanoClaw 安装指南
```

## 安装

### 1. 克隆到 NanoClaw 目录

```bash
cd /path/to/your/nanoclaw    # 替换为你的 NanoClaw 实际路径
git clone https://github.com/ggg223399/byreal-marketing-agent skills/byreal-marketing-agent
```

### 2. 打开 Claude Code

```bash
claude
```

### 3. 输入安装命令

打开 Claude Code 后，复制粘贴以下内容并回车：

```
按照 skills/byreal-marketing-agent/SKILL.md 安装营销 agent
```

Claude Code 会自动完成：依赖安装、代码集成、数据库初始化、cron 定时任务配置。

> **前置条件**：需要已部署运行的 [NanoClaw](https://github.com/qwibitai/NanoClaw) 实例。Discord Bot Token、Webhook URL、TwitterAPI.io API Key 的获取方法见 [SKILL.md 前置准备](./SKILL.md#准备-1获取-discord-bot-token)。

## Discord 命令

在 `#marketing-bot` 频道 @mention 机器人使用以下命令：

| 命令 | 说明 |
|------|------|
| `show signals` | 列出待审核信号 |
| `draft reply #N` | 为信号 N 生成回复草稿 |
| `approve #N professional` | 批准（专业语气） |
| `approve #N friendly` | 批准（友好语气） |
| `reject #N` | 拒绝信号 |
| `status` | 系统统计 |

## 配置

`config.yaml.example` 关键配置项说明：

- `data_source`: 数据源类型和 API key
  - `type`: `mock` / `twitterapi_io` / `twitter_v2`
  - `api_key`: 通过 `DATA_SOURCE_API_KEY` 环境变量覆盖
  - `max_tweets_per_query`: 每次查询返回数量（默认 5，范围 1-100）
- `monitoring`: 监控账号和关键词
  - `accounts_tier1`: 主要监控账号
  - `accounts_partners`: 合作方账号
  - `keywords`: 关键词列表
- `notifications`: Discord webhook URLs
  - `discord_webhook_url`: 全量信号频道
  - `urgent_webhook_url`: 紧急告警频道
  - `digest_webhook_url`: 每日摘要频道
- `governance`: 限流规则
  - `max_replies_per_hour`: 每小时最大回复数
  - `max_replies_per_day`: 每天最大回复数
  - `blacklist`: 黑名单账号
  - `risk_keywords`: 风险关键词

## License

MIT
