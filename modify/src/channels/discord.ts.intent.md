# Intent: src/channels/discord.ts modifications

## What changed
Replaced the generic NanoClaw DiscordChannel with a marketing-specific version that adds:
- Signal polling (30s interval) from SQLite DB -> Discord channel routing
- Per-category contextual tone buttons on signal embeds
- Draft generation flow (tone button -> #draft channel)
- Periodic summary scheduling (9AM + 6PM SGT)
- Color-coded embeds (green=needs-reply, orange=needs-interaction, blue=tier)
- Delete button on draft messages
- `draft reply #N` text command from any channel

## Key sections
- Imports: discord.js, better-sqlite3, marketing-agent modules
- CATEGORY_BUTTONS: per-category tone button definitions
- buildToneButtonRow: dynamic button row builder
- buildDraftEmbed: draft embed with original tweet content
- DiscordChannel class: implements Channel interface with marketing features
- Signal polling loop: checks DB for unnotified signals
- Button interaction handler: tone selection -> draft generation
- Summary scheduler: cron-like scheduling for periodic summaries

## Invariants
- Still implements the Channel interface (name, connect, sendMessage, disconnect)
- Still handles message routing via onMessage callback
- Still supports trigger pattern matching for registered groups
- Preserves all base Discord functionality (connect, auth, message send/receive)

## Must-keep
- Channel interface compliance
- Trigger pattern support
- Message content intent handling
- Graceful disconnect
