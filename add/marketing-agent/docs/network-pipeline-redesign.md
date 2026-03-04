# Network Pipeline 重构设计文档

> 状态：设计定稿 | 日期：2026-03-01 | 作者：James

---

## 1. 背景与问题

当前 network pipeline 的问题：

1. **查询逻辑过死**：用 `(from:handle) AND ("keyword1" OR "keyword2")` 的 AND 逻辑，keyword 是手动写死在 accounts.yaml 里的静态猜测
2. **与 mentions pipeline 重复采集**：keyword 里包含 "Byreal" 等品牌词，而这些推文 mentions pipeline 已经覆盖
3. **高价值推文被漏掉**：合作伙伴发的没命中精确 keyword 的推文（但可能热度很高或值得互动）被过滤掉
4. **Tier 定义不清**：S/A/B 三层混淆了"自己人"、"母公司"、"生态伙伴"、"竞品"，没有统一的判定标准
5. **`-filter:replies` 过滤掉了有价值的回复线程讨论**
6. **config.yaml 与 accounts.yaml 两套配置不同步**：config.yaml 有 38 个账户，accounts.yaml 只有 16 个

当前系统数据：
- @byreal_io 实际关注 185 个账户
- config.yaml 只覆盖 38 个
- accounts.yaml（network pipeline 专用）只覆盖 16 个

---

## 2. Tier 定义

### 2.1 分层原则

**唯一判定维度：互动价值**（不按关系亲疏、不按合作协议）

决策树：
```
是我们自己的号？ → O
深度合作伙伴，需要持续互动维护关系？ → S
互动能赚曝光/转化/好感？ → A
需要监控他在干什么？ → B
偶尔有用？ → C
以上都不是 → 不追踪
```

### 2.2 五层定义

**O — Own（自己人）**
- 定义：Byreal 员工或官方运营的账号
- 目的：知道团队发了什么，内容协同 + 危机感知
- 判定问题："这是我们的号吗？"
- 当前账户：emilyRioFreeman（byreal_io 是自身，不在 following 列表）

**S — Strategic（深度合作）**
- 定义：有深度合作关系的伙伴 — 不仅是公开 support，更是业务层面的持续协同（母公司、链级别合作、核心基础设施）
- 目的：关系维护 + 协同传播 + 展示生态联盟
- 判定问题："我们和这个账户有深度合作关系，需要持续互动吗？"

- 当前账户：Bybit_Official, Alpha_Bybit, benbybit, Bybit_WSOT, Bybit_ZH, BybitEU, BybitPlus, Mantle_Official, 0xMantleCN, SolanaFndn, xStocksFi（共 11 个）

**A — Alliance（互动赚价值）**
- 定义：互动能产生曝光、转化或社区好感的账户
- 目的：借势传播，社区建设
- 判定问题："互动能赚到曝光/转化/好感吗？"
- 注意：不管有没有正式合作关系，只看互动价值。一个没合作但百万粉的 KOL 发了相关内容 = A
- 当前估计 ~85 个账户（产品集成伙伴、友好 KOL、Superteam 系列、生态合作项目等）

**B — Benchmark（监控为主）**
- 定义：同赛道直接竞品，需要知道他们在干什么
- 目的：竞品情报，不公开互动
- 判定问题："需要监控他在干什么吗？"
- 当前账户：JupiterExchange, Raydium, MeteoraAG, orca_so, jito_sol, kamino, SonicSVM, aave, 1inch, monad, ethereum（共 ~11 个）

**C — Context（信号源）**
- 定义：偶尔有用的信号源，包括数据平台、基础设施、媒体
- 目的：当他们的内容涉及我们或赛道重要事件时，选择性互动
- 判定问题："他的内容可能在某个时刻值得我们回应吗？"
- 当前估计 ~80 个账户（DefiLlama, Cointelegraph, phantom 等）

### 2.3 规模预估

| Tier | 当前 | 未来（200+）|
|------|------|------------|
| O | 1 | 3-5 |
| S | 11 | 8-15 |
| A | ~85 | 50-80 |
| B | ~11 | 20-40 |
| C | ~80 | 50-80 |

---

## 3. 采集规则

### 3.1 查询策略

| Tier | 查询方式 | 轮询频率 |
|------|---------|---------|
| O | `from:handle`（全量） | 30 min |
| S | `from:handle`（全量，无 keyword） | 10 min |
| A | `from:handle`（全量） | 30 min |
| B | `from:handle AND (事件词)` | 1 hour |
| C | `from:handle AND (事件词)` | 1 hour |

### 3.2 预过滤（classifier 之前，零 API 成本）

所有 Tier 统一过滤纯 RT（retweet）。

| Tier | 预过滤规则 |
|------|-----------|
| O | 去纯 RT |
| S | 去纯 RT |
| A | 去纯 RT → **热度门槛**（likes≥10 OR retweets≥5 OR views≥1000） |
| B | 去纯 RT + 去 <10 字推文 |
| C | 去纯 RT + 去 <10 字推文 → **热度门槛**（likes≥10 OR retweets≥5 OR views≥1000） |

热度门槛说明：
- 当前采用固定值（方案 3），先跑起来再调
- 未来可升级为按粉丝数互动率或按账户历史相对热度
- A-tier 被主动 tag 的推文走 mentions pipeline，不需要 network 覆盖；network 只抓"没提到我们但热度高"的内容

### 3.3 B-tier 事件词（统一）

```
launch, airdrop, incentives, fee, exploit, incident, partnership,
integration, v3, routing, vault, liquidity program, points, rebate,
margin, listing
```

### 3.4 C-tier 事件词（按子类）

- 数据平台：`ranking, top, TVL, volume, Byreal`
- 基础设施/钱包：`Solana, update, launch, integration`
- 媒体：`Solana, DEX, DeFi, Bybit`

### 3.5 `-filter:replies`

所有 Tier 均不使用 `-filter:replies`，以保留有价值的回复线程讨论。

---

## 4. 分类规则

### 4.1 分类策略

| Tier | 是否分类 | 模型 | Prompt 重点 |
|------|---------|------|------------|

NK|| S | 完整分类 | Sonnet | "这是深度合作伙伴。默认互动，积极 support + 协同传播，只有完全无关才 skip"
| A | 完整分类 | Sonnet | "这条推文已通过热度门槛。评估：互动能带来曝光/好感吗？" |
| B | 简化分类 | Haiku（可选） | "只判断：有情报价值吗？monitor 或 skip" |
| C | 简化分类 | Haiku（可选） | "只在数据引用我们或话题高度相关时建议互动" |

### 4.2 Action 类型及选择逻辑

可选 action：`reply`, `qrt`, `like`, `monitor`, `skip`

**reply vs qrt 的核心区别：**
- **qrt（借势）**：这条推文对我们有价值，转发到我们的 timeline 能给我们带来曝光/叙事关联。内容进**我们的**粉丝圈
- **reply（站台）**：我们有话说但不值得转发，表态支持/加入讨论/补充观点。内容留在**对方的**推文下

Classifier 选择标准：

```
选 qrt 当：
- 对方发了里程碑/公告/数据，我们转发能关联自己的叙事
- 对方的话题正在热，我们参与能蹭到流量
- 我们有独特的观点/数据可以补充

选 reply 当：
- 表达支持/祝贺，但内容不值得进我们 timeline
- 对方在讨论/提问，我们加入对话
- 互动本身是目的（关系维护），不是传播
```

### 4.3 各 Tier 的 Action 倾向

| Tier | qrt | reply | like | monitor | skip |
|------|-----|-------|------|---------|------|
| O | — | — | — | — | store |
SX|| S | 有借势价值时 | 常用，support + 讨论 | 无话可说但想表态时 | 敏感/争议时 | 仅完全无关
| A | 有借势价值时 | 有话说时 | 轻度支持 | 不确定时 | 无互动价值 |
| B | 不适用 | 不适用 | 不适用 | 默认 | 无情报价值 |
| C | 偶尔（数据引用我们时） | 偶尔 | 偶尔 | — | 默认 |

---

## 5. 通知路由

| Tier | reply/qrt | like | monitor | skip |
|------|-----------|------|---------|------|
| O | — | — | — | #own-activity |
| S | #needs-interaction | #needs-interaction | #tier1-signals | #noise |
| A | #needs-interaction | #needs-interaction | 不通知 | 不通知 |
| B | — | — | #competitor-intel | 不通知 |
| C | #signals | #signals | 不通知 | 不通知 |

---

## 6. Pipeline 边界与去重

### 6.1 与其他 Pipeline 的关系

| Pipeline | 职责 | 边界 |
|----------|------|------|
| mentions | 任何人提到 Byreal（品牌/handle/产品名） | 品牌被提及 = mentions 管 |
| crisis | 危机事件检测 | risk_keywords 触发 |
| network | 被追踪账户的推文（即使没提 Byreal） | 账户行为 = network 管 |
| trends | 赛道趋势/热点话题 | 话题趋势 = trends 管 |

### 6.2 去重规则

同一条推文可能命中多个 pipeline。处理方式：
- 分类结果按 pipeline 分别存储（不互相覆盖）
- 加 `finalAction` 字段，按优先级裁决：**crisis > mentions > network > trends**
- 通知按 `finalAction` 路由，**同一推文只发一条通知**

### 6.3 具体场景

| 场景 | 处理 |
|------|------|
| S-tier 推文提到 "Byreal" | mentions + network 都命中。mentions 优先，network 的分类结果保留但不重复通知 |
| 任何 tier 推文含 risk_keywords | 额外触发 crisis pipeline，crisis 优先级最高 |
| A-tier 推文主动 tag @byreal_io | 走 mentions pipeline，network 不需要覆盖（mentions 已处理） |

---

## 7. Mentions Pipeline 增强：社区互动分类

### 7.1 背景

热心用户（社区成员）提到 Byreal 的推文走 mentions pipeline，不需要 network 追踪。但当前 mentions 分类不区分"合作伙伴提到我们"和"社区用户在讨论我们"，运营团队无法看到社区声量。

### 7.2 新增 `source_type` 字段

在 mentions pipeline 的分类结果中增加 `source_type` 字段，**不依赖 LLM**，用代码在分类前判断：

```
发推人 handle 在 accounts.yaml 任何 tier 中？ → "partner"
发推人粉丝数 > 10,000？ → "kol"
都不是 → "community"
```

零额外 API 成本。

### 7.3 通知路由

| source_type | 通知频道 |
|-------------|---------|
| partner | 按原有规则路由（#needs-reply 等） |
| kol | 按原有规则路由（#needs-reply 等） |
| community | **#community-love**（新频道） |

#community-love 频道用途：
- 展示社区声量，运营团队浏览即可
- 不要求每条都回复，挑优质内容互动
- 可用于周报统计社区活跃度

---

## 8. 健康度指标

| Tier | 正常 skip 率 | 告警阈值 | 告警含义 |
|------|-------------|---------|---------|
| O | N/A | N/A | 不分类 |
| S | 30-40% | >60% | 全量采集，部分无关正常 |
| A | 40-60% | >80% | 热度门槛后还高 skip，门槛太低 |
| B | 50-70% | >90% | 事件词后高 skip，词太宽 |
| C | 60-80% | >95% | 正常偏高，太高则没追踪价值 |

---

## 9. 成本估算

基于 185 个账户：

| 组件 | 单价 | 当前（16 账户） | 重构后（185 账户） |
|------|------|----------------|-------------------|
| XAI 搜索 | ~$0.0005/查询 | ~$2/月 | ~$12/月 |
| Claude Sonnet 分类 | ~$0.035/batch(10条) | ~$7.5/月 | ~$44/月 |
| **月总计** | | **~$10/月** | **~$56/月** |

极端峰值日成本不超 $1.5/天。

### 成本控制

- 日常预算：$2/天
- 日告警阈值：$1.5/天
- 月预算：$60/月
- 建议启用 Anthropic Prompt Caching（月省 ~15-20%）
- B/C tier 可用 Haiku 降成本（月省 ~$5-8）

---

## 10. 已知的技术债务

| 问题 | 优先级 | 说明 |
|------|--------|------|
| `last_seen_keywords` 时间戳互相干扰 | P0 | collect.ts 的 `withQuery()` 把所有 pipeline 查询塞进 keyword 路径，共享同一个 last_seen key，导致不同 pipeline 的时间窗口互相覆盖 |
| config.yaml 与 accounts.yaml 不同步 | P0 | 两套配置 38 vs 16 个账户，分类逻辑矛盾 |
| 查询长度限制 | P1 | 185 个账户需要拆分成多个查询（XAI adapter MAX_HANDLES_PER_CALL=10），需要重写查询构建逻辑 |
| 差异化轮询频率 | P1 | 当前所有 pipeline 共用同一个 10min 轮询间隔，需要支持 per-tier 频率 |
| Pipeline 去重 | P1 | 当前无 finalAction 聚合器，同一推文可能在不同 Discord 频道产生矛盾通知 |

---

## 11. 未来升级路线图

### Phase 1 — 半自动化（1-2 周）

- 基于历史分类数据自动推荐 keyword 调整
- 僵尸账户检测（30 天无有价值推文，建议降级/移除）
- 人工 approve/reject 写入 reviews 表，每周更新 classifier few-shot 样例

### Phase 2 — 动态适应（1-2 月）

- 热度门槛从固定值升级为按账户历史相对热度
- 账户健康度评分（skip 率 / accept 率 / 活跃度）
- 自动 tier 建议（A 和 B/C 之间可自动流动，S 受保护名单保护，只能手动降级）

### Phase 3 — 智能发现（3 月+）

- 自动发现新的值得追踪的账户（从高价值推文的互动对象中提取候选）
- 趋势突增检测（burst detection）+ 提前介入建议
