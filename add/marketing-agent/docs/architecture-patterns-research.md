# 信号处理架构模式调研

> Date: 2026-03-05
> Status: Complete
> Purpose: 为 Marketing Agent 重构选择最佳架构模式
> 注：这是重构前的方案调研文档，当前落地实现请以 `README.md`、`docs/operations-guide.md`、`docs/signal-pipeline-architecture.md` 为准

## 我们要解决的问题

Marketing Agent 的核心流程：

```
定时触发 → 搜索推文(xAI) → 过滤 → 分类(LLM) → 路由到 Discord 频道 → 生成回复草稿
```

当前这个流程被拆成 4 个硬编码 pipeline（mentions/network/trends/crisis），每个 pipeline 的搜索逻辑、过滤条件、路由规则散落在 collect.ts（593行）、classify.ts（213行）、router.ts（163行）里。加一个搜索方向要改 4 个文件。

重构目标：让运营人员能通过配置（不碰代码）来增删搜索方向、调整过滤条件和路由规则。

### 约束条件

- 底层搜索 API 是 xAI x_search：prompt 驱动，原生参数只有 `allowed_x_handles`（最多 10 个）和 `from_date/to_date`
- 分类用 LLM（Claude），输出结构化标签（alertLevel, suggestedAction 等）
- 通知目标是 Discord 频道
- 规则规模小（约 30 条）
- 需要运营能在 Discord 里调整配置
- 可维护性重要：未来有运营人员，但开发者也要能快速理解和调试

---

## 7 种候选模式

### 1. 专业社媒监控工具架构（Brandwatch / Sprout Social）

#### 怎么运作

Brandwatch 的监控系统分三层：

**搜索层：Boolean Query Builder**

用户不写代码，而是用 Boolean 表达式定义"我要搜什么"。Brandwatch 提供 22 种操作符：

```
("Byreal" OR "@byreal_io" OR "byreal.io")
AND (DeFi OR Solana OR DEX)
AND NOT (spam OR giveaway)
AND lang:en
```

Sprout Social 更进一步，提供 GUI 化的分组构建器：把关键词拖进"品牌词组"、"行业词组"、"排除词组"，系统自动生成 Boolean 查询。

**分类层：多标签 Categories**

搜索命中的内容不放进"文件夹"（互斥），而是打"标签"（不互斥）。一条推文可以同时是 `#品牌提及` + `#正面情感` + `#KOL发布`。

分类规则也是 Boolean：`IF content contains "hack" AND sentiment = negative THEN add tag "crisis"`。

**路由层：Alert Rules**

基于标签组合触发通知：`IF tags include "crisis" AND "high-engagement" THEN email + Slack + SMS`。

#### 为什么适合/不适合

**可借鉴的**：
- "搜索方向 = 一个 query 配置"的思路。我们的每个 source 本质上就是一个搜索查询定义
- 多标签不互斥的分类模型。一条推文可以同时触发 mentions 和 crisis

**不适合的**：
- 我们的搜索不是 Boolean 查询，是 prompt 驱动的 AI 搜索。Brandwatch 的 `AND/OR/NOT` 语法对我们没用
- 我们不需要 GUI Query Builder（单人团队，YAML 就够）
- SaaS 工具的架构是为多租户设计的，我们是单实例

**场景评分：3/5** — 概念可借鉴，实现方式不匹配。

---

### 2. Rule Engine / Policy Engine（Drools / OPA / iptables）

#### 怎么运作

规则引擎的核心思想：**把业务决策从代码里抽出来，用声明式规则表达。**

三种典型模式：

**Drools（企业级规则引擎）**

规则用 DRL 语言写，引擎用 RETE 算法高效匹配：

```drools
rule "Crisis High Priority"
  salience 100                    // 优先级
  when
    $signal: Signal(
      alertLevel == "red",
      source == "crisis"
    )
  then
    $signal.setChannel("tier1-signals");
    $signal.setNotifyUrgent(true);
end
```

多条规则同时匹配时，用 `salience`（数值优先级）、recency（最近插入的优先）、specificity（更具体的优先）来解决冲突。

**OPA / Rego（策略即代码）**

用函数式语言 Rego 写策略，返回 allow/deny：

```rego
allow {
  input.alertLevel == "red"
  input.source == "crisis"
}

channel = "tier1-signals" {
  allow
}
```

没有冲突问题——策略返回的是布尔值集合，调用方自己决定怎么合并。

**iptables / nftables（Linux 防火墙规则链）**

规则按顺序线性执行，**first-match-wins**：

```
chain input {
  # 规则从上往下匹配，命中就停止
  ip saddr 10.0.0.0/8 accept      # 内网放行
  tcp dport 80 accept              # HTTP 放行
  tcp dport 443 accept             # HTTPS 放行
  drop                             # 其余全部丢弃
}
```

规则顺序就是优先级。先写的先匹配。简单粗暴但非常可预测。

#### 为什么适合/不适合

**可借鉴的**：
- iptables 的 first-match-wins 语义：简单、可预测，30 条规则完全够用
- "规则和代码分离"的核心思想

**不适合的**：
- Drools：需要引入 JVM，学 DRL 语法，30 条规则完全不需要这个量级
- OPA/Rego：学习曲线陡，适合微服务间的策略管理，不适合单进程应用
- 规则引擎的强项是处理**大量相互关联的规则**（几百到几千条）。我们只有 ~30 条，用 if/else 或简单的规则表就够了

**场景评分：2/5** — 杀鸡用牛刀。但 iptables 的线性匹配思想值得借鉴。

---

### 3. Event Stream Processing（Kafka Streams / Flink）

#### 怎么运作

把数据视为连续不断的"流"，通过一系列算子（operator）实时处理：

```
Source(Twitter) → Filter(去噪) → Map(提取字段) → Window(5分钟聚合) → Sink(Discord)
```

每个算子是无状态的纯函数。数据从左到右流过，每个算子只关心自己的变换逻辑。

Kafka Streams 的 Java 写法：
```java
tweets.filter((k, v) -> v.getLikes() > 50)
      .mapValues(v -> classify(v))
      .to("classified-signals");
```

Flink 甚至支持 SQL：
```sql
SELECT author, content, classify(content) as category
FROM tweets
WHERE likes > 50
WINDOW TUMBLE(SIZE 5 MINUTE)
```

核心概念：**背压（backpressure）** — 下游处理不过来时，自动减慢上游速度。

#### 为什么不适合

- 我们是**定时轮询**（每 15-30 分钟搜一次），不是实时流
- 数据量小（每轮几十到几百条推文），不需要分布式流处理
- Kafka/Flink 需要独立部署和运维，对单人团队是沉重的基础设施负担
- 流处理的调试极其困难（数据飞过就没了，难以复现问题）

**唯一可借鉴的**：算子链的思想（数据从左到右流过一系列处理步骤）。但这不需要 Kafka 来实现。

**场景评分：2/5** — 过度工程。

---

### 4. ETL / Data Pipeline（Airflow / dbt）

#### 怎么运作

把数据处理建模为有向无环图（DAG），每个节点是一步处理，边是数据依赖：

```
              ┌→ classify_mentions → route_mentions ─┐
search_all ──┤→ classify_network  → route_network  ─┼→ notify
              └→ classify_crisis   → route_crisis  ─┘
```

Airflow 用 Python 定义 DAG：
```python
with DAG("marketing-agent", schedule="*/30 * * * *"):
    search = PythonOperator(task_id="search", python_callable=search_all)
    classify = PythonOperator(task_id="classify", python_callable=classify)
    route = PythonOperator(task_id="route", python_callable=route)
    search >> classify >> route
```

核心优势：
- 每个节点可以独立重跑（幂等性）
- 清晰的依赖关系可视化
- 内置调度器、重试、告警

#### 为什么不适合

- Airflow 是 Python 生态，我们是 TypeScript
- 需要独立部署（Web Server + Scheduler + Worker + DB），对单人团队太重
- 我们的流程是线性的（搜索 → 分类 → 路由），不需要 DAG 的复杂拓扑

**可借鉴的**：
- "每步可独立重跑"的幂等性设计
- 调度器 + 任务状态追踪的思路

**场景评分：3/5** — 概念吻合但实现太重。

---

### 5. Trigger-Condition-Action / TCA（IFTTT / Zapier / Alertmanager）

#### 怎么运作

最直觉的自动化模型：**当 X 发生，如果满足 Y 条件，就执行 Z 动作。**

复杂度递进：

**IFTTT（最简单）**：一个 trigger → 一个 action
```
IF new tweet mentions "Byreal" THEN send to Discord
```

**Zapier/Make（中等）**：一个 trigger → 多 action + 条件分支
```
IF new tweet mentions "Byreal":
  IF sentiment = negative → send to #crisis
  ELSE IF engagement > 100 → send to #tier1
  ELSE → send to #noise
```

**n8n（复杂）**：完整的 DAG 工作流 + 循环 + 错误处理

**Prometheus Alertmanager（与我们最贴合）**：

Alertmanager 不做搜索也不做分类——它只做一件事：**把带标签的告警路由到正确的接收者**。

工作机制：

1. Prometheus 检测到异常，生成一条 alert，自带标签：
```yaml
alert: HighMemoryUsage
labels:
  severity: critical
  team: platform
  service: api-gateway
```

2. Alertmanager 收到 alert，按路由树匹配：
```yaml
route:
  receiver: default-slack            # 兜底
  routes:
    - match: { severity: critical }
      receiver: pagerduty            # critical → 打电话
      continue: true                 # 继续匹配下一条
    - match: { team: platform }
      receiver: platform-slack       # platform 团队 → 他们的 Slack
    - match: { team: backend }
      receiver: backend-slack
```

3. `continue: true` 的关键作用：一条 alert 可以**同时**路由到多个接收者。没有 `continue` 的话命中第一条就停止（类似 iptables 的 first-match-wins）。

4. **Inhibition（抑制）**：高优告警自动压制同类低优告警
```yaml
inhibit_rules:
  - source_match: { severity: critical }
    target_match: { severity: warning }
    equal: [service]                  # 同一个 service 的 warning 被 critical 压掉
```

5. **Grouping（分组）**：同一组告警合并为一条通知，避免轰炸
```yaml
group_by: [service, alertname]
group_wait: 30s                      # 收到第一条后等 30 秒，把同组的合并
```

#### 为什么适合

**路由层高度匹配**：
- 我们的 LLM 分类输出（alertLevel, suggestedAction, source）= Alertmanager 的 alert labels
- 路由到 Discord 频道 = Alertmanager 的 receiver
- "同一条推文发到 tier 频道 + action 频道"= `continue: true` 的双发机制
- "高可信度分类压制低可信度"= inhibition
- "同一话题的多条推文合并为一条摘要通知"= grouping

**但有局限**：
- Alertmanager 不搜索也不分类——它只做路由。我们的搜索层（prompt 构造、账户分批、rate limiting）和分类层（LLM 调用）的复杂度 Alertmanager 模型覆盖不了
- Alertmanager 的标签是**上游已经打好的**（Prometheus 打标签），我们的标签是**自己用 LLM 打的**，准确性和成本是额外挑战

**核心价值**：不是说要用 Alertmanager 这个软件，而是借鉴它的**路由树 + label matching + continue/inhibition** 这套声明式路由机制。

**场景评分：5/5** — 路由层的最佳参照。

---

### 6. Pub/Sub + Topic Routing（RabbitMQ / SNS）

#### 怎么运作

消息中间件的路由模式。核心思想：**发布者只管发消息，订阅者只管筛选自己感兴趣的。**

**RabbitMQ Topic Exchange**：

发布者给消息打一个 routing key（用 `.` 分隔的层级标识）：
```
signal.crisis.red.reply       → 危机信号，红色警报，建议回复
signal.mentions.yellow.like   → 品牌提及，黄色警报，建议点赞
```

订阅者用通配符绑定：
```
signal.crisis.#              → 订阅所有危机信号（不管警报级别和动作）
signal.*.red.*               → 订阅所有红色警报（不管来源和动作）
signal.mentions.*.reply      → 订阅所有需要回复的品牌提及
```

`*` 匹配一个词，`#` 匹配零或多个词。

**AWS SNS Filter Policy**：

订阅者声明一个 JSON filter，只接收匹配的消息：
```json
{
  "alertLevel": ["red", "orange"],
  "source": [{"anything-but": "noise"}]
}
```

支持精确匹配、排除匹配、前缀匹配、数值范围。

#### 为什么不适合

- **需要消息队列基础设施**：RabbitMQ/SNS 是独立服务，需要部署和运维。我们是单进程 TypeScript 应用，引入消息队列是纯粹的架构开销
- **解耦过度**：Pub/Sub 的优势是发布者和订阅者完全解耦，适合微服务。我们的搜索、分类、路由在同一个进程里，不需要这种解耦

**可借鉴的**：
- Routing key 的层级命名思想（`source.alertLevel.action`）可以用在我们的标签设计上
- Filter policy 的声明式条件表达

**场景评分：3/5** — 基础设施不匹配，但路由思想可借鉴。

---

### 7. Label/Tag 系统（Gmail / Kubernetes / GitHub）

#### 怎么运作

**Gmail：最直觉的参照**

Gmail 的 filter 系统：
```
条件：From:jupiter_exchange AND Subject:("Byreal" OR "byreal")
动作：打标签 "竞品提及Byreal"、标星、不归档
```

关键特征：
- 一封邮件可以有多个 label（不像文件夹那样互斥）
- Filter 是声明式的条件 → 动作映射
- 用户在 GUI 里配置，不需要写代码

**Kubernetes Label Selector**：

K8s 的所有资源（Pod、Service、Deployment）都可以挂标签：
```yaml
metadata:
  labels:
    app: marketing-agent
    tier: backend
    env: production
```

选择器用标签组合查询：
```yaml
selector:
  matchLabels:
    app: marketing-agent
    tier: backend
  matchExpressions:
    - key: env
      operator: In
      values: [production, staging]
```

`matchLabels` 是精确匹配（AND 关系），`matchExpressions` 支持 `In`、`NotIn`、`Exists`、`DoesNotExist`。

**GitHub Labels + Actions**：

Issue/PR 打标签 → 触发自动化：
```yaml
# .github/workflows/auto-assign.yml
on:
  issues:
    types: [labeled]
jobs:
  assign:
    if: github.event.label.name == 'bug'
    steps:
      - run: gh issue edit $NUMBER --add-assignee @bug-team
```

#### 为什么适合

**天然匹配 LLM 分类输出**：

我们的 LLM 分类器已经在输出结构化标签：
```json
{
  "alertLevel": "orange",
  "suggestedAction": "qrt_positioning",
  "category": 2,
  "confidence": "high",
  "sentiment": "positive"
}
```

这就是一组 labels。路由逻辑就是"根据这组 labels 匹配规则"——和 Gmail filter、K8s selector 完全一样。

**多标签不互斥解决了"一条推文多个属性"的问题**：

一条推文可能同时是：
- `source: ecosystem`（来自 KOL 监控）
- `alertLevel: red`（高优先级）
- `suggestedAction: reply_supportive`（建议正面回复）
- `account_tag: partner`（来自合作伙伴账户）

这些标签的任意组合都可以作为路由条件。不需要预先定义所有可能的组合。

**运营可理解**：

"给推文打标签，根据标签发到不同频道" — 这句话任何人都能理解。不需要解释什么是 Rule Engine、Stream Processing、DAG。

#### 局限

- Label 系统本身只是**数据模型**（怎么描述推文），不是**执行模型**（怎么处理推文）。需要配合其他模式（如 TCA）来驱动执行
- K8s selector 的表达力有限：只有 AND 逻辑，不支持 OR（需要多条规则）。对我们够用，但如果未来规则变复杂可能不够

**场景评分：5/5** — 数据模型层的最佳选择。

---

## 对比表

| 维度 | 社媒监控 | Rule Engine | Stream | ETL/DAG | **TCA** | Pub/Sub | **Label** |
|------|---------|-------------|--------|---------|---------|---------|-----------|
| 配置复杂度 | 低(GUI) | 高(DSL) | 高(代码) | 中高 | **低(YAML)** | 中 | **低** |
| 表达力 | 中 | 很高 | 很高 | 高 | 中 | 中 | 中低 |
| 可调试性 | 中 | 中低 | 低 | 高 | **高** | 中 | **高** |
| 扩展性 | 低 | 高 | 高 | 高 | **高** | 高 | **高** |
| 运营友好 | 高(GUI) | 低 | 很低 | 低 | **高(YAML)** | 中 | **高** |
| 适合规模 | 10-100 | 100-10K | 无上限 | 10-1K | **10-100** | 10-1K | **10-100** |
| **场景评分** | 3/5 | 2/5 | 2/5 | 3/5 | **5/5** | 3/5 | **5/5** |

评分依据：我们的场景是**小规模（~30 规则）+ 需要运营可配 + 单人可维护 + LLM 分类输出天然是标签**。TCA 和 Label 在这 4 个维度上都最优。

---

## 推荐方案：Label + TCA 组合

### 为什么是两个模式组合而不是一个

因为它们解决不同层面的问题：

- **Label** 回答的是"怎么描述一条推文"（数据模型）
- **TCA** 回答的是"怎么处理一条推文"（执行模型）

单独用 Label 没有执行力（标签打了但没人处理）。单独用 TCA 缺乏数据结构（条件匹配缺少统一的匹配对象）。组合起来：Label 提供统一的匹配对象，TCA 提供执行框架。

### 三层架构

```
Layer 1: Sources — 定时触发搜索，获取推文
  "谁"负责搜什么
  配置驱动：YAML 定义搜索方向（prompt, accounts, schedule）
  运营操作：加一个搜索方向 = 加一段 YAML

Layer 2: Labeling — 给推文打标签
  LLM 分类（alertLevel, suggestedAction, category, sentiment）
  + 来源标签（source: mentions/ecosystem/crisis/...）
  + 账户标签（account_tag: partner/kol/competitor/...）

Layer 3: Routing — 根据标签组合匹配路由规则，发送到 Discord 频道
  借鉴 Alertmanager 的路由树：first-match + continue 双发
  配置驱动：YAML 定义路由规则
  运营操作：调整路由 = 改一行 YAML
```

### 各层的参照来源

| 层 | 主要参照 | 借鉴了什么 |
|---|---------|-----------|
| Sources | Brandwatch Query 概念 | 搜索方向 = 配置，不是代码 |
| Labeling | Gmail Label 模型 | 多标签不互斥，一条推文多个属性 |
| Routing | Alertmanager routing tree | first-match-wins + continue 双发 + inhibition 抑制 |
| 整体执行 | TCA 模式 | Trigger(定时) → Condition(标签匹配) → Action(发送+生成草稿) |

### Alertmanager 路由机制详解（核心借鉴）

Alertmanager 的路由树有三个关键机制我们需要借鉴：

**1. `continue` 双发**

没有 `continue` 时，命中第一条规则就停止（iptables 语义）：
```yaml
routes:
  - match: { alertLevel: red }
    channel: tier1-signals         # 命中 → 发到 tier1，停止
  - match: { suggestedAction: reply_supportive }
    channel: needs-reply           # 如果已命中上一条，这条永远不会执行
```

加了 `continue: true`，命中后继续匹配下一条：
```yaml
routes:
  - match: { alertLevel: red }
    channel: tier1-signals
    continue: true                 # 发到 tier1，但继续往下匹配
  - match: { suggestedAction: reply_supportive }
    channel: needs-reply           # 也会被匹配到 → 双发
```

这解决了"一条推文既要按严重程度发到 tier 频道，又要按动作类型发到 action 频道"的需求。

**2. Inhibition 抑制**

同一条推文可能被搜索到多次（不同搜索方向都命中了），产生多个信号。如果高可信度的分类结果已经发出，低可信度的应该被压掉：

```yaml
inhibit_rules:
  - source_match: { confidence: high }
    target_match: { confidence: low }
    equal: [tweet_id]              # 同一条推文的 low confidence 被 high 压掉
```

**3. Grouping 分组**

短时间内的多条同类信号合并为一条摘要通知，避免 Discord 频道被轰炸：

```yaml
group_by: [source, alertLevel]
group_wait: 60s                    # 第一条到达后等 60 秒
group_interval: 5m                 # 之后每 5 分钟合并一次
```

### 配置格式示例

```yaml
# ============================================================
# sources.yaml — 搜索源定义
# ============================================================

sources:
  - name: mentions
    schedule: "*/15 * * * *"
    prompt: |
      Search for tweets mentioning "Byreal" or "@byrealxyz"
      in DeFi/Solana context. Exclude retweets.
    labels:
      source: mentions

  - name: ecosystem
    schedule: "*/30 * * * *"
    prompt: |
      Search for tweets from key Solana ecosystem accounts
      about protocol updates, TVL milestones, institutional news.
    accounts_ref: config/accounts.yaml
    labels:
      source: ecosystem

  - name: narratives
    schedule: "0 * * * *"
    prompt: |
      Search for trending discussions about: {{active_keywords}}
    keywords: ["AI agent Solana", "Crypto AI agent"]
    labels:
      source: narratives

  - name: crisis
    schedule: "*/5 * * * *"
    prompt: |
      Search for tweets about exploits, hacks, rug pulls,
      security incidents involving Solana DeFi protocols.
    labels:
      source: crisis

# ============================================================
# routing.yaml — 路由规则
# ============================================================

routing:
  default:
    channel: noise

  routes:
    # 按 alertLevel 路由到 tier 频道（continue 双发）
    - match: { alertLevel: red }
      channel: tier1-signals
      continue: true

    - match: { alertLevel: orange }
      channel: tier2-signals
      continue: true

    - match: { alertLevel: yellow }
      channel: tier3-signals
      continue: true

    # 按 suggestedAction 路由到 action 频道
    - match: { suggestedAction: [reply_supportive, qrt_positioning] }
      channel: needs-reply

    - match: { suggestedAction: [like_only, escalate_internal] }
      channel: needs-interaction

  inhibit_rules:
    - source_match: { confidence: high }
      target_match: { confidence: low }
      equal: [tweet_id]

  group_by: [source, alertLevel]
  group_wait: 60s
```

### 诚实的局限性

1. **Alertmanager 类比只覆盖路由层**。搜索层的复杂度（370 账户分批、rate limiting、prompt 构造）没有现成的模式可以参照，需要自己设计执行引擎
2. **引擎复杂度估算**：路由引擎 ~100 行，但搜索引擎（batching, dedup, last_seen, error retry）~300-400 行。总计 ~500 行，比当前 collect.ts（593行）略少，但并不是数量级的简化
3. **YAML 没有类型检查**：routing rule 里写错标签名（`alertlevel` vs `alertLevel`）只能在运行时发现。需要配置校验层来弥补
4. **调试多一层间接性**：出问题时要同时看 YAML 配置和引擎代码才能定位原因

### 与被否决方案的对比

| 方案 | 核心思路 | 否决原因 |
|------|---------|---------|
| 4 个硬编码 pipeline | 每个方向一段代码 | 加方向改 4 文件，参数在代码里 |
| Strategy-as-Prompt | 纯 .md 定义策略 | 路由/过滤无法声明式表达 |
| Strategy-as-Module | TS + YAML + MD | 每个策略一个 TS 文件，路由仍是代码 |
| 全配置化（基于旧代码） | 现有逻辑搬到 YAML | O-tier bypass 等流程分支难以配置化（但这个判断基于旧架构，重新设计后不一定成立） |
| **Label + TCA** | 标签数据模型 + 声明式路由 | 推荐方案 |

---

## 参考资料

- [Prometheus Alertmanager Configuration](https://prometheus.io/docs/alerting/latest/configuration/) — routing tree, inhibition, grouping 的官方文档
- [Alertmanager Routing Tree Deep Dive](https://deepwiki.com/prometheus/alertmanager/4.2-routing-tree-configuration)
- [Alertmanager Inhibition Rules](https://deepwiki.com/prometheus/alertmanager/4.4-inhibition-rules-configuration)
- [Brandwatch Boolean Operators Guide](https://www.brandwatch.com/blog/the-social-media-monitoring-cheat-sheet/)
- [Sprout Social Query Builder](https://support.sproutsocial.com/hc/en-us/articles/360017807291)
- [RabbitMQ Topic Exchange](https://www.cloudamqp.com/blog/rabbitmq-topic-exchange-explained.html)
- [AWS SNS Filter Policies](https://docs.aws.amazon.com/sns/latest/dg/sns-subscription-filter-policies.html)
- [Kubernetes Label Selectors](https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/)
- [Open Source Rules Engines Comparison 2026](https://www.nected.ai/blog/open-source-rules-engine)
