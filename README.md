# Byreal Marketing Agent

Twitter 营销情报采集 + AI 信号分级 + Discord 团队审核 + 飞书推送，封装为 NanoClaw Skill。

## 架构

v5 四层流水线，全部通过 YAML 配置，运营无需改代码。

```
Source (搜什么)  →  Judge (重不重要)  →  Reactor (怎么反应)  →  Route (发到哪)
sources.yaml       judge.yaml          reactor.yaml          routing.yaml
                                                                  ↓
                                                         Discord 频道 + 飞书 Webhook
```

### 数据流

```
xAI Search → 推文 → pre_filter(正则/黑名单) → Judge(LLM 分级 alertLevel)
                                                    ↓ none → 丢弃
                                                    ↓ 非 none
                                               Reactor(LLM 决策)
                                               suggestedAction + tones + replyAngle
                                                    ↓
                                               Route(规则匹配 → Discord 频道)
                                                    ↓
                                               Lark Webhook(direct-mentions)
```

## 信号来源（Sources）

| Source | 频率 | 说明 |
|--------|------|------|
| `direct-mentions` | 2x/h | 直接提到 Byreal / @byreal_io 的推文 |
| `indirect-mentions` | 1x/h | 讨论 Byreal 相关概念但未直接提及品牌 |
| `trend-keywords` | 1x/h | AI agent、DeFAI、Solana perps 等趋势关键词 |
| `explore-window` | 1x/4h | 过去 24h 高信号推文（叙事、方向、策略） |
| `ecosystem-core` | 1x/h | Solana 核心生态账号（@solana, @toly 等） |
| `top-dapps` | 1x/h | 头部 DeFi 协议（Jupiter, Raydium, Meteora 等） |
| `solana-kols` | 1x/h | Solana KOL 观点和 alpha |
| `signal-news-data` | 1x/h | 加密新闻、链上分析、VC 动态 |
| `key-devs` | 1x/2h | Solana 核心开发者技术动态 |
| `top-traders` | 1x/h | 链上交易员的实时市场判断 |
| `crisis` | 2x/h | 安全事件：exploit、hack、rug pull |
| `fireside-speakers` | 1x/h | Web3 思想领袖和 fireside 嘉宾 |

## Discord 频道路由

按 `suggestedAction` 路由，每条信号进一个频道，颜色表示紧急度：

| 频道 | 路由条件 | 用途 |
|------|---------|------|
| `#needs-reply` | reply_supportive | 需回复的推文，带语气按钮 |
| `#needs-qrt` | qrt_positioning | 需引用转发，带语气按钮 |
| `#collab-opportunities` | collab_opportunity | 合作/集成机会 |
| `#escalation` | escalate_internal | 需内部讨论决策 |
| `#engagement` | like_only | 点赞即可 |
| `#trending` | explore_signal | 值得关注的新叙事/方向 |
| `#noise` | none / 兜底 | 低优先级 |

### 信号卡片

- 🔴 红色 = 立即处理（安全事件、大 V 批评）
- 🟠 橙色 = 尽快处理（直接提及、合作机会）
- 🟡 黄色 = 可以晚看（间接信号、趋势）
- 带 **语气按钮**（AI 根据信号动态生成 2-3 个语气选项）
- 带 **反馈下拉**（Not Relevant / Wrong Category / Good Signal 等）
- 点按钮 → AI 生成回复草稿 → 发到 thread

## 飞书推送

`direct-mentions` 信号实时推送到飞书群（Lark Webhook），卡片包含：
- 推文内容 + 作者
- 发布时间 + 互动数据（views/likes/RT/replies）
- Alert 级别 + 建议动作 + 信号来源
- AI 分析理由（Judge reasoning）
- 回复角度（Reply angle）
- View on X 按钮

配置：`.env` 中设置 `LARK_MENTION_WEBHOOK_URL`。

## 配置文件

所有配置在 `config/` 目录，YAML 格式：

| 文件 | 说明 |
|------|------|
| `sources.yaml` | 搜索方向、频率、prompt、pre_filter |
| `judge.yaml` | 分级规则（alertLevel: red/orange/yellow/none） |
| `reactor.yaml` | 行动决策规则（suggestedAction + tones + replyAngle） |
| `routing.yaml` | alertLevel/suggestedAction → Discord 频道映射 |
| `accounts.yaml` | 监控账号分组（core/top-dapps/kols 等） |
| `governance.yaml` | 权限控制（谁能用 /config 命令） |
| `generator.yaml` | 草稿生成配置 |
| `enrichment.yaml` | 数据增强配置 |

### Discord Slash 命令

运营可在 Discord 内直接管理配置（无需 SSH）：

- `/config view` — 查看当前配置
- `/config accounts-add/remove` — 添加/移除监控账号
- `/config keywords-add/remove` — 添加/移除关键词
- `/config prompt-edit` — 在 Modal 里编辑 prompt
- `/config source-set-max` — 调整单源最大推文数
- `/config access-*` — 管理谁有权限改配置

## 技术栈

- **Runtime**: Node.js + TypeScript (ESM)
- **LLM**: Claude API（Judge + Reactor + Generator）
- **数据源**: xAI Grok Search API
- **数据库**: SQLite (better-sqlite3)
- **Discord**: discord.js
- **飞书**: Lark Webhook (Interactive Card)
- **调度**: node-cron
- **部署**: NanoClaw Skill → systemd

## 环境变量

```bash
DISCORD_BOT_TOKEN=         # Discord Bot Token
CLAUDE_CODE_OAUTH_TOKEN=   # Claude API 认证
DATA_SOURCE_API_KEY=       # xAI API Key
LARK_MENTION_WEBHOOK_URL=  # 飞书 Webhook（direct-mentions 推送）
MARKETING_AGENT_DB_PATH=   # SQLite 路径（默认 data/signals.db）
```

## 部署

作为 NanoClaw Skill 安装，详见 [SKILL.md](SKILL.md)。

```bash
# 安装
npx tsx -e "import { applySkill } from ./skills-engine/index.ts; applySkill(.claude/skills/add-marketing-agent)"

# Cron 调度（由 engine 内置 node-cron 管理，无需外部 crontab）

# 重启
systemctl --user restart nanoclaw
```

## 文档

- [Signal Pipeline 架构](add/marketing-agent/docs/signal-pipeline-architecture.md) — 四层架构详解
- [运营使用指南](add/marketing-agent/docs/operations-guide.md) — 面向运营，无需懂代码
- [架构模式研究](add/marketing-agent/docs/architecture-patterns-research.md) — 设计决策背景
