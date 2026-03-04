# Marketing Agent — Architecture

> For project owners: understand how the system works in 15 minutes.

## One-line Summary

**Marketing Agent is an automated Twitter/X social media monitoring and reply system**: it periodically fetches tweets related to Byreal from Twitter, classifies each tweet with Claude AI, routes results to different Discord channels for review, and supports approve/edit/reject workflow for AI-generated reply drafts.

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Marketing Agent Data Flow                        │
│                                                                     │
│  ┌──────────┐    ┌──────────────┐    ┌──────────┐    ┌───────────┐ │
│  │ Twitter  │───>│  Collector   │───>│Classifier│───>│  SQLite   │ │
│  │  APIs    │    │ (fetch tweets)│    │(AI class) │    │ (storage) │ │
│  └──────────┘    └──────────────┘    └──────────┘    └─────┬─────┘ │
│                                                            │       │
│       5 adapters:                    Claude Sonnet judges:  │       │
│       - mock (test)                  · pipeline             │       │
│       - twitterapi_io                · actionType           │       │
│       - twitter_v2                   · angle                │       │
│       - xpoz                        · tones                 │       │
│       - xai_search (default)                               │       │
│                                                            ▼       │
│  ┌───────────┐    ┌──────────────┐    ┌──────────────────────────┐ │
│  │ Generator │<───│  Approval    │<───│  Notification Router     │ │
│  │(AI drafts)│    │ (workflow)   │    │  (Discord channel route) │ │
│  └───────────┘    └──────────────┘    └──────────────────────────┘ │
│       │                │                                           │
│       │  Claude Haiku   │  rate limit                              │
│       │  generates      │  blacklist check                         │
│       │  reply drafts   │  hourly/daily caps                       │
│       ▼                ▼                                           │
│  ┌──────────────────────────────────┐                              │
│  │  Discord Channels (human review) │                              │
│  │  · needs-reply                   │                              │
│  │  · needs-interaction             │                              │
│  │  · tier1/2/3-signals            │                              │
│  │  · noise                         │                              │
│  │  · periodic-summary              │                              │
│  └──────────────────────────────────┘                              │
└─────────────────────────────────────────────────────────────────────┘
```

## Four Pipelines

The core concept. Each pipeline monitors different tweet types:

| Pipeline | Priority | Monitors | Search Strategy | Unique Field |
|----------|----------|----------|-----------------|--------------|
| **mentions** | 1 (highest) | Direct Byreal mentions | `"Byreal" OR "@byreal_io"` | — |
| **crisis** | 2 | Security events (exploit, hack, rug pull) | Risk keywords + Solana, high engagement threshold | `severity`: critical/high/medium |
| **network** | 3 | KOL/partner tweets | Account-based search by S/A/B tier | `accountTier`: S/A/B |
| **trends** | 4 (lowest) | Industry narratives | Topic keywords from `narratives.yaml` | `connection`: direct/indirect/stretch |

## File Map

```
add/marketing-agent/
├── config/
│   ├── loader.ts          # Reads config.yaml, accounts.yaml, narratives.yaml
│   ├── accounts.yaml      # KOL account list (S/A/B tiers)
│   └── narratives.yaml    # Trend topic config (keywords + descriptions)
├── collector/
│   ├── collect.ts         # Main entry — fetch tweets per pipeline → classify → store
│   └── adapters/          # 5 Twitter API adapters
│       ├── mock.ts        # Test data
│       ├── twitterapiio.ts
│       ├── twitter-v2.ts
│       ├── xpoz.ts
│       └── xai-search.ts  # xAI Grok API (default)
├── classifier/
│   └── classify.ts        # Claude Sonnet classification
│                          # Reads prompts/{pipeline}.md as system prompt
│                          # Returns actionType + angle + tones
├── generator/
│   └── draft.ts           # Claude Haiku reply drafts
│                          # Reads prompts/brand_context.md for brand voice
├── notifications/
│   └── router.ts          # Routes signals to Discord channels
│                          # Based on actionType + pipeline + tier/severity
├── approval/
│   └── workflow.ts        # Approve/edit/reject + rate limit checks
├── governance/
│   └── filters.ts         # Blacklist + risk keyword flagging
├── digest/
│   ├── generate.ts        # Daily stats summary generation
│   └── run-digest.ts      # Standalone digest runner
├── db/
│   ├── index.ts           # SQLite data layer (better-sqlite3)
│   ├── migrate.ts         # Schema migrations
│   └── schema.sql         # Tables: signals, approvals, audit_log, rate_limits
├── lib/
│   └── claude-client.ts   # Claude API wrapper
│                          # Primary: Claude CLI (OAuth token)
│                          # Fallback: Anthropic API direct
├── types/
│   └── index.ts           # All TypeScript type definitions
├── scripts/
│   └── test-signal.ts     # Insert test signal for debugging
└── tests/                 # Unit tests (vitest)

add/prompts/               # Placed at nanoclaw root prompts/
├── mentions.md            # Mentions pipeline classification prompt
├── network.md             # Network pipeline classification prompt
├── trends.md              # Trends pipeline prompt (has {{NARRATIVE_SUMMARY}} placeholder)
├── crisis.md              # Crisis pipeline classification prompt
└── brand_context.md       # Brand context for reply generation
```

## Pipeline Execution

### Step 1: Collection (collector/collect.ts)

Main entry point, runs as standalone script:

```bash
npx tsx marketing-agent/collector/collect.ts              # all 4 pipelines
npx tsx marketing-agent/collector/collect.ts --pipeline mentions  # single
npx tsx marketing-agent/collector/collect.ts --dry-run    # no DB writes
```

Flow:
1. Load `config.yaml`
2. Build search queries per pipeline (each has different keywords/accounts)
3. Call Twitter API adapter to fetch tweets
4. Batch-classify with Claude (10 tweets per batch)
5. Upsert to SQLite (merge `pipelines` array if same tweet found by multiple pipelines)

### Step 2: Classification (classifier/classify.ts)

Uses Claude Sonnet to analyze each tweet:
- **Input**: tweet list + pipeline-specific system prompt from `prompts/{pipeline}.md`
- **Output** per tweet:
  - `actionType`: reply / qrt / like / monitor / skip (varies by pipeline)
  - `angle`: engagement angle
  - `tones`: 1-3 tone suggestions (id + label + description)
  - Pipeline-specific: `connection` / `accountTier` / `severity`

Valid actionTypes by pipeline:

| Pipeline | Valid actionTypes |
|----------|-----------------|
| mentions | reply, qrt, like, monitor, skip |
| network | reply, qrt, like, monitor, skip |
| trends | qrt, reply, statement, skip |
| crisis | statement, monitor, skip |

### Step 3: Notification Routing (notifications/router.ts)

| actionType | pipeline | Target Channel |
|------------|----------|---------------|
| reply/qrt/statement | mentions/trends/crisis | `needs-reply` |
| reply/qrt/statement | network | `needs-interaction` |
| like/monitor | by tier/severity/connection | `tier1/2/3-signals` |
| skip | any | `noise` |

### Step 4: Draft Generation (generator/draft.ts)

Uses Claude Haiku (fast, cheap) to generate reply drafts:
- Reads `prompts/brand_context.md` for brand context
- Generates tone-specific variations
- 280 character limit
- Hardcoded fallback templates if API unavailable

### Step 5: Approval (approval/workflow.ts)

- `approve`: publish AI draft as-is
- `edit`: modify then publish
- `reject`: archive
- Governed by hourly/daily rate limits
- All actions logged to `audit_log` table

## Storage (Upsert Logic)

`insertSignal` handles three cases:
- tweet_id not found → INSERT, `pipelines = [current]`
- tweet_id exists + new pipeline → UPDATE, append to pipelines array
- tweet_id exists + same pipeline → UPDATE, refresh classification

## Relationship with NanoClaw

Marketing Agent is a **loosely coupled subsystem**:
- **Own entry points**: `collect.ts`, `run-digest.ts` run independently
- **Own database**: uses `data/signals.db`, not NanoClaw's SQLite
- **Shared repo**: lives in NanoClaw git repo, shares `.env` and `config.yaml`
- **Shared credentials**: same `CLAUDE_CODE_OAUTH_TOKEN`
- **NanoClaw triggers it**: via scheduled tasks calling collect script

## Key Credentials

| Credential | Purpose | Config |
|-----------|---------|--------|
| Twitter API | Fetch tweets | `config.yaml → data_source.api_key` or env `DATA_SOURCE_API_KEY` |
| Claude API | Classification + drafts | env `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` |
| Discord Webhooks | Push notifications | `config.yaml → notifications` channel names |
| SQLite | Local storage | Default `data/signals.db`, override with env `DB_PATH` |

## Things You'll Forget

1. **Three config files**: `config.yaml` (main), `config/accounts.yaml` (KOL list), `config/narratives.yaml` (trend topics)
2. **Prompts at nanoclaw root**: `prompts/mentions.md` etc., not inside marketing-agent/
3. **Two Claude paths**: CLI (OAuth token) preferred, direct API (API key) fallback
4. **Sonnet for classification, Haiku for generation**: accuracy vs speed/cost tradeoff
5. **Same tweet can appear in multiple pipelines**: deduplicated via `pipelines` array upsert
6. **Test signal command**: `npx tsx marketing-agent/scripts/test-signal.ts`
