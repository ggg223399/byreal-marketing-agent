# Byreal Marketing Agent

Automated Twitter/X monitoring and reply system for Byreal, packaged as a [NanoClaw](https://github.com/ggg223399/nanoclaw) skill.

## What it does

1. **Collects** tweets from Twitter/X via 4 specialized pipelines
2. **Classifies** each tweet with Claude AI (actionType, angle, tones)
3. **Routes** signals to Discord channels by priority and action needed
4. **Generates** AI reply drafts with brand-consistent tone
5. **Manages** human approve/edit/reject workflow with rate limiting

## Four Pipelines

| Pipeline | Priority | Monitors | Search Strategy |
|----------|----------|----------|-----------------|
| **mentions** | 1 (highest) | Direct Byreal mentions | `"@byreal_io"` keyword search |
| **crisis** | 2 | Security events (exploits, hacks) | Risk keywords + Solana, high engagement threshold |
| **network** | 3 | KOL/partner tweets | Account-based search by S/A/B tier |
| **trends** | 4 (lowest) | Industry narratives | Topic keyword search from `narratives.yaml` |

## Architecture

```
Twitter APIs → Collector → Classifier (Claude Sonnet) → SQLite
                                                          │
                                                    Router (Discord)
                                                          │
                                                   Generator (Claude Haiku)
                                                          │
                                                  Approval (Human review)
```

## Discord Channel Layout

### Action Channels
| Channel | Routes | UI |
|---------|--------|----|
| `#needs-reply` | reply/qrt from mentions/trends/crisis | Tone buttons + green embed |
| `#needs-interaction` | reply/qrt from network | Info only, orange embed |

### Intelligence Channels
| Channel | Routes |
|---------|--------|
| `#tier1-signals` | High priority (S-tier KOL, critical crisis) |
| `#tier2-signals` | Medium priority |
| `#tier3-signals` | Low priority |
| `#noise` | Skipped / low-value signals |
| `#periodic-summary` | Auto-generated daily summaries |

## Data Sources

| Source | Auth | Cost | Best for |
|--------|------|------|----------|
| `mock` | None | Free | Local testing |
| `twitterapi_io` | X-API-Key | $0.15/1K tweets | Getting started |
| `twitter_v2` | Bearer Token | $100/mo+ | High volume |
| `xai_search` | xAI API Key | Per-token | AI-powered collection (default) |

## Quick Start

See [SKILL.md](./SKILL.md) for full installation guide.

```bash
# 1. Apply skill to NanoClaw
cd /path/to/nanoclaw
# (follow SKILL.md Phase 2)

# 2. Configure
cp config.yaml.example config.yaml
# Edit config.yaml with your API keys and Discord channels

# 3. Run collector
npx tsx marketing-agent/collector/collect.ts --dry-run    # test
npx tsx marketing-agent/collector/collect.ts              # all 4 pipelines
npx tsx marketing-agent/collector/collect.ts --pipeline mentions  # single pipeline

# 4. Set up cron
crontab -e
# */30 * * * * cd /path/to/nanoclaw && npx tsx marketing-agent/collector/collect.ts
```

## Project Structure

```
byreal-marketing-agent/
├── manifest.yaml              # NanoClaw skill manifest
├── SKILL.md                   # Installation guide
├── config.yaml.example        # Configuration template
├── add/
│   ├── marketing-agent/       # All source code
│   │   ├── collector/         # Tweet collection (5 adapters)
│   │   ├── classifier/        # AI classification (Claude Sonnet)
│   │   ├── generator/         # Reply draft generation (Claude Haiku)
│   │   ├── notifications/     # Discord routing
│   │   ├── approval/          # Approve/edit/reject workflow
│   │   ├── governance/        # Rate limits, blacklist, risk keywords
│   │   ├── digest/            # Daily summaries
│   │   ├── db/                # SQLite schema + migrations
│   │   ├── lib/               # Claude API wrapper
│   │   ├── types/             # TypeScript type definitions
│   │   ├── config/            # accounts.yaml + narratives.yaml + loader
│   │   ├── scripts/           # Utility scripts
│   │   └── tests/             # Unit tests (vitest)
│   └── prompts/               # Classification & brand prompts
│       ├── mentions.md
│       ├── network.md
│       ├── trends.md
│       ├── crisis.md
│       └── brand_context.md
└── modify/
    └── src/channels/
        ├── discord.ts         # Discord handler with marketing integration
        └── discord.ts.intent.md
```

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/sdk` | Claude API for classification and drafts |
| `better-sqlite3` | Local signal storage |
| `discord.js` | Discord bot (via NanoClaw) |
| `yaml` | Config file parsing |

## Discord Commands

Mention the bot in any channel:

| Command | Description |
|---------|-------------|
| `show signals` | List pending signals |
| `draft reply #N` | Generate draft for signal N |
| `reject #N` | Reject signal |
| `status` | System stats |

## License

MIT
