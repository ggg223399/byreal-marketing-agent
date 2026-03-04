# Add Marketing Agent

This skill adds the Byreal Twitter Marketing Agent to NanoClaw — 4-pipeline AI signal classification with Discord team review workflow.

## Phase 1: Pre-flight

### Check if already applied
Read `.nanoclaw/state.yaml`. If `marketing-agent` is in `applied_skills`, skip to Phase 3 (Setup).

### Check prerequisites
- Discord skill must be applied first (`discord` in `applied_skills`)
- If not, run `/add-discord` first

### Ask the user
AskUserQuestion: Which data source will you use for tweet collection?
- **xai_search** — xAI Grok + X Search (recommended, uses xAI API key)
- **twitterapi_io** — TwitterAPI.io ($0.15/1K tweets)
- **twitter_v2** — Official Twitter API v2 ($100/month+)
- **mock** — Fake data for testing

AskUserQuestion: Do you have the API key for your chosen data source?

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)
If `.nanoclaw/` directory doesn't exist:
```bash
npx tsx -e "import { initSkillsSystem } from './skills-engine/migrate.ts'; initSkillsSystem();"
```

### Apply the skill
```bash
npx tsx -e "import { applySkill } from './skills-engine/index.ts'; applySkill('.claude/skills/add-marketing-agent').then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e); process.exit(1); });"
```

This deterministically:
- Adds `marketing-agent/` directory (collector, classifier, generator, DB, config, etc.)
- Adds `prompts/` directory (mentions, network, trends, crisis, brand_context)
- Three-way merges marketing Discord handler into `src/channels/discord.ts`
- Installs npm dependencies (better-sqlite3, yaml, @anthropic-ai/sdk)
- Runs DB migration (`marketing-agent/db/migrate.ts`)
- Runs tests

If merge conflicts in discord.ts, read `modify/src/channels/discord.ts.intent.md`.

### Validate
```bash
npm test
npm run build
```

## Phase 3: Setup

### Create Discord channels
Create these channels in your Discord server:
- `#needs-reply` — signals that need a reply (green embed + tone buttons)
- `#needs-interaction` — signals to interact with (orange embed, no buttons)
- `#tier1-signals`, `#tier2-signals`, `#tier3-signals` — priority tiers
- `#noise` — low-value signals
- `#periodic-summary` — auto-generated summaries
- `#daily-digest` — daily digest (needs Webhook for cron)

### Configure environment
Add to `.env`:
```bash
DATA_SOURCE_API_KEY=<your-api-key>
# Claude auth (one of):
CLAUDE_CODE_OAUTH_TOKEN=<oauth-token>   # preferred
# or
ANTHROPIC_API_KEY=<api-key>             # fallback
```
Sync: `cp .env data/env/env`

### Configure config.yaml
```bash
cp config.yaml.example config.yaml
```
Edit `config.yaml`:
- `data_source.type`: your chosen source (xai_search / twitterapi_io / twitter_v2 / mock)
- `notifications.*_channel`: channel names (defaults work if you used standard names)
- `notifications.digest_webhook_url`: daily-digest webhook URL
- `governance`: rate limits and blacklist

### Configure cron
```bash
crontab -e
# Add:
*/30 * * * * cd /path/to/nanoclaw && npx tsx marketing-agent/collector/collect.ts
```

## Phase 4: Registration

### Get channel ID
Enable Developer Mode in Discord (User Settings > Advanced). Right-click your marketing channel > Copy Channel ID.

### Register the group
```bash
npx tsx -e "
import Database from 'better-sqlite3';
const db = new Database('store/messages.db');
db.prepare(\`INSERT OR REPLACE INTO registered_groups
  (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
  VALUES (?, ?, ?, ?, ?, ?, ?)\`).run(
  'dc:CHANNEL_ID_HERE',
  'marketing-alerts',
  'marketing-alerts',
  '',
  new Date().toISOString(),
  JSON.stringify({additionalMounts:[
    {hostPath:'/absolute/path/to/nanoclaw/marketing-agent/data', containerPath:'data', readonly:false},
    {hostPath:'/absolute/path/to/nanoclaw', containerPath:'project', readonly:true}
  ]}),
  0
);
console.log('Group registered');
db.close();
"
```

## Phase 5: Verify

### Build and restart
```bash
npm run build
systemctl --user restart nanoclaw  # or your process manager
```

### Test
```bash
# Dry run — fetch + classify without saving
npx tsx marketing-agent/collector/collect.ts --dry-run

# Single pipeline test
npx tsx marketing-agent/collector/collect.ts --pipeline mentions --dry-run

# Insert a test signal for debugging
npx tsx marketing-agent/scripts/test-signal.ts

# Run full 4-pipeline collection
npx tsx marketing-agent/collector/collect.ts
```

### Check logs
```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `429 rate limit` | Lower polling frequency, reduce monitored accounts |
| Classification timeout | Check `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is valid |
| Bot not responding | Check `systemctl --user status nanoclaw` and logs |
| Merge conflict in discord.ts | Read `modify/src/channels/discord.ts.intent.md` for guidance |
| No signals appearing | Check data source API key, try `--dry-run` to see raw output |

## Discord Commands

| Command | Description |
|---------|-------------|
| `show signals` | List pending signals |
| `draft reply #N` | Generate draft for signal N |
| `reject #N` | Reject signal |
| `status` | System stats |
