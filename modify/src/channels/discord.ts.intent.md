# discord.ts — Marketing Agent Integration

## What this modifies

`src/channels/discord.ts` — the NanoClaw Discord channel handler.

## Changes from base NanoClaw

This file extends the base Discord channel with marketing-agent specific features:

1. **Signal Action Cards** — Embeds for marketing signals with pipeline-colored borders, tweet content, author info, angle/reason analysis, and tweet images
2. **Tone Selection Buttons** — Per-signal tone buttons (e.g., Helpful Expert, Friendly Peer) that trigger AI draft generation
3. **Draft Reply Threading** — AI-generated reply drafts posted as thread replies to the original signal card
4. **Approval Workflow UI** — Approve/Edit/Reject buttons on draft messages with modal editing support
5. **Pipeline-aware Routing** — Color coding and channel routing based on signal pipeline (mentions/network/trends/crisis)
6. **Marketing Signal Types** — Imports `ActionType`, `Pipeline`, `PipelineSignal`, `ToneItem` from `marketing-agent/types/`

## Key additions vs base discord.ts

- `DraftSignal` type extending `PipelineSignal`
- `buildActionCardEmbed()` — signal card embed builder
- `buildToneButtons()` — tone selection row builder
- `parseSignalTones()` — normalize tone data from DB/JSON
- `parseToneActionCustomId()` — parse `ma_tone:{toneId}:{signalId}` button IDs
- `pipelineColor()` — color mapping for pipeline types
- `getTweetCreatedAt()` — extract tweet timestamp from various formats
- Interaction handlers for tone selection, approval, editing, rejection
