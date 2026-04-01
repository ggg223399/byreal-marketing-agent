# Signal Pipeline Architecture

> Date: 2026-03-09
> Status: v5 Implemented（四层架构：Source→Judge→Reactor→Route + Generator on-demand）
> 更新：当前生产使用 12 个 sources，`trending` 频道走 `explore_signal` 直接路由，不依赖 enrichment
> 前置文档: [architecture-patterns-research.md](./architecture-patterns-research.md)

## 一句话

四层流水线：**Source（搜什么）→ Judge（重不重要）→ Reactor（怎么反应）→ Route（发到哪）**。

- **Judge** 只做分级（alertLevel），不决定行动
- **Reactor** 对有价值的推文决定动作类型 + 语气 + 回复方向，有独立的品牌上下文
- 路由用的字段（alertLevel、suggestedAction）是 enum 锁死的，下游路由完全确定性
- Reactor 同时输出动态 tones 数组（2-3 个语气选项）和自由文本 replyAngle，给 Generator 生成具体文案用
- Source 和 Judge 之间有可选的 **pre_filter**，用确定性规则（正则、黑名单）过滤垃圾推文

---

## 解决什么问题

### 现在的问题

1. **加搜索方向要改代码**：加一个"token-launch 监控"需要改 collect.ts + classify.ts + router.ts + types/index.ts（4 个文件）
2. **改判断标准要改代码**：想把"mentions 推文什么时候该回复"的标准从"被提及就回复"改成"被提及且正面才回复"，要改 classify.ts 的 prompt 和验证逻辑
3. **改路由要改代码**：想把 crisis 的关键事件从 `#escalation` 改到别的频道，要改 router.ts
4. **运营无法自助**：所有调整都需要开发者介入

### 改完后

| 运营想做的事 | 怎么做 | 碰代码吗 |
|------------|--------|---------|
| 加一个搜索方向 | sources.yaml 加一段 | 不碰 |
| 改搜索关键词/账号 | sources.yaml 改一行 | 不碰 |
| 改判断标准（什么算 red） | judge.yaml 用自然语言改规则 | 不碰 |
| 改反应策略（什么时候回复/QRT） | reactor.yaml 用自然语言改规则 | 不碰 |
| 改路由（red 发到哪个频道） | routing.yaml 改一行 | 不碰 |
| 加一个搜索方向 + 完整配置 | 四个 YAML 各加几行 | 不碰 |

---

## 架构总览

```
┌───────────────────────────────────────────────────────────────┐
│                    配置层（运营可编辑）                           │
│                                                               │
│  sources.yaml    judge.yaml     reactor.yaml   routing.yaml   │
│  搜什么           重不重要        怎么反应        发到哪         │
│  (搜索 prompt)    (分级规则)      (行动规则       (标签→频道)    │
│                                  +品牌上下文)                   │
│                                                               │
│  每个 source 可配 pre_filter（正则/黑名单）和 skip_judge        │
└──────┬──────────────┬──────────────┬──────────────┬───────────┘
       │              │              │              │
       ▼              ▼              ▼              ▼
┌───────────────────────────────────────────────────────────────┐
│                    引擎层（开发者维护，~720 行）                  │
│                                                               │
│  searcher.ts    judge.ts     reactor.ts    router.ts          │
│  (~300 行)      (~100 行)    (~100 行)     (~80 行)            │
│  xAI 搜索       LLM 分级     LLM 决策      标签匹配→发送       │
│  分批/去重       alertLevel   action        确定性路由          │
│  pre_filter     +reasoning   +品牌上下文                       │
│                                                               │
│  config-loader.ts (~80 行)  +  cron 调度 (~60 行)              │
└───────────────────────────────────────────────────────────────┘
```

### 数据流

```
Source           pre_filter       Judge           Reactor          Route
(xAI x_search)  (正则/黑名单)     (LLM 分级)       (LLM 决策)        (规则匹配)

搜索 ──→ 推文 ──→ 过滤垃圾 ──→ alertLevel ──→ suggestedAction ──→ 匹配路由 ──→ Discord
              ↓              +reasoning     +品牌上下文            频道
         skip_judge          (schema 锁死)  (schema 锁死)
         的推文挂默认                ↓
         标签直接 ───────────→ none → 丢弃
                             非 none → 进 Reactor
```

关键设计：
- **路由字段被 schema 锁死**：alertLevel（Judge）和 suggestedAction（Reactor）是 enum，路由层只看这些，完全确定性
- **Generator 字段是半结构化的**：tones 的结构锁死（必须有 id/label/description），但内容由 LLM 动态生成，给 Generator 最大表达自由
- **Judge 过滤噪声**：alertLevel=none 的推文不进 Reactor，节省 LLM 调用
- **Reactor 有独立上下文**：品牌定位、互动历史、竞品关系，比 Judge 更"懂业务"

---

## Layer 1: Source（搜什么）

### 职责

定时触发搜索，获取推文。每个 source 是一个搜索方向。

调度使用系统级 cron（`node-cron` 库），不自己造调度器。

### 配置格式

```yaml
# sources.yaml（当前 12 个 sources，按职责分组）

sources:
  # ── 品牌直接提及 ──
  - name: direct-mentions
    schedule: "*/15 * * * *"
    lookback_minutes: 30               # 兜底回看窗口（last_seen 丢失时使用）
    use_last_seen: true                # 增量模式：追踪上次处理位置，避免重复
    prompt: |
      Search for tweets mentioning "Byreal", "@byreal_io", "byreal.io",
      "#byreal", "$BYREAL", or "@emilyRioFreeman".
      Exclude pure retweets, only original tweets.

  # ── 品牌间接提及（讨论产品但未提品牌名）──
  - name: indirect-mentions
    schedule: "*/15 * * * *"
    lookback_minutes: 30
    use_last_seen: true
    prompt: |
      Search for tweets discussing Byreal products/concepts without mentioning Byreal directly.
      Look for: Solana-native DEXs, Automated Yield, AI DeFi agents, Copy LPing/Farming, LP Strategy, RWAs...
      Exclude tweets that already mention "Byreal", "@byreal_io" etc.
    pre_filter:
      exclude_patterns:
        - "(?i)byreal|@byreal_io|byreal\\.io|#byreal|\\$byreal"
        - "(?i)^RT @"
      min_length: 30

  # ── 行业叙事 / 趋势关键词 ──
  - name: trend-keywords
    schedule: "*/30 * * * *"
    lookback_minutes: 60
    use_last_seen: true
    keywords: ["AI agent Solana", "DeFi AI agent", "Crypto AI agent", "onchain AI agent", ...]
    prompt: |
      Search for tweets discussing: {{keywords}}
      Focus on emerging narratives, trend shifts, high-signal commentary.
    pre_filter:
      exclude_patterns: ["(?i)^RT @", "(?i)giveaway|airdrop.*(tag|mention|follow)", "(?i)follow.*rt.*win"]
      min_length: 30

  # ── Explore 窗口：过去 24h 的高价值发现 ──
  - name: explore-window
    schedule: "0 */4 * * *"
    lookback_minutes: 1440
    use_last_seen: false
    prompt: |
      Search the past 24 hours for posts worth internal exploration.
      Prioritize new narratives, product directions, distribution patterns,
      integration surfaces, and high-signal market framing.

  # ── Solana 核心生态账号 ──
  - name: ecosystem-core
    schedule: "*/30 * * * *"
    lookback_minutes: 60
    use_last_seen: true
    prompt: |
      Search for tweets from Solana core ecosystem accounts.
      Focus on ecosystem announcements, network upgrades, DeFi insights, partnership news.
    accounts_ref: config/accounts.yaml
    groups: [core]                     # Solana Foundation / 核心生态 KP
    pre_filter:
      exclude_patterns: ["(?i)^RT @"]

  # ── Web3 思想领袖 / Fireside 嘉宾 ──
  - name: fireside-speakers
    schedule: "*/60 * * * *"
    lookback_minutes: 60
    use_last_seen: true
    prompt: |
      Search for tweets from key Web3 thought leaders.
      Focus on crypto macro insights, investment theses, DeFi commentary.
    accounts_ref: config/accounts.yaml
    groups: [fireside-speakers]
    pre_filter:
      exclude_patterns: ["(?i)^RT @", "(?i)(affiliate|referral|promo).*(link|code|url)"]

  # ── Solana 头部 DApp ──
  - name: top-dapps
    schedule: "*/30 * * * *"
    lookback_minutes: 60
    use_last_seen: true
    prompt: |
      Search for tweets from key Solana DeFi protocols, wallets, ecosystem apps.
      Focus on feature launches, TVL milestones, integrations, token programs.
    accounts_ref: config/accounts.yaml
    groups: [top-dapps]
    pre_filter:
      exclude_patterns: ["(?i)giveaway|airdrop.*(tag|mention|follow)", "(?i)follow.*rt.*win", "(?i)^RT @"]

  # ── Solana KOL ──
  - name: solana-kols
    schedule: "*/30 * * * *"
    lookback_minutes: 60
    use_last_seen: true
    prompt: |
      Search for tweets from influential Solana KOLs.
      Focus on conviction calls, bullish ecosystem takes, early alpha.
    accounts_ref: config/accounts.yaml
    groups: [solana-kols]
    pre_filter:
      exclude_patterns: ["(?i)giveaway|airdrop.*(tag|mention|follow)", "(?i)follow.*rt.*win", "(?i)^RT @"]

  # ── 新闻 / 数据 / VC ──
  - name: signal-news-data
    schedule: "*/30 * * * *"
    lookback_minutes: 60
    use_last_seen: true
    prompt: |
      Search for tweets from crypto news sources, on-chain analytics, leading crypto VCs.
      Focus on breaking news, data-driven insights, VC investment theses.
    accounts_ref: config/accounts.yaml
    groups: [signal-news-data]
    pre_filter:
      exclude_patterns: ["(?i)^RT @"]

  # ── 核心开发者 ──
  - name: key-devs
    schedule: "*/30 * * * *"
    lookback_minutes: 60
    use_last_seen: true
    prompt: |
      Search for tweets from core Solana developers and protocol engineers.
      Focus on technical breakthroughs, infrastructure insights, upcoming protocol changes.
    accounts_ref: config/accounts.yaml
    groups: [key-devs]
    pre_filter:
      exclude_patterns: ["(?i)^RT @"]

  # ── 顶级交易员 ──
  - name: top-traders
    schedule: "*/30 * * * *"
    lookback_minutes: 60
    use_last_seen: true
    prompt: |
      Search for tweets from elite on-chain traders.
      Focus on token calls with reasoning, market structure reads, entry/exit commentary.
    accounts_ref: config/accounts.yaml
    groups: [top-traders]
    pre_filter:
      exclude_patterns: ["(?i)^RT @"]

  # ── 危机监控 ──
  - name: crisis
    schedule: "*/5 * * * *"            # 高频，每 5 分钟
    lookback_minutes: 15               # 固定回看，不用 last_seen（宁可重复也不漏）
    use_last_seen: false
    prompt: |
      Search for security incidents in Solana DeFi:
      exploits, hacks, rug pulls, fund theft, contract vulnerabilities,
      depegs, bridge exploits, oracle manipulation. Include unconfirmed early reports.
```

### source 配置字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | 搜索方向的唯一标识 |
| `schedule` | 是 | cron 表达式，控制执行频率 |
| `prompt` | 是 | 给 xAI Grok 的自然语言搜索意图 |
| `lookback_minutes` | 否 | 首次运行或 last_seen 丢失时的兜底回看窗口（默认 60 分钟）|
| `use_last_seen` | 否 | `true` 时增量模式：记录上次处理的推文 ID，下次从那里开始，避免重复处理。`false` 时每次独立扫描（适合 crisis 等宁可重复不漏的场景）|
| `accounts_ref` | 否 | 引用外部账号列表文件（设置后 API 会用 `allowed_x_handles`） |
| `groups` | 否 | 从 `accounts_ref` 文件中按 group 名筛选账号 |
| `keywords` | 否 | 内联关键词列表，注入到 prompt 的 `{{keywords}}` 模板变量中 |
| `skip_judge` | 否 | `true` 时跳过 Judge + Reactor，直接用 `default_labels` 进路由（适合"搜到就有价值"的极高信任账号，慎用）|
| `default_labels` | 否 | `skip_judge: true` 时必须配，含 alertLevel 和 suggestedAction |
| `pre_filter` | 否 | 进 Judge 前的确定性过滤（正则黑名单、最小长度），节省 LLM 调用 |

### 引擎怎么执行 source

```
for each source:
  1. cron 触发执行（node-cron 库，不自己写调度器）
  2. 读取 prompt，替换模板变量（如 {{keywords}}）
  3. 确定搜索时间范围：
     - use_last_seen=true：读取 DB 中记录的上次最新推文 ID，仅拉取新推文
     - use_last_seen=false 或首次运行：回看 lookback_minutes 分钟作为兜底窗口
  4. 如果有 accounts_ref + groups：
     - 读取账号列表并按 group 筛选
     - 按 10 个一批分组（xAI API 限制）
     - 每批调一次 xAI x_search（prompt + allowed_x_handles）
  5. 如果没有 accounts_ref：
     - 直接调 xAI x_search（纯 prompt 搜索）
  6. 去重（同一条推文被多个 source 搜到时，合并而非丢弃）
  7. 如果有 pre_filter：
     - 正则黑名单匹配 → 命中则丢弃，记录日志
     - min_length 检查 → 太短则丢弃
  8. 如果 skip_judge = true：
     - 挂上 default_labels，跳过 Judge + Reactor，直接传给 Route 层
  9. 否则：传给 Judge 层
  10. 更新 last_seen（如果 use_last_seen=true）
```

### 加一个新搜索方向的体验

假设要加一个 "token-launch" 监控：

```yaml
# sources.yaml 加一段：
  - name: token-launch
    schedule: "*/10 * * * *"
    prompt: |
      搜索 Solana 上的新币发射、IDO、fair launch、
      代币迁移（pump.fun 毕业到 Raydium）。
```

完事。不改代码，不改其他文件。引擎下次执行时自动加载这个新 source，推文会走 Judge→Reactor→Route 流程。

---

## Layer 2: Judge（重不重要）

### 职责

对每条推文做一件事：**分级**。这条推文重不重要？多重要？

Judge **不决定怎么反应**（那是 Reactor 的事）。Judge 只回答：red / orange / yellow / none。

核心设计：**运营用自然语言写分级规则，LLM 执行判断，但输出被 schema 锁死。**

### 为什么用 LLM 做判断而不是规则匹配

传统做法是写规则：`if tweet.content.contains("hack") && tweet.likes > 100 then alertLevel = red`。

问题：
- 关键词匹配太死板：推文说"我们协议的安全审计完美通过"也会命中 "安全" 关键词
- 运营改规则要学 YAML 条件语法
- 语义理解做不了：一条推文是"正面讨论我们的产品"还是"在讽刺我们"，关键词分不清

LLM 判断的优势：
- 运营用自然语言写规则，零学习成本
- LLM 理解语义和上下文
- 同一套引擎可以处理任意复杂度的判断标准

风险——LLM 输出不可控？**用 output_schema 锁死。** LLM 只能输出预定义的枚举值，不能自由发挥。

### 配置格式

```yaml
# judge.yaml

# ── 分级规则（运营用自然语言写） ──
rules: |
  你是 Byreal 的社交媒体信号分析师。判断这条推文的重要程度。

  ## 警报级别（alertLevel）

  red — 需要立即关注：
  - 安全事件：exploit、hack、资金被盗、合约漏洞（涉及我们或 Solana 生态）
  - 负面舆情：大 V 公开批评 Byreal、用户投诉资金问题
  - 紧急机会：顶级 KOL 主动提到 Byreal 并等待回应

  orange — 重要但不紧急：
  - KOL 正面讨论 Byreal 产品或技术
  - 有人 @ 我们提问或请求合作
  - 行业重大动态（与我们业务直接相关）

  yellow — 值得关注：
  - 行业趋势讨论（与我们业务间接相关）
  - 竞品动态
  - 社区对我们产品的一般性讨论

  none — 不需要关注：
  - 无关闲聊、广告、spam
  - 纯价格讨论（"Solana 涨了"）
  - 转发没有附加评论
  - 抽奖、空投活动中 tag 我们的推文

# ── 输出 Schema（锁死） ──
output_schema:
  alertLevel:
    type: enum
    values: [red, orange, yellow, none]
    description: 警报级别

  reasoning:
    type: string
    max_length: 200
    description: 判断理由（给审批人看）
```

### 引擎怎么执行 Judge

```
for each tweet:
  1. 构造 LLM prompt:
     system = judge.yaml 的 rules
     user = "请判断这条推文：\n\n{tweet.content}\n\n作者：{tweet.author}（{tweet.author_followers} followers）"
  2. 调用 Claude API:
     - model: claude-haiku-4-5（快、便宜）
     - response_format: json_schema（用 output_schema 约束输出）
  3. LLM 返回:
     {
       "alertLevel": "orange",
       "reasoning": "Jupiter 官方账号宣布与 Byreal 集成"
     }
  4. 验证输出（双重防御）:
     a. json_schema 约束（API 层面）
     b. 应用层校验：enum 值是否合法、必填字段是否存在
     c. 校验失败 → 记录日志，仍然传递
  5. alertLevel = none → 丢弃（不进 Reactor，节省 LLM 调用）
  6. alertLevel ≠ none → 传给 Reactor 层
```

### 运营改分级标准的体验

**降噪**：最近有很多低质量的 "tag Byreal 参与抽奖" 推文被判为 orange。

```diff
  orange — 重要但不紧急：
  - KOL 正面讨论 Byreal 产品或技术
  - 有人 @ 我们提问或请求合作
+ - 注意：抽奖、空投活动中 tag 我们的推文不算 orange，归为 none
```

**升级**：新品发布期间，想把 Prop AMM 相关推文优先级拉高。

```diff
  orange — 重要但不紧急：
  - KOL 正面讨论 Byreal 产品或技术
+ - 【本月重点】任何提到 Prop AMM 的推文升级为 orange
```

改 judge.yaml 就行。不改代码，不改 reactor.yaml，不改路由。

---

## Layer 3: Reactor（怎么反应）

### 职责

对通过 Judge 的推文（alertLevel ≠ none）做两件事：
1. **决定动作类型**（reply / QRT / like / escalate）— schema 锁死，给路由用
2. **生成回复方向**（语气、角度、要点）— 自由文本，给下游 Generator 用

Reactor 的核心价值：**根据推文语境决定怎么回复**。同样是正面提及，一条正经的产品评测和一条 meme 帖需要完全不同的回复风格。这不是固定模板能解决的，需要 LLM 理解推文的调性后生成方向指导。

Reactor 和 Judge 分开的原因：
- **不同的上下文需求**：Judge 只需要推文内容就能分级；Reactor 需要品牌定位、互动历史、竞品关系
- **不同的修改频率**：分级标准相对稳定；反应策略随运营阶段频繁调整
- **节省成本**：alertLevel=none 的推文（大量噪声）不会进 Reactor

### 配置格式

```yaml
# reactor.yaml

# ── 品牌上下文（注入到 LLM prompt） ──
brand_context_ref: config/brand_context.md    # 引用品牌上下文文件

# ── 反应规则（运营用自然语言写） ──
rules: |
  你是 Byreal 的社交媒体运营策略师。根据推文内容和品牌上下文，
  决定我们应该怎么反应，以及用什么语气和角度。

  ## 建议动作（suggestedAction）

  reply_supportive — 发一条支持性回复：
  - 有人正面讨论我们的 CLMM、RFQ、Real Farmer 产品
  - 有人分享使用 Byreal 的经验
  - 生态合作伙伴宣布与我们的集成

  qrt_positioning — 引用转发，展示我们的立场：
  - 行业趋势讨论（RWA、CeFi→DeFi 融合），我们有独特角度
  - 竞品动态，我们可以差异化定位（深度流动性 vs 纯路由）
  - 关于 Solana DeFi 流动性的深度分析

  like_only — 只点赞，不回复：
  - 正面提及但不需要对话
  - 信息量低，点赞表示知道了

  escalate_internal — 升级到内部讨论：
  - 需要团队决策的合作邀请
  - 需要法务/公关介入的敏感话题（RWA 监管相关）
  - 大额 LP 的公开反馈

  none — 不做任何操作：
  - 值得关注但不需要我们参与的行业信息

  ## 语气（tones）

  根据推文的调性，提供 2-3 个候选语气供 Generator 选择：
  - official — 官方公告、合作声明、正式场合
  - casual — 日常互动、社区对话
  - meme — meme 帖、CT 风格、degen 文化，要融入不要端着
  - technical — 技术讨论、产品细节、架构分析
  - empathetic — 用户遇到问题、负面情绪、需要安抚

  每个 tone 选项包含 id、label、description，让 Generator 理解每种语气的意图。

  ## 回复角度（replyAngle）

  用 1-2 句话描述回复的切入角度和要点。
  这是给 Generator 的创作方向，不是最终文案。
  要具体，比如：
  - "用轻松的口吻回应这个 meme，顺便提一句我们的 Real Farmer 让 LP 不用自己盯盘"
  - "感谢 Jupiter 团队，强调这次集成对用户的好处（更深的流动性 + 更低滑点）"
  - "这是个技术贴，用数据回应：我们的 RFQ 层在大单交易上比纯 AMM 滑点低 X%"

# ── 输出 Schema ──
output_schema:
  suggestedAction:
    type: enum
    values: [reply_supportive, qrt_positioning, like_only, escalate_internal, none]
    description: 动作类型（schema 锁死，给路由用）

  tones:
    type: array
    min_items: 1
    max_items: 3
    item_fields: [id, label, description]
    description: "2-3 tone options for the Generator"

  replyAngle:
    type: string
    max_length: 300
    description: 回复的切入角度和要点（自由文本，给 Generator 用）
```

### 引擎怎么执行 Reactor

```
for each tweet (alertLevel ≠ none):
  1. 构造 LLM prompt:
     system = reactor.yaml 的 rules + brand_context（品牌定位、产品信息）
     user = "推文：{tweet.content}\n作者：{tweet.author}\nJudge 判断：{alertLevel}, {reasoning}"
  2. 调用 Claude API:
     - model: claude-haiku-4-5
     - response_format: json_schema
  3. LLM 返回:
     {
       "suggestedAction": "reply_supportive",
       "tones": [
         {"id": "meme", "label": "CT Meme", "description": "Match degen energy, short punchy reply"},
         {"id": "casual", "label": "Casual", "description": "Friendly conversational tone"}
       ],
       "replyAngle": "这个帖子是 CT 风格的 meme，用 degen 语气回应，
                      提一句我们的 Real Farmer 让 LP 躺着赚，不用自己盯盘"
     }
  4. 校验输出（suggestedAction 必须在 enum 内，tones 数组 1-3 项且每项含 id/label/description）
  5. 合并结果:
     {
       alertLevel: "orange",               ← 来自 Judge
       suggestedAction: "reply_supportive", ← 来自 Reactor（给路由用）
       tones: [{...}, {...}],              ← 来自 Reactor（给 Generator 用）
       replyAngle: "..."                   ← 来自 Reactor（给 Generator 用）
     }
  6. 传给 Route 层
     Route 用 alertLevel + suggestedAction 决定发到哪个频道
     Generator 用 tones + replyAngle 生成具体回复文案
```

### Reactor vs Generator 的分工

| | Reactor | Generator |
|---|---------|-----------|
| 决定什么 | 做什么（action）、怎么做（tones + angle） | 具体文案 |
| 输入 | 推文 + Judge 结果 + 品牌上下文 | Reactor 输出 + 品牌语料库 |
| 输出 | 方向指导（1-2 句话） | 完整的推文草稿 |
| 运营改什么 | reactor.yaml 的规则（什么场景用什么语气） | Generator 的 prompt / 语料库 |

### 运营改反应策略的体验

调整语气匹配规则：

```diff
  ## 语气（tones）
  - meme — meme 帖、CT 风格、degen 文化，要融入不要端着
+ - 注意：即使是 meme 语气，也不要用 🚀 和 "LFG"，我们的品牌调性是"专业但不无聊"
```

调整竞品回复角度：

```diff
  ## 回复角度（replyAngle）
+ - 当竞品（Orca/Raydium）发布 LP 激励时，不要直接对比 APR 数字，
+   而是强调 Real Farmer 的透明度优势（链上可见 PnL）
```

改 reactor.yaml 就行，不碰 judge.yaml（分级标准不变），不碰代码。

---

## Layer 4: Route（发到哪）

### 职责

根据推文身上的标签组合，确定性地路由到 Discord 频道。

这一层是纯机械的——标签进来，频道出去，没有模糊判断。

### 配置格式

```yaml
# routing.yaml

routing:
  # ── 兜底 ──
  default:
    channel: noise

  # ── 路由规则（Action-first 单路由，每条信号只进一个频道） ──
  # urgency 通过 embed 颜色（红/橙/黄）表达，不再用 tier 频道
  routes:
    - match: { suggestedAction: reply_supportive }
      channel: needs-reply

    - match: { suggestedAction: qrt_positioning }
      channel: needs-qrt

    - match: { suggestedAction: escalate_internal }
      channel: escalation

    - match: { suggestedAction: like_only }
      channel: engagement

    # suggestedAction: none → 兜底到 noise

  # ── 发送去重 ──
  dedup_key: [tweet_id, channel]
```

### 路由匹配机制

借鉴 Alertmanager 的 routing tree（详见 [architecture-patterns-research.md](./architecture-patterns-research.md) 第 5 节）：

**基本规则：Action-first 单路由，每条信号只进一个频道。**

```
推文标签: { alertLevel: orange, suggestedAction: reply_supportive }
          （alertLevel 来自 Judge, suggestedAction 来自 Reactor）

规则 1: match suggestedAction=reply_supportive → 匹配！发到 needs-reply → 停止

结果: 这条推文发到 needs-reply（单发），embed 颜色为橙色表示 urgency
```

**`continue` 的作用**（保留能力但当前路由不使用）：

没有 `continue` = iptables 语义（first-match-wins，命中就停）。
有 `continue: true` = 命中后继续匹配下一条，实现一条推文发到多个频道。

典型用法：tier 路由加 `continue`（需要双发），action 路由不加（只发一次）。

### match 语法

```yaml
# 精确匹配
match: { alertLevel: red }

# 多值匹配（OR）
match: { suggestedAction: [reply_supportive, qrt_positioning] }

# 多字段匹配（AND）
match: { alertLevel: red, suggestedAction: escalate_internal }

# 否定匹配
match_not: { suggestedAction: none }
```

表达力故意限制在 AND/OR 级别，不支持嵌套条件。原因：路由层应该是机械的，复杂判断交给 Judge/Reactor 的 LLM。

---

## 整体数据流示例

一条推文从搜索到通知的完整路径：

```
1. Source 层
   source "ecosystem" 的 cron 触发
   xAI x_search 搜索 → 返回一条推文:
   {
     id: "1234",
     author: "@jupiter_exchange",
     content: "Excited to integrate with @byreal_io's CLMM vaults!
               New concentrated liquidity strategies coming soon.",
     likes: 892,
     retweets: 156
   }

2. Judge 层
   LLM 读 judge.yaml 的分级规则，判断重要程度:
   输出:
   {
     alertLevel: "orange",      ← KOL 正面提到我们，重要但不紧急
     reasoning: "Jupiter 官方账号宣布与 Byreal 集成"
   }
   alertLevel ≠ none → 进入 Reactor

3. Reactor 层
   LLM 读 reactor.yaml 的反应规则 + 品牌上下文，决定怎么反应:
   输出:
   {
     suggestedAction: "reply_supportive",
     tones: [
       {"id": "casual", "label": "Casual", "description": "Friendly conversational tone, warm but not overly formal"},
       {"id": "official", "label": "Official", "description": "Professional partnership announcement tone"}
     ],
     replyAngle: "感谢 Jupiter 团队，强调集成对用户的好处：
                  更深流动性 + 大单交易更低滑点，语气友好但不过于正式"
   }
   合并结果:
   {
     alertLevel: "orange",
     suggestedAction: "reply_supportive",
     tones: [{...}, {...}],
     replyAngle: "..."
   }

4. Route 层
   遍历路由表:
   - match suggestedAction=reply_supportive → 匹配！→ needs-reply → 停止

   结果: 发到 #needs-reply（embed 颜色为橙色）

5. 下游
   #needs-reply 频道生成回复草稿卡片，运营审批后发送
```

---

## 引擎层设计

### 文件结构

```
engine/
├── index.ts              # createEngine() 工厂、cron 编排、热加载
├── pipeline.ts           # processSource() 主流程
├── searcher.ts           # xAI Responses API 调用、分批(10/批)、去重、last_seen 追踪
├── judge.ts              # Claude API 调用、分级 prompt 构造、schema 校验、none 过滤
├── reactor.ts            # Claude API 调用、品牌上下文注入、tones 数组生成
├── router.ts             # 路由匹配(continue/stop)、确定性路由
├── enrichment.ts         # 兼容保留：旧富化路径，生产默认关闭
├── config-loader.ts      # YAML 解析、校验、模板变量、Generator 配置
├── output-schema.ts      # LLM 输出校验（enum/string/array 三种字段类型）
├── cron.ts               # node-cron 封装、source→cron job 映射
└── types.ts              # 共享类型定义（AlertLevel, SuggestedAction, ToneItem, etc.）

generator/
└── draft.ts              # 按需草稿生成（Discord 按钮触发，非 pipeline 内）

db/
├── index.ts              # SQLite 查询、v4↔v5 字段映射、insertV5Signal
├── migrate.ts            # 渐进式迁移（v4→v5、兼容 enrichment）
└── schema.sql            # 完整表定义（含 v5 字段）

config/
├── sources.yaml          # 搜索方向 + 调度
├── judge.yaml            # 分级规则 + output_schema
├── reactor.yaml          # 反应规则 + brand_context_ref + tones array schema
├── routing.yaml          # action→channel 映射
├── enrichment.yaml       # 兼容保留：旧富化配置
├── generator.yaml        # 草稿生成模型/温度/max_tokens
└── accounts.yaml         # 监控账号分组
```

### 引擎职责边界

| 引擎做 | 配置做 |
|--------|--------|
| xAI API 调用 + 分批 + rate limit | 搜什么（prompt, accounts, schedule） |
| Claude API 调用 + schema 校验（Judge） | 怎么分级（自然语言规则 + output_schema） |
| Claude API 调用 + 上下文注入（Reactor） | 怎么反应（自然语言规则 + 品牌上下文） |
| 路由规则匹配 + Discord 发送 | 发到哪（match → channel 映射） |
| 去重、last_seen 追踪、错误重试 | — |

### 引擎不做什么

- 不包含分级逻辑（什么算 red — 全在 judge.yaml）
- 不包含反应逻辑（什么时候回复/QRT — 全在 reactor.yaml）
- 不包含搜索策略逻辑（搜什么关键词、搜谁 — 全在 sources.yaml）
- 不包含路由逻辑（什么标签去什么频道 — 全在 routing.yaml）

### 引擎做什么（诚实说明）

引擎不是零业务的"通用执行器"——它包含具体的技术逻辑：

- **searcher.ts**：xAI API 的 10-handle 分批、last_seen 时间窗口追踪、content hash 去重、pre_filter 正则匹配
- **judge.ts**：Claude API 的 batch 调用（5 条/批）、json_schema 构造、输出校验、none 过滤
- **reactor.ts**：Claude API 调用、品牌上下文注入（从 brand_context_ref 加载）、json_schema 构造
- **router.ts**：continue/stop 语义的路由遍历、(tweet_id, channel) 去重
- **config-loader.ts**：跨文件引用解析（accounts_ref、brand_context_ref → 文件读取）、模板变量替换

这些技术逻辑是固定的（和业务无关），但需要开发者维护。改搜什么/怎么分级/怎么反应/发到哪不碰代码，改 xAI 分批策略或 LLM 调用方式需要碰代码。

---

## 配置校验

YAML 没有类型检查，需要引擎在加载时校验：

```
sources.yaml:
  - 每个 source 必须有 name, schedule, prompt
  - schedule 必须是合法 cron 表达式
  - accounts_ref 引用的文件必须存在
  - name 不能重复
  - skip_judge=true 时必须有 default_labels

judge.yaml:
  - output_schema 的每个字段必须有 type 和 values
  - rules 不能为空

reactor.yaml:
  - output_schema 的每个字段必须有 type 和 values
  - rules 不能为空
  - brand_context_ref 引用的文件必须存在

routing.yaml:
  - match 中的字段名必须存在于 judge 或 reactor 的 output_schema
  - match 中的值必须存在于对应 output_schema 的 values
  - 至少有一条 route
  - default 必须存在
```

校验失败 → 启动时报错，拒绝加载。不会带着错误配置运行。

---

## 和之前方案的关系

| 文档 | 状态 | 说明 |
|------|------|------|
| strategy-as-prompt-architecture.md | 废弃 | 被 3 轮讨论否决 |
| strategy-module-architecture.md | 废弃 | 被本文档取代 |
| architecture-patterns-research.md | 保留 | 本文档的调研依据（7 种模式对比） |
| **signal-pipeline-architecture.md** | **当前** | 本文档 |

### 关键演进

```
v1: Strategy-as-Prompt（纯 .md 定义策略）
    → 否决：路由和过滤无法声明式表达

v2: Strategy-as-Module（TS + YAML + MD）
    → 否决：每个策略一个 TS 文件，路由仍是代码，运营不友好

v3: Label + TCA（Alertmanager 风格）
    → 部分采纳：路由层的参照模型正确

v4: Signal Pipeline（本方案）
    → 在 v3 基础上，把 Judge 层从"YAML 规则匹配"改为"LLM + 锁死 schema"
    → 运营用自然语言配置判断标准，零学习成本

v4.1: Review 修订
    → 3-agent review 后修正 8 个 P0/P1 问题
    → 加 pre_filter 层、skip_judge、cron 调度、调试工具

v5: 四层架构（当前）
    → Judge 拆为 Judge（分级）+ Reactor（反应）
    → 移除 source label 路由（不按搜索来源路由）
    → Reactor 引入品牌上下文，反应策略独立配置
    → 引擎 ~720 行
```

---

## 成本估算

基于当前搜索频率和推文量的月成本（优化后）：

| 项目 | 月成本 | 占比 | 说明 |
|------|--------|------|------|
| xAI x_search | ~$600+ | ~65% | 10 个 source × 各自频率，$5/1000 calls；账号类 source 按 10 handle/批调用 |
| Claude Judge (Haiku) | ~$100 | ~11% | 批量判断(5条/批) + pre_filter 过滤垃圾后 |
| Claude Reactor (Haiku) | ~$70 | ~8% | 只处理 alertLevel≠none 的推文（约 Judge 量的 60-70%） |
| 其他（DB、服务器） | ~$0 | — | SQLite 本地，已有服务器 |
| **总计** | **~$800** | | 随账号组数量增长 |

**Sources 概览（10 个）**：
direct-mentions(15m), indirect-mentions(15m), trend-keywords(30m),
ecosystem-core(30m), fireside-speakers(60m), top-dapps(30m),
solana-kols(30m), signal-news-data(30m), key-devs(30m), top-traders(30m), crisis(5m)

**成本优化手段（已设计在架构中）**：
- `use_last_seen`：增量拉取，避免重复处理历史推文，大幅减少 xAI 调用量
- `pre_filter`：正则/黑名单过滤垃圾推文，减少 Judge LLM 调用量
- **Judge 过滤 none**：大量噪声推文在 Judge 层就被丢弃，不进 Reactor
- 批量判断：5 条推文打包成一个 LLM 调用（Judge 和 Reactor 都支持）
- Haiku 模型：最便宜的 Claude 模型，足够做分级和反应决策

---

## 运营调试工具

### Discord 命令

| 命令 | 功能 | 用途 |
|------|------|------|
| `/config test <source_name>` | 立即执行一个 source，返回搜索结果 + Judge 判断 | 验证配置改动是否生效 |
| `/config reload` | 重新加载所有 YAML 配置 | 改完配置后立即生效（不用等下一轮 cron） |
| `/config status` | 显示每个 source 的最近执行时间、推文数、错误 | 日常巡检 |
| `/config dry-run <tweet_url>` | 对指定推文跑一次 Judge，返回标签结果 | 调试判断规则 |

### `/config test` 设计

```
用户: /config test ecosystem
系统:
  ✅ Source "ecosystem" 已触发
  📊 搜索到 12 条推文（pre_filter 过滤了 3 条）
  🏷️ Judge → 9 条通过（3 条判为 none 丢弃）
  ⚡ Reactor → 6 条有动作建议:
    - @jupiter_exchange: orange → reply_supportive (casual)
    - @orca_so: yellow → like_only
    - ...（前 5 条预览）
  ⏱️ 耗时 5.1s，LLM 调用 4 次（Judge 2 + Reactor 2）
```

这是运营日常最重要的工具——改完 YAML 后用 `/config test` 验证，确认无误再 `/config reload`。

---

## 迁移方案

从现有 593 行 collect.ts + 213 行 classify.ts + 163 行 router.ts 迁移到新架构。

### 三阶段迁移（8-12 天）

| 阶段 | 天数 | 做什么 | 验证 |
|------|------|--------|------|
| **Phase 1: 引擎骨架** | 3-4 天 | config-loader + types + cron + searcher（复用现有 xai-search adapter） | `/config test` 能搜到推文 |
| **Phase 2: Judge + Reactor + Router** | 4-5 天 | judge.ts + reactor.ts + router.ts + 四个 YAML 配置文件 | 端到端：搜索→分级→反应→发到 Discord |
| **Phase 3: 平滑切换** | 2-4 天 | 新旧双跑对比 → 关旧 → 清理旧代码 | 新架构独立运行 72 小时无 P0 |

### DB 迁移

signals 表现有 `pipeline` 字段 → 保留，新增 `source_name` 字段。历史数据的 `pipeline` 值映射为 `source_name`（mentions→mentions, network→ecosystem, trends→narratives, crisis→crisis）。

---

## Open Questions（已更新）

~~1. Judge 的成本控制~~ → 已解决：pre_filter + skip_judge + 批量判断 + Haiku，估算 ~$90/月
~~2. 配置热加载~~ → 已解决：`/config reload` Discord 命令 + 每轮 cron 执行前重读配置
3. **Judge 的一致性**：同一条推文，两次 LLM 调用可能给出不同判断。方案：判断结果存 DB，同一条推文只判断一次（按 tweet_id 去重）
4. **accounts.yaml 的 tag 系统**：tag 应该定义在 accounts.yaml 里。tag 可以注入到 Judge 的 prompt 中（"来自 partner tag 的推文优先级更高"），也可以直接作为标签用于路由

---

## v2 待做（不在 v1 范围）

| 项目 | 优先级 | 说明 |
|------|--------|------|
| inhibit 规则 | P2 | 高可信度分类压掉低可信度的重复判断 |
| group_by 分组 | P2 | 短时间内同类信号合并为摘要通知 |
| 配置文件版本化 | P3 | YAML 变更的 git 历史追踪 |
| A/B 测试 Judge 规则 | P3 | 新旧 rules 同时跑，对比分类质量 |
| 多 LLM 后端 | P3 | Judge 层支持 Claude 以外的模型 |
