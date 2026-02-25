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

在 `readEnvFile([...])` 的数组末尾加入两个新字段：

```typescript
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'DISCORD_BOT_TOKEN',   // ADD THIS
  'DISCORD_ONLY',         // ADD THIS
]);
```

在文件末尾追加：

```typescript
// Discord configuration
export const DISCORD_BOT_TOKEN =
  process.env.DISCORD_BOT_TOKEN || envConfig.DISCORD_BOT_TOKEN || '';
export const DISCORD_ONLY =
  (process.env.DISCORD_ONLY || envConfig.DISCORD_ONLY) === 'true';
```

### Step 4 — 修改 `src/index.ts`

在 imports 区加入：

```typescript
import { DISCORD_BOT_TOKEN, DISCORD_ONLY } from './config.js';
import { DiscordChannel } from './channels/discord.js';
```

找到 main() 函数中创建 channels 的代码块（原代码）：

```typescript
// Create and connect channels
whatsapp = new WhatsAppChannel(channelOpts);
channels.push(whatsapp);
await whatsapp.connect();
```

替换为：

```typescript
// Create and connect channels
if (DISCORD_BOT_TOKEN) {
  const discord = new DiscordChannel(DISCORD_BOT_TOKEN, channelOpts);
  channels.push(discord);
  await discord.connect();
}
if (!DISCORD_ONLY) {
  whatsapp = new WhatsAppChannel(channelOpts);
  channels.push(whatsapp);
  await whatsapp.connect();
}
```

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
