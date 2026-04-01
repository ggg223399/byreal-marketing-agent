# Marketing Agent — v5 Signal Pipeline

Social media signal processing engine for Byreal. Monitors X (Twitter) for brand mentions, ecosystem activity, explore-worthy narratives, collaboration opportunities, and crisis events via xAI Responses API, then classifies and routes signals to Discord channels for human review.

## Architecture

```
Source → pre_filter → Judge → Reactor → Route → DB → Discord
(xAI)    (regex)      (LLM)   (LLM)     (rules)       (polling)
```

**Four-layer pipeline:**

| Layer | What it does | Config | Output |
|-------|-------------|--------|--------|
| **Source** | Searches X via xAI | `sources.yaml` | Raw tweets |
| **Judge** | Grades importance | `judge.yaml` | `alertLevel` (red/orange/yellow/none) |
| **Reactor** | Decides response strategy | `reactor.yaml` | `suggestedAction` + `tones[]` + `replyAngle` |
| **Route** | Maps labels to channels | `routing.yaml` | Discord channel name |

Operations team edits YAML configs. No code changes needed for:
- Adding search directions, keywords, accounts
- Changing classification rules
- Adjusting response strategies
- Modifying channel routing

`brand_context.md` is also operator-editable via Discord `/config` and the same
download/upload rollback flow used for config files.

### Schema Design

- **Routing fields are enum-locked**: `alertLevel` (Judge) and `suggestedAction` (Reactor) are fixed enums. Routing is fully deterministic.
- **Generator fields are semi-structured**: `tones[]` has locked structure (`{id, label, description}`) but content is LLM-generated. `replyAngle` is free text.
- **Generator is on-demand**: Not part of the pipeline. Triggered by Discord button clicks to produce tweet drafts.

## Project Structure

```
marketing-agent/
├── engine/                  # Core pipeline (~720 lines)
│   ├── index.ts             # createEngine() factory, cron orchestration
│   ├── pipeline.ts          # processSource() — full pipeline flow
│   ├── judge.ts             # LLM classification (alertLevel + reasoning)
│   ├── reactor.ts           # LLM response strategy (action + tones + angle)
│   ├── router.ts            # Deterministic label→channel routing
│   ├── searcher.ts          # xAI Responses API adapter
│   ├── enrichment.ts        # Legacy metrics backfill path (disabled in production)
│   ├── config-loader.ts     # YAML loading, validation, template vars
│   ├── output-schema.ts     # LLM output validation (enum/string/array)
│   ├── cron.ts              # node-cron job management
│   └── types.ts             # All v5 type definitions
├── generator/
│   └── draft.ts             # On-demand tweet draft generation (Claude API)
├── db/
│   ├── index.ts             # SQLite queries, v4↔v5 field mapping
│   ├── migrate.ts           # Schema migrations (v4→v5, enrichment compatibility)
│   └── schema.sql           # Authoritative table definitions
├── config/                  # Operational configs (YAML)
│   ├── sources.yaml         # Search directions + schedules
│   ├── judge.yaml           # Classification rules + output schema
│   ├── reactor.yaml         # Response rules + brand context ref
│   ├── routing.yaml         # Action→channel mapping
│   ├── enrichment.yaml      # Legacy enrichment config (kept for compatibility)
│   ├── generator.yaml       # Draft generation model/temperature
│   └── accounts.yaml        # Monitored X accounts by group
├── collector/adapters/      # Data source adapters (xAI, mock, etc.)
├── types/
│   └── index.ts             # Shared types (PipelineSignal, ToneItem, etc.)
├── docs/
│   └── signal-pipeline-architecture.md  # Detailed architecture doc
└── tests/                   # Vitest test suite
```

Claude calls are provided by nanoclaw's shared SDK layer at `src/claude-sdk.ts`; `marketing-agent` does not maintain its own provider client.

## Config Files

### sources.yaml
Defines what to search and when. Each source has a name, cron schedule, and search prompt.

```yaml
sources:
  - name: direct-mentions
    schedule: "*/15 * * * *"
    prompt: "Search for tweets mentioning Byreal..."

  - name: ecosystem-core
    schedule: "*/30 * * * *"
    prompt: "Search core partner accounts..."
    accounts_ref: config/accounts.yaml
    groups: [core]
    skip_judge: true           # Core accounts skip LLM, go straight to routing
    default_labels:
      alertLevel: orange
      suggestedAction: reply_supportive
```

### judge.yaml
Natural language classification rules. Operations team writes in plain language what makes a tweet red/orange/yellow/none.

### reactor.yaml
Response strategy rules + brand context. Decides `suggestedAction` (`reply_supportive` / `qrt_positioning` / `collab_opportunity` / `like_only` / `explore_signal` / `escalate_internal` / `none`), generates 2-3 `tones` options, and writes a `replyAngle` direction.

### routing.yaml
Maps `suggestedAction` to Discord channels. First-match-wins, with optional `continue` for multi-channel routing.

### generator.yaml
Controls the draft generation model, temperature, and brand context path.

## Running

The engine runs as a systemd service (`nanoclaw-engine.service`). Discord delivery is handled by the main `nanoclaw.service`.

```bash
# Build
npm run build

# Run one source immediately (without waiting for cron)
npm run marketing:collect -- --source crisis

# Run tests
npm test

# Type check
npm run typecheck
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATA_SOURCE_API_KEY` | Yes | xAI Responses API key |
| `CLAUDE_CODE_OAUTH_TOKEN` | Preferred | Claude OAuth token for Judge/Reactor/Generator via nanoclaw shared Claude layer |
| `ANTHROPIC_API_KEY` | Optional fallback | Direct Claude API key if OAuth is not available |
| `DISCORD_TOKEN` | Yes | Discord bot token (Tahoe Bot) |
| `DB_PATH` | No | SQLite database path (default: `data/signals.db`) |

## Enrichment

Deprecated path. Enrichment remains in the codebase for compatibility, but production runs with it disabled and the feature is not used for the `trending` channel anymore.

Config: `enrichment.yaml` (schedule, delay, batch_size, trending thresholds).

## xAI Rate Limits

The xAI search adapter intentionally does **not** retry on HTTP `429`.
When rate limited, it skips that polling call and returns no tweets for the batch.
This is a deliberate cost-control feature to avoid spending extra xAI calls during transient limits.

## Deployment

VPS: `159.69.54.136`, user `claw`, dir `/home/claw/nanoclaw-marketing/`

```bash
# Deploy via git push
git push vps main

# Manual restart
ssh -i ~/Work/openclaw_ssh claw@159.69.54.136 \
  'source ~/.nvm/nvm.sh && systemctl --user restart nanoclaw-engine'

# Manual collect on VPS (from deploy dir)
ssh -i ~/Work/openclaw_ssh claw@159.69.54.136 \
  'cd /home/claw/nanoclaw-marketing && source ~/.nvm/nvm.sh && node dist/marketing-agent/scripts/manual-collect.js --source crisis'
```

## Docs

- [Signal Pipeline Architecture](docs/signal-pipeline-architecture.md) — detailed design doc
- [Architecture Patterns Research](docs/architecture-patterns-research.md) — design research
