---
name: byreal-marketing-agent
description: Byreal Twitter 营销情报 Agent — 定时采集推文、AI 分类、Discord 团队审核流程。触发词："install marketing agent"、"营销 agent"、"byreal marketing"。
---

# Byreal Marketing Agent Skill

一个面向非技术营销团队的 Twitter 情报与 Discord 协作系统。

## 概览

- 定时从 TwitterAPI.io 抓取指定账号与关键词的推文
- 用 Claude Haiku 做 8 类信号分类（category 1-8），支持情感、优先级、风险等级等元数据
- 信号存入 SQLite，按告警等级路由到 Discord 频道
- Discord 机器人命令：查看信号、起草回复、批准/拒绝

## 前置条件

在开始安装前确认：

1. NanoClaw 已部署并运行（Discord 集成已配置）
2. 已有 TwitterAPI.io 账户和 API key
3. Discord server 已创建以下频道和 webhook：
   - `#marketing-bot`（机器人交互，注册为 NanoClaw group）
   - `#risk-alerts`（风险告警 webhook）
   - `#opportunities`（机会信号 webhook）
   - `#ecosystem-feed`（生态动态 webhook）
   - `#draft-review`（草稿审批 webhook，仍支持）
   - `#draft`（草稿发布，v2 新增）
   - `#daily-digest`（日报 webhook）
4. 有 Linux 用户级 cron 权限

## 前置准备

### 准备 1：获取 Discord Bot Token

1. 打开 https://discord.com/developers/applications
2. 点 「New Application」→ 输入名称（如 `Byreal Marketing Bot`）→ Create
3. 左侧菜单 → 「Bot」→ 点「Reset Token」→ 复制 Token（只显示一次，存好）
4. 同页面往下，打开这些开关：
   - `Presence Intent` ✅
   - `Server Members Intent` ✅
   - `Message Content Intent` ✅
5. 左侧菜单 → 「OAuth2」→ 「URL Generator」
   - Scopes 勾选 `bot`
   - Bot Permissions 勾选 `Send Messages`、`Read Message History`、`View Channels`
   - 复制生成的 URL，在浏览器打开，选择你的 Server，授权

### 准备 2：创建 Discord Webhook

1. 在 Discord Server 里创建 6 个频道（如果还没创建）：
   - `#risk-alerts`
   - `#opportunities`
   - `#ecosystem-feed`
   - `#draft-review`
   - `#draft`
   - `#daily-digest`
2. 对每个频道：右键频道名 → 「Edit Channel」→ 「Integrations」→ 「Webhooks」→ 「New Webhook」
3. 复制每个 Webhook URL，后面填入 `config.yaml`

### 准备 3：获取 TwitterAPI.io API Key

1. 打开 https://twitterapi.io → 注册账号
2. 进入 Dashboard → 复制 API Key
3. 按量计费 $0.15/1K tweets，新账户通常有免费额度

## 安装步骤

### Step 1 — 克隆 Skill 并复制文件

```bash
# Clone skill repo to temp
git clone https://github.com/ggg223399/byreal-marketing-agent /tmp/byreal-marketing-agent

# Enter NanoClaw root
cd /path/to/your/nanoclaw

# Copy business logic into a single directory
mkdir -p marketing-agent
cp -r /tmp/byreal-marketing-agent/{collector,classifier,generator,approval,notifications,digest,governance,lib,types,db,config,prompts,tests,scripts} marketing-agent/

# Copy files that MUST be at nanoclaw root (NanoClaw constraints):
#   - groups/ must be at root (NanoClaw group discovery mechanism)
#   - src/channels/ must be at root (tsconfig rootDir constraint)
cp -r /tmp/byreal-marketing-agent/groups/marketing-alerts groups/marketing-alerts
mkdir -p src/channels
cp /tmp/byreal-marketing-agent/src/channels/discord.ts src/channels/discord.ts
cp /tmp/byreal-marketing-agent/config.yaml.example config.yaml

# Cleanup
rm -rf /tmp/byreal-marketing-agent
```

### Step 2 — 安装依赖

在 NanoClaw 根目录执行：

```bash
npm install discord.js better-sqlite3 yaml
npm install --save-dev @types/better-sqlite3
```

### Step 3 — 修改 `src/config.ts`

在 `readEnvFile([...])` 的数组末尾加入新字段：

```typescript
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'DISCORD_BOT_TOKEN',   // ADD THIS
  // 'DISCORD_ONLY',    // 可选：仅在无 WhatsApp/Telegram 时需要
]);
```

在文件末尾追加：

```typescript
// Discord configuration
export const DISCORD_BOT_TOKEN =
  process.env.DISCORD_BOT_TOKEN || envConfig.DISCORD_BOT_TOKEN || '';
```

> **注意**：如果你的 NanoClaw 已有 Telegram（`TELEGRAM_ONLY`），不需要加 `DISCORD_ONLY`。Discord 可以和 Telegram/WhatsApp 同时运行。

### Step 4 — 修改 `src/index.ts`

在 imports 区加入：

```typescript
import { DISCORD_BOT_TOKEN } from './config.js';
import { DiscordChannel } from './channels/discord.js';
```

找到 `// Create and connect channels` 注释块，在**现有所有 channel 初始化代码之前**插入 Discord 块，不要修改或删除现有代码：

```typescript
// Create and connect channels
if (DISCORD_BOT_TOKEN) {          // ADD THIS BLOCK
  const discord = new DiscordChannel(DISCORD_BOT_TOKEN, channelOpts);
  channels.push(discord);
  await discord.connect();
}
// ... 保留下方所有现有代码不变（WhatsApp、Telegram 等）
```

**示例**：如果你同时有 Telegram + WhatsApp，修改后应该是：

```typescript
// Create and connect channels
if (DISCORD_BOT_TOKEN) {          // ← NEW
  const discord = new DiscordChannel(DISCORD_BOT_TOKEN, channelOpts);
  channels.push(discord);
  await discord.connect();
}
if (!TELEGRAM_ONLY) {             // ← 原有，不改
  whatsapp = new WhatsAppChannel(channelOpts);
  channels.push(whatsapp);
  await whatsapp.connect();
}
if (TELEGRAM_BOT_TOKEN) {         // ← 原有，不改
  const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, channelOpts);
  channels.push(telegram);
  await telegram.connect();
}
```

> **兼容性**：Discord、Telegram、WhatsApp 三者可以同时运行，互不干扰。每个 channel 独立处理各自的消息队列。

### Step 5 — 修改 `vitest.config.ts`

将 `include` 数组加入 `tests/**` 路径：

```typescript
export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'skills-engine/**/*.test.ts',
      'marketing-agent/tests/**/*.test.ts',   // ADD THIS
    ],
  },
});
```

### Step 6 — 修改 `container/Dockerfile`

在 `apt-get install` 列表中加入 `sqlite3`（容器内 bot 用 sqlite3 CLI 操作数据库）：

```dockerfile
RUN apt-get update && apt-get install -y \
    chromium \
    ...（现有列表）... \
    sqlite3 \          # ADD THIS LINE
    && rm -rf /var/lib/apt/lists/*
```

重新构建容器：

```bash
./container/build.sh
```

### Step 7 — 初始化数据库

```bash
npx tsx marketing-agent/db/migrate.ts
```

### Step 8 — 配置 `.env`

在 NanoClaw 的 `.env` 文件中加入：

```env
DISCORD_BOT_TOKEN=<your-discord-bot-token>
DISCORD_ONLY=true
DATA_SOURCE_API_KEY=<your-twitterapiio-api-key>
```

### Step 9 — 配置 `config.yaml`

编辑 `config.yaml`（从 `config.yaml.example` 复制）：

- `monitoring.accounts_tier1`：主要监控账号
- `monitoring.accounts_partners`：合作方账号
- `monitoring.keywords`：关键词列表
- `notifications.risk_webhook_url`：#risk-alerts webhook
- `notifications.opportunities_webhook_url`：#opportunities webhook
- `notifications.ecosystem_webhook_url`：#ecosystem-feed webhook
- `notifications.draft_webhook_url`：#draft-review webhook（仍支持）
- `notifications.draft_channel`：草稿发布频道名（默认 `draft`，v2 新增）
- `notifications.digest_webhook_url`：#daily-digest webhook

### Step 10 — 注册 Discord group

首先获取 `#marketing-bot` 频道的 channel ID。启动 NanoClaw 后在该频道发一条消息，查看日志中的 `chatJid`，格式为 `dc:{channelId}`。或者用以下脚本直接列出：

```bash
npx tsx -e "
const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', async () => {
  for (const [, guild] of client.guilds.cache) {
    const channels = await guild.channels.fetch();
    for (const [id, ch] of channels) {
      if (ch && ch.isTextBased()) console.log('#' + ch.name, '→ dc:' + id);
    }
  }
  client.destroy();
});
client.login(process.env.DISCORD_BOT_TOKEN);
"
```

找到 `#marketing-bot` 对应的 `dc:{channelId}` 后，在 NanoClaw 的 `store/messages.db` 中注册 group：

```bash
npx tsx -e "
const Database = require('better-sqlite3');
const db = new Database('store/messages.db');
db.prepare(\`INSERT OR REPLACE INTO registered_groups
  (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
  VALUES (?, ?, ?, ?, ?, ?, ?)\`).run(
  'dc:CHANNEL_ID_HERE',          // ← 替换为实际 channel ID
  'marketing-alerts',
  'marketing-alerts',
  '',
  new Date().toISOString(),
  JSON.stringify({additionalMounts:[
    {hostPath:'/absolute/path/to/nanoclaw/marketing-agent/data', containerPath:'data', readonly:false},
    {hostPath:'/absolute/path/to/nanoclaw',      containerPath:'project', readonly:true}
  ]}),
  0
);
console.log('Group registered');
db.close();
"
```

> **注意**：
> - `jid` 必须是 `dc:{channelId}` 格式（不是频道名称）
> - `containerPath` 使用相对路径（代码自动拼接 `/workspace/extra/` 前缀）
> - 字段名是 `readonly`（全小写），不是 `readOnly`

将 `/absolute/path/to/nanoclaw` 替换为实际的 NanoClaw 安装路径。

还需要在 `~/.config/nanoclaw/mount-allowlist.json` 中添加允许挂载的路径：

```json
{
  "allowedRoots": [
    {
      "path": "/absolute/path/to/nanoclaw/marketing-agent/data",
      "allowReadWrite": true,
      "description": "Marketing signals database"
    },
    {
      "path": "/absolute/path/to/nanoclaw",
      "allowReadWrite": false,
      "description": "NanoClaw project config (read-only)"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": false
}
```

> **注意**：`nonMainReadOnly` 必须设为 `false`，否则 data 目录会被强制只读，SQLite 无法创建锁文件。

### Step 11 — 配置 cron 定时采集

```bash
crontab -e
```

添加：

```cron
*/30 * * * * /absolute/path/to/nanoclaw/marketing-agent/scripts/run-collector.sh
```

### Step 12 — 重启 NanoClaw

```bash
systemctl --user restart nanoclaw
```

## Discord 机器人命令

在任意频道 @mention 机器人，使用以下命令：

| 命令 | 说明 |
|------|------|
| `show signals` | 列出待审核信号（Embed 展示，含分类/置信度/情感/风险等元数据） |
| `draft reply #N` | 从任意频道查看指定信号草稿（可指定语气，如 `draft reply #N 🎉`） |
| `reject #N` | 拒绝信号 |
| `show config` | 查看当前配置 |
| `status` | 系统统计 |

### 语气按钮（信号 Embed 上直接显示，按信号类型动态变化）

每个信号类别显示不同的上下文相关按钮：

| 类别 | 按钮 1 | 按钮 2 | 按钮 3 | 按钮 4 |
|------|--------|--------|--------|--------|
| Category 1 (Solana Growth) | 🎉 Celebrate | 📊 Data Commentary | 🚀 Amplify | - |
| Category 2 (Institutional) | 🧑‍💼 Expert Analysis | 📊 Market Impact | 🙏 Welcome Aboard | 💬 Our Position |
| Category 6 (Ranking Mention) | 🙏 Thank You | 🎉 Celebrate | 📊 More Data | 💬 Add Context |
| Category 8 (Risk Event) | 💬 Fact Check | 🧑‍💼 Expert Response | 🙏 Acknowledge | 👋 Reassure |

### 交互流程

1. 信号出现在 `#needs-reply` 频道，带 3-4 个上下文相关语气按钮（第一个按钮高亮绿色）
2. 运营点击按钮 → 草稿发送到 `#draft` 频道（全员可见）
3. `#draft` 频道的草稿带有 🗑️ Delete 按钮，可删除
4. `#needs-interaction` 信号无按钮（仅信息展示）
5. 信号 Embed 底部显示 `#ID`，可用 `draft reply #N` 从任意频道查看

### 颜色标识

- `#needs-reply` 信号：🟢 绿色 Embed 边框
- `#needs-interaction` 信号：🟠 橙色 Embed 边框
- Tier 频道信号：🔵 蓝色 Embed 边框

## 自定义

### 切换数据源

编辑 `config.yaml` 的 `data_source.type`：

| 值 | 认证方式 | 适用场景 |
|----|---------|---------|
| `mock` | 无 | 本地开发测试 |
| `twitterapi_io` | `X-API-Key` | 初期上线，按量付费 |
| `twitter_v2` | Bearer Token | 官方 API，高配额需求 |

切换到 `twitter_v2`：
1. 在 [Twitter Developer Portal](https://developer.twitter.com/) 申请 Basic 或以上套餐
2. 创建 App，获取 Bearer Token
3. 在 `.env` 设置 `DATA_SOURCE_API_KEY=<your-bearer-token>`
4. 在 `config.yaml` 设置 `data_source.type: twitter_v2`

> **注意**：twitter_v2 的 `api_key` 字段存放的是 Bearer Token（不是 API Key），两者认证方式不同。

- **修改分类规则**：编辑 `marketing-agent/prompts/classification.md`（8 类信号分类 + 元数据规则）
- **调整监控账号/关键词**：编辑 `config.yaml`
- **调整采集频率**：同时修改 cron 表达式和 `config.yaml` 的 `polling_interval_minutes`

## 故障排查

| 问题 | 解决方法 |
|------|---------|
| `429 rate limit` | 降低采集频率，减少监控账号数 |
| 分类超时 | 确认 `CLAUDE_CODE_OAUTH_TOKEN` 有效，减少单批推文数 |
| Bot 无响应 | 检查 `systemctl --user status nanoclaw` 和 `logs/nanoclaw.log` |
| 数据库不可访问 | 检查 mount-allowlist 和 additionalMounts 配置 |
