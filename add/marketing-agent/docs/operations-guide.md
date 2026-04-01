# Marketing Agent 运营使用指南

> 面向运营团队。无需懂代码。
> 最后更新：2026-03-17

---

## 一、系统是做什么的

Marketing Agent 是一个自动监控 X (Twitter) 的信号系统。它：

1. **持续搜索** — 监控品牌提及、生态账号、行业趋势、安全事件
2. **自动分级** — AI 判断每条推文的重要程度（红 / 橙 / 黄）
3. **决定动作** — AI 建议怎么反应（回复 / QRT / 点赞 / 上报）
4. **推送到 Discord** — 按动作类型分发到对应频道，等运营处理

你在 Discord 里看到的每条消息，背后都是一条系统认为值得关注的推文。

---

## 二、Discord 频道说明

| 频道 | 内容 | 你需要做什么 |
|------|------|-------------|
| `#needs-reply` | AI 建议发回复的推文 | 选语气 → 生成草稿 → 审阅 → 发布 |
| `#needs-qrt` | AI 建议引用转发的推文 | 选语气 → 生成草稿 → 审阅 → 发布 |
| `#collab-opportunities` | AI 识别为潜在合作/集成机会的信号 | 拉 BD / 产品一起判断要不要跟进 |
| `#escalation` | 需要内部讨论决策（合作邀请、法务、公关） | 拉相关人进来讨论 |
| `#engagement` | 只需要点赞，不用回复 | 去 X 点个赞 |
| `#noise` | 低优先级兜底，AI 认为不太重要 | 偶尔浏览，忽略即可 |
| `#trending` | 值得内部探索的新叙事/新方向信号 | 浏览并记录值得跟进的方向 |
| `#marketing-bot` | 引擎状态、心跳日志 | 无需操作，报错时看这里 |

---

## 三、信号卡片怎么看

每条推文以卡片形式出现，结构如下：

```
┌─────────────────────────────────────────────────────┐
│ 🟠 @jupiter_exchange — Ecosystem Core               │  ← 颜色 = 优先级
│                                                     │
│ Excited to integrate with @byreal_io's CLMM vaults! │  ← 推文内容
│ New concentrated liquidity strategies coming soon.  │
│                                                     │
│ Alert · ORANGE          Suggested · Reply           │  ← AI 判断结果
│ 👥 892 ❤️ 156 🔁 43    Today at 14:32 (CST)        │  ← 数据 + 时间
│ AI Analysis: Jupiter 官方账号宣布与 Byreal 集成...   │  ← AI 分析理由
├─────────────────────────────────────────────────────┤
│ [Casual] [Official] [Add Context]                   │  ← 操作按钮
│ ▼ Feedback                                          │  ← 反馈下拉
└─────────────────────────────────────────────────────┘
```

### 颜色 = 紧急程度

| 颜色 | 含义 | 典型场景 |
|------|------|---------|
| 🔴 红色边框 | 立即处理 | 安全事件、大 V 公开批评、顶级 KOL 等待回应 |
| 🟠 橙色边框 | 重要，今天内处理 | KOL 正面提及、合作伙伴公告、有人 @ 提问 |
| 🟡 黄色边框 | 值得关注，有空看 | 行业趋势讨论、竞品动态、社区一般性讨论 |
| ⚪ 灰色边框 | 低优先级 | 通常出现在 `#noise` |

---

## 四、处理信号的操作步骤

### 4.1 生成回复草稿（`#needs-reply` / `#needs-qrt`）

1. 看卡片底部的 **语气按钮**（如 `[Casual]`、`[Official]`、`[Meme]`）
2. 选一个你觉得合适的语气，点击
3. 系统生成草稿，显示在卡片下方
4. 审阅草稿，复制到 X 发布

> **语气说明：**
> - `Casual` — 日常对话、社区互动、口语化
> - `Official` — 官方合作声明、正式场合
> - `Meme` — CT 风格、degen 语气、融入社区而不是端着
> - `Technical` — 技术讨论、产品细节、数据支撑
> - `Empathetic` — 用户遇到问题、负面情绪、需要安抚

### 4.2 自定义草稿（Add Context）

如果你对 AI 给的语气方向不满意，点 **[Add Context]**：

1. 在弹窗里填写你的语气偏好和补充信息
   - **Tone** 栏：描述你想要的风格（"更简短"、"加上我们 TVL 数据"）
   - **Context** 栏：补充 AI 不知道的背景（"这个账号是我们的合作伙伴"）
2. 提交后系统重新生成草稿

### 4.3 提交反馈

每张卡片底部有 **Feedback 下拉菜单**，处理完后请选一个：

| 选项 | 用途 |
|------|------|
| ✅ Good Signal | 信号正确，分类准确，正常处理 |
| ❌ Not Relevant | 这条跟我们没关系，AI 判断错了 |
| 🔄 Wrong Category | 内容OK但发错频道了 |
| 📉 Low Quality | 噪声，AI 过滤没过掉 |
| 🔁 Duplicate | 已经处理过这条推文了 |

> 反馈帮助我们追踪 AI 的判断质量，是重要的数据积累。

---

## 五、修改配置

现在优先使用 Discord `/config` 命令改配置。大多数日常操作都不需要 SSH，也不需要手动重启服务。

### 5.1 谁可以使用 `/config`

`/config` 不是所有人都能用。当前权限分三层：

1. 固定治理管理员：`883365374412857404`
2. 已被加入 `/config` 权限名单的用户或角色
3. 被允许使用 `/config` 的指定频道

如果你在 Discord 里看得到命令，但执行时提示没权限，联系治理管理员给你开通。

### 5.2 日常最常用命令

| 场景 | 命令 |
|------|------|
| 查看整体配置 | `/config view` |
| 查看某组监控账号 | `/config accounts-list group:<group>` |
| 新增监控账号 | `/config accounts-add group:<group> handle:<twitter_handle>` |
| 删除监控账号 | `/config accounts-remove group:<group> handle:<twitter_handle>` |
| 查看趋势关键词 | `/config keywords-list` |
| 新增趋势关键词 | `/config keywords-add keyword:<keyword>` |
| 删除趋势关键词 | `/config keywords-remove keyword:<keyword>` |
| 查看所有 source | `/config sources-list` |
| 调整某个 source 的抓取上限 | `/config source-set-max source:<source_name> value:<1-20>` |
| 查看 `brand_context.md` | `/config prompt-view target:brand-context` |
| 快速改 `brand_context.md` | `/config prompt-set target:brand-context content:<new_text>` |
| 查看完整配置文件 | `/config file-view file:<accounts|sources|judge|reactor|routing|brand-context>` |
| 下载配置文件编辑 | `/config file-edit file:<...>` |
| 上传替换配置文件 | `/config file-apply file:<...> upload:<file>` |
| 回滚配置文件 | `/config file-rollback file:<...>` |

### 5.3 运营最常做的事：加/删监控账号

新增账号：

```text
/config accounts-add group:core handle:toly
```

删除账号：

```text
/config accounts-remove group:core handle:toly
```

查看某个分组：

```text
/config accounts-list group:core
```

**常见分组：**
- `core` — Solana Foundation 核心人物
- `fireside-speakers` — Web3 思想领袖
- `top-dapps` — Solana 头部 DApp
- `solana-kols` — Solana KOL
- `signal-news-data` — 新闻 / 数据 / VC
- `key-devs` — 核心开发者
- `top-traders` — 顶级交易员

### 5.4 运营第二常做的事：改趋势关键词

新增关键词：

```text
/config keywords-add keyword:Solana perps
```

删除关键词：

```text
/config keywords-remove keyword:Solana perps
```

查看当前关键词：

```text
/config keywords-list
```

### 5.5 source 调优

查看所有 source：

```text
/config sources-list
```

把某个 source 每轮最多抓取数量改成 10：

```text
/config source-set-max source:direct-mentions value:10
```

> `max_tweets` 允许范围是 `1-20`。如果你不确定该怎么调，先联系开发。

### 5.6 Prompt / 文件级配置编辑

除了结构化命令，下面这些文件现在也支持直接在 Discord 里查看和编辑：

- `accounts.yaml`
- `brand_context.md`
- `sources.yaml` / `judge.yaml` / `reactor.yaml` / `routing.yaml`

快速查看 `brand_context.md`：

```text
/config prompt-view target:brand-context
```

快速整段替换 `brand_context.md`：

```text
/config prompt-set target:brand-context content:<new_text>
```

如果要做更安全的文件级编辑，推荐走下载 → 本地改 → 上传替换：

```text
/config file-edit file:brand-context
/config file-apply file:brand-context upload:<edited_file>
/config file-rollback file:brand-context
```

这套文件级流程也适用于：

- `accounts.yaml`
- `sources.yaml`
- `judge.yaml`
- `reactor.yaml`
- `routing.yaml`

旧的 `yaml-view` / `yaml-edit` / `yaml-apply` / `yaml-rollback` 仍然兼容，但后续优先使用 `file-*`。

### 5.7 手动触发 collect

旧的 `collect-trigger` 文件方式已经废弃。现在要手动跑某个 source，使用 CLI：

本地开发环境：

```bash
npm run marketing:collect -- --source crisis
npm run marketing:collect -- --source trend-keywords,explore-window
npm run marketing:collect -- --list
```

VPS 上：

```bash
cd /home/claw/nanoclaw-marketing
source ~/.nvm/nvm.sh
node dist/marketing-agent/scripts/manual-collect.js --source crisis
```

如果不传 `--source`，会按配置顺序把所有 sources 跑一遍。

### 5.8 权限治理命令（仅治理管理员）

以下命令只有治理管理员可以用，用来管理“谁能使用 `/config`”：

| 场景 | 命令 |
|------|------|
| 查看当前权限名单 | `/config access-list` |
| 给某个用户开通权限 | `/config access-add-user user_id:<discord_user_id>` |
| 移除某个用户权限 | `/config access-remove-user user_id:<discord_user_id>` |
| 给某个角色开通权限 | `/config access-add-role role_id:<discord_role_id>` |
| 移除某个角色权限 | `/config access-remove-role role_id:<discord_role_id>` |
| 限定只能在某个频道使用 `/config` | `/config access-set-channel channel_id:<discord_channel_id>` |
| 取消频道限制 | `/config access-clear-channel` |

示例：

```text
/config access-add-user user_id:123456789012345678
/config access-add-role role_id:987654321098765432
/config access-set-channel channel_id:112233445566778899
/config access-list
```

### 5.9 如何获取 Discord ID

1. 打开 Discord `Developer Mode`
2. 右键用户、角色或频道
3. 选择 `Copy User ID` / `Copy Role ID` / `Copy Channel ID`

### 5.10 配置文件实际存放位置

运行中的配置目录由服务自动解析，不一定等于代码仓库里的默认路径。

当前线上实际使用的是：

```text
/home/claw/nanoclaw-marketing/marketing-agent/config/
```

仓库里的默认配置样例在：

```text
Apps/nanoclaw/marketing-agent/config/
```

如果你只是日常运营，优先用 Discord `/config`，不要直接 SSH 改 YAML。

`brand_context.md` 的线上路径是：

```text
/home/claw/nanoclaw-marketing/marketing-agent/prompts/brand_context.md
```

### 5.11 什么时候还需要开发介入

下面这些情况仍然需要开发处理：

- 要新增全新的 source 类型
- 要新增新的 action / channel / 数据库字段
- 要修改 Discord 路由规则
- 要新增 `/config` 子命令或交互方式
- `/config` 命令本身报错或没有生效
- 需要批量迁移配置

---

## 六、常见问题

**Q：信号卡片没有语气按钮？**
A：`#collab-opportunities`、`#escalation`、`#engagement`、`#noise` 频道的信号不需要生成草稿，所以只有 Feedback 下拉没有语气按钮。

**Q：很长时间没有新信号推来了？**
A：检查 `#marketing-bot` 频道里的 heartbeat 日志，正常情况下每 15 分钟会有一条。如果超过 1 小时没有，联系开发。

**Q：同一条推文出现了两次？**
A：可以通过 Feedback 选 `Duplicate` 标记。如果经常出现重复，可能需要调整 sources.yaml，联系开发。

**Q：AI 经常把某类推文判错级别？**
A：如果只是补充品牌背景、口径、禁用说法，可以先改 `brand_context.md`。如果要改 Judge / Reactor 的核心判断逻辑，仍然建议联系开发。

**Q：想临时停止某个搜索方向？**
A：可以先通过 `/config file-edit file:sources` 下载后修改，再用 `/config file-apply` 上传。但如果你不确定改动影响，先联系开发。

**Q：想马上验证新规则，不想等 cron？**
A：用手动 collect CLI。不要再写 `collect-trigger` 文件，v5 已经不消费那条链路了。

**Q：我执行了 `/config`，但提示没权限？**
A：说明你不在当前 allowlist、角色名单或指定频道里。联系治理管理员处理。

**Q：我改完 `/config` 后多久生效？**
A：通常下一个 cron 周期就会生效，一般几分钟内。不需要手动重启服务。

---

## 七、紧急联系

- 引擎宕机 / 长时间无信号：看 `#marketing-bot` 日志，联系开发重启服务
- Discord bot 消息发不出来：联系开发检查 Tahoe Bot 状态
- 发现重大安全事件还没进 `#escalation`：手动在 X 上处理，再把推文链接发到 escalation 频道
