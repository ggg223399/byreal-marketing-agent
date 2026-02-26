# Byreal Marketing Agent

Twitter 营销情报采集 + AI 分类 + Discord 团队审核系统，封装为 NanoClaw Skill。

## 功能概览

v2 核心能力：
- 定时采集 Twitter 推文（指定账号 + 关键词，支持 3 种数据源）
- Claude Haiku AI 8 类信号分类 + 情感/优先级/风险/建议动作等元数据
- **7 频道智能路由**：按告警等级（Tier 1/2/3/Noise）+ 建议动作（Reply/Interaction）双维度分发
- **一键生成回复草稿**：点击按钮选择语气，AI 生成带品牌语境的回复
- **可配置语气**：从 config.yaml 动态配置最多 5 种回复语气
- **品牌上下文注入**：从 `prompts/brand_context.md` 加载品牌信息，确保回复与 Byreal 产品相关
- **定时摘要**：每天 9AM 和 6PM (SGT) 自动推送信号摘要
- 每日详细 Digest（通过 Webhook 推送）
- 限流 & 风控（governance）

## 系统架构

```
Twitter → [Collector] → [Classifier (Claude Haiku)] → [DB] → [Discord Bot]
                                                               ├── 轮询 (30s) → 信号路由 → 7 个频道
                                                               ├── 按钮交互 → 生成回复草稿 (ephemeral)
                                                               └── 定时摘要 → #periodic-summary
```

## Discord 频道架构

v2 采用 7 频道分层设计，Bot 按频道名自动匹配（不需要 Webhook URL 或频道 ID）：

### 📋 ACTION — 运营待办

| 频道 | 路由条件 | 功能 |
|------|---------|------|
| `#needs-reply` | suggestedAction = reply_supportive / qrt_positioning | 需要回复的信号，带 📝 Generate Reply 按钮 |
| `#needs-interaction` | suggestedAction = like_only / escalate_internal | 需要互动的信号（点赞、内部升级） |

### 📊 INTELLIGENCE — 按优先级分层

| 频道 | 路由条件 | 说明 |
|------|---------|------|
| `#tier1-signals` 🔴 | alertLevel = red | 高优先级（增长里程碑、风险事件、高置信度信号） |
| `#tier2-signals` 🟠 | alertLevel = orange | 中优先级 |
| `#tier3-signals` 🟡 | alertLevel = yellow | 低优先级 |

### 🔇 NOISE

| 频道 | 路由条件 | 说明 |
|------|---------|------|
| `#noise` | alertLevel = none | 低价值信号（低置信度的机构/排名/市场结构类） |

### 📰 SUMMARY

| 频道 | 触发 | 说明 |
|------|------|------|
| `#periodic-summary` | 每天 9:00 AM 和 6:00 PM SGT | 过去 12 小时信号摘要（按 Tier 分组统计） |

### 双发机制

每条信号最多发到 **2 个频道**：
1. **Tier 频道**（必发）— 纯信息展示，无按钮
2. **Action 频道**（按需）— 带 📝 Generate Reply 或互动按钮

## 信号分类

8 类信号 + emoji 标识：

| Cat | Emoji | 类型 | 示例 |
|-----|-------|------|------|
| 1 | 🚀 | Solana Growth Milestone | Solana 活跃钱包突破 1 亿 |
| 2 | 🏛️ | Institutional Adoption | 大型机构入场 Solana |
| 3 | 📜 | RWA Signal | RWA 代币化新框架 |
| 4 | 💧 | Liquidity Signal | 流动性异动、TVL 变化 |
| 5 | 📊 | Market Structure Insight | DEX 交易量激增 |
| 6 | 🏆 | Byreal Ranking Mention | Byreal 在排名/对比中被提及 |
| 7 | 🤝 | Partner Momentum | 合作伙伴动态 |
| 8 | ⚠️ | Risk Event | 安全事件、exploit、rug |

## 回复草稿生成

### 交互流程

1. 信号出现在 `#needs-reply` 频道，带 📝 Generate Reply 按钮
2. 运营点击按钮 → 出现 4 个语气选择按钮（ephemeral，仅点击者可见）
3. 选择语气 → AI 生成带 Byreal 品牌语境的回复草稿
4. 可以重新点击其他语气重新生成
5. 复制草稿到 Twitter 发布

### 默认语气配置

| 按钮 | 语气 | 适用场景 |
|------|------|---------|
| 🧑‍💼 Helpful Expert | 专业权威 | 提供具体技术或数据价值 |
| 👋 Friendly Peer | 轻松对等 | 社区互动，亲切回复 |
| 🙏 Humble Ack | 感恩致谢 | 被提及时的谦虚回应 |
| 💬 Direct Rebuttal | 建设性反驳 | 回应 FUD 或不实信息 |

语气完全可配置，在 `config.yaml` 的 `tones` 字段修改，最多 5 个（Discord ActionRow 限制）。

### 品牌上下文

AI 生成回复时会注入 `prompts/brand_context.md` 中的品牌信息，确保回复与 Byreal 产品定位一致。包含：产品特性、竞品对比、品牌语调指南。

## 数据源支持

| 数据源 | 认证方式 | 计费 | 适用场景 |
|--------|---------|------|---------|
| `mock` | 无 | 免费 | 本地开发测试 |
| `twitterapi_io` | X-API-Key | $0.15/1K tweets | 初期上线，按量付费 |
| `twitter_v2` | Bearer Token | $100/月起 | 官方 API，高配额需求 |

## 配置说明

`config.yaml` 核心配置项：

### data_source

- `type`: 数据源类型（mock / twitterapi_io / twitter_v2）
- `api_key`: API key（可通过 `DATA_SOURCE_API_KEY` 环境变量覆盖）
- `max_tweets_per_query`: 每次查询返回数量（默认 5，范围 1-100）

### monitoring

- `accounts_tier1`: 主要监控账号列表
- `accounts_partners`: 合作方账号列表
- `keywords`: 监控关键词列表
- `polling_interval_minutes`: 采集间隔（分钟）

### classification

- `model`: 分类模型（默认 claude-haiku-4-5）
- `temperature`: 温度参数（默认 0）

### notifications

- `digest_webhook_url`: 每日 Digest Webhook URL
- `digest_time` / `digest_timezone`: Digest 推送时间
- `needs_reply_channel`: 需回复频道名（默认 needs-reply）
- `needs_interaction_channel`: 需互动频道名（默认 needs-interaction）
- `tier1_channel` ~ `tier3_channel`: Tier 频道名
- `noise_channel`: 噪音频道名（默认 noise）
- `summary_channel`: 摘要频道名（默认 periodic-summary）

### tones（可选）

语气配置数组，每项包含：
- `id`: 唯一标识（≤20 字符）
- `label`: 按钮显示文本
- `emoji`: 按钮 emoji
- `description`: 语气描述（传给 AI 用于生成对应风格回复）

最多 5 个（Discord ActionRow 限制）。不配置时使用默认 4 种语气。

### brand_context_path（可选）

品牌上下文文件路径（默认 `prompts/brand_context.md`），≤3000 字符。

### governance

- `max_replies_per_hour`: 每小时最大回复数
- `max_replies_per_day`: 每天最大回复数
- `blacklist`: 黑名单账号
- `risk_keywords`: 风险关键词

## 项目结构

### Skill 仓库

```
byreal-marketing-agent/
├── collector/          # 数据采集（adapters: mock, twitterapi_io, twitter_v2）
├── classifier/         # AI 分类（Claude Haiku，8 类信号）
├── generator/          # 回复草稿生成（品牌上下文注入）
├── approval/           # 审批工作流
├── notifications/      # 告警路由（resolveTargetChannels 双发逻辑）
├── digest/             # 每日摘要
├── governance/         # 限流 & 风控
├── db/                 # SQLite schema & migrations
├── config/             # YAML 配置加载 + normalizeConfig
├── prompts/            # 分类 prompt + 品牌上下文
├── tests/              # 单元测试（vitest，99 tests）
├── scripts/            # cron 脚本（采集、Digest）
├── types/              # TypeScript 类型定义
├── lib/                # 共享库
├── src/channels/       # Discord channel 实现
├── groups/             # NanoClaw group
├── config.yaml.example # 配置模板
└── SKILL.md            # NanoClaw 安装指南
```

### 安装后（NanoClaw 侧）

```
nanoclaw/
├── src/channels/discord.ts    ← Discord Bot（信号轮询 + 按钮交互 + 摘要调度）
├── marketing-agent/           ← 业务逻辑
│   ├── prompts/brand_context.md  ← 品牌上下文
│   └── ...
├── groups/marketing-alerts/   ← NanoClaw 群组
├── config.yaml                ← 运行配置
└── data/signals.db            ← SQLite 数据库
```

## 安装

详见 [SKILL.md](./SKILL.md)。

## Discord 命令

在注册的群组频道 @mention Bot：

| 命令 | 说明 |
|------|------|
| `show signals` | 列出待审核信号 |
| `draft reply #N` | 展示信号 + 语气按钮 |
| `reject #N` | 拒绝信号 |
| `status` | 系统统计 |

## License

MIT
