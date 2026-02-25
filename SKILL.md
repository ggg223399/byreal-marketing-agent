---
name: byreal-marketing-agent
description: Byreal Twitter 营销情报 Agent — 定时采集推文、AI 分类、Discord 团队审核流程。触发词："install marketing agent"、"营销 agent"、"byreal marketing"。
---

# Byreal Marketing Agent Skill

一个面向非技术营销团队的 Twitter 情报与 Discord 协作系统。

## 概览

- 定时从 TwitterAPI.io 抓取指定账号与关键词的推文
- 用 Claude Haiku 做 3 分类：`reply_needed` / `watch_only` / `ignore`
- 信号存入 SQLite，按告警等级路由到 Discord 频道
- Discord 机器人命令：查看信号、起草回复、批准/拒绝

## 前置条件

在开始安装前确认：

1. NanoClaw 已部署并运行（Discord 集成已配置）
2. 已有 TwitterAPI.io 账户和 API key
3. Discord server 已创建以下频道和 webhook：
   - `#marketing-bot`（机器人交互，注册为 NanoClaw group）
   - `#urgent-signals`（紧急告警 webhook）
   - `#daily-digest`（日报 webhook）
   - `#all-signals`（全量信号 webhook）
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
5. 左侧菜单 → 「OAuth2」→ 「URL Generator`
   - Scopes 勾选 `bot`
   - Bot Permissions 勾选 `Send Messages`、`Read Message History`、`View Channels`
   - 复制生成的 URL，在浏览器打开，选择你的 Server，授权

### 准备 2：创建 Discord Webhook

1. 在 Discord Server 里创建 3 个频道（如果还没创建）：
   - `#all-signals`
   - `#urgent-signals`
   - `#daily-digest`
2. 对每个频道：右键频道名 → 「Edit Channel」→ 「Integrations」→ 「Webhooks」→ 「New Webhook`
3. 复制每个 Webhook URL，后面填入 `config.yaml`

### 准备 3：获取 TwitterAPI.io API Key

1. 打开 https://twitterapi.io → 注册账号
2. 进入 Dashboard → 复制 API Key
3. 按量计费 $0.15/1K tweets，新账户通常有免费额度

## 安装步骤


### Step 1 — 克隆 Skill 并复制文件

```bash
# 克隆 skill 仓库到临时目录
git clone https://github.com/ggg223399/byreal-marketing-agent /tmp/byreal-marketing-agent

# 进入你的 NanoClaw 根目录
cd /path/to/your/nanoclaw

# 复制所有 skill 文件
cp -r /tmp/byreal-marketing-agent/{collector,classifier,generator,approval,notifications,digest,governance,lib,types,db,config,prompts,tests,scripts,groups} ./
mkdir -p src/channels
cp /tmp/byreal-marketing-agent/src/channels/discord.ts src/channels/discord.ts
cp /tmp/byreal-marketing-agent/config.yaml.example config.yaml
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
      'tests/**/*.test.ts',   // ADD THIS
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
npx tsx db/migrate.ts
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
- `notifications.*_webhook_url`：填入真实 Discord webhook URL

### Step 10 — 注册 Discord group

在 NanoClaw 的 `store/messages.db` 中注册 `marketing-alerts` group：

```bash
sqlite3 store/messages.db "INSERT OR REPLACE INTO registered_groups
  (group_id, group_name, channel_type, container_config)
  VALUES (
    'marketing-alerts',
    'marketing-alerts',
    'discord',
    '{\"additionalMounts\":[
      {\"hostPath\":\"/absolute/path/to/data\",\"containerPath\":\"/workspace/extra/data\",\"readOnly\":false},
      {\"hostPath\":\"/absolute/path/to/project\",\"containerPath\":\"/workspace/extra/project\",\"readOnly\":true}
    ]}'
  );"
```

将 `/absolute/path/to/data` 和 `/absolute/path/to/project` 替换为实际路径。

还需要在 `~/.config/nanoclaw/mount-allowlist.json` 中添加允许挂载的路径：

```json
{
  "allowedPaths": [
    "/absolute/path/to/data",
    "/absolute/path/to/project"
  ]
}
```

### Step 11 — 配置 cron 定时采集

```bash
crontab -e
```

添加：

```cron
*/30 * * * * /absolute/path/to/nanoclaw/scripts/run-collector.sh
```

### Step 12 — 重启 NanoClaw

```bash
systemctl --user restart nanoclaw
```

## Discord 机器人命令

在 `#marketing-bot` 频道 @mention 机器人，使用以下命令：

| 命令 | 说明 |
|------|------|
| `show signals` | 列出待审核信号 |
| `draft reply #N` | 为信号 N 生成回复草稿 |
| `approve #N professional` | 批准（专业语气） |
| `approve #N friendly` | 批准（友好语气） |
| `approve #N custom: text` | 批准（自定义文案） |
| `reject #N` | 拒绝信号 |
| `show config` | 查看当前配置 |
| `status` | 系统统计 |

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

- **修改分类规则**：编辑 `prompts/classification.md`
- **调整监控账号/关键词**：编辑 `config.yaml`
- **调整采集频率**：同时修改 cron 表达式和 `config.yaml` 的 `polling_interval_minutes`

## 故障排查

| 问题 | 解决方法 |
|------|---------|
| `429 rate limit` | 降低采集频率，减少监控账号数 |
| 分类超时 | 确认 `CLAUDE_CODE_OAUTH_TOKEN` 有效，减少单批推文数 |
| Bot 无响应 | 检查 `systemctl --user status nanoclaw` 和 `logs/nanoclaw.log` |
| 数据库不可访问 | 检查 mount-allowlist 和 additionalMounts 配置 |
