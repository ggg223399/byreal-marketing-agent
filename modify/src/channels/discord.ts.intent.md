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
- SIGNAL_CATEGORIES: 8 category definitions with emojis
- buildSignalEmbed: unified signal card layout
  - Title: `@author - Category` with hyperlink (no emoji, no ID)
  - Fields: Priority·Confidence and Risk·Sentiment (2 inline pairs)
  - Footer: `Signal #ID` with timestamp
  - Content: tweet text + View Tweet link + separator line
- buildDraftReplyEmbed: draft embed with tone label and generated reply
- buildToneActionRow: 5 buttons in one row (4 tones + Context button)
- buildFeedbackSelectRow: signal feedback dropdown (Not Relevant, Wrong Category, etc.)
- buildProcessedSignalEmbed: greyed-out embed after feedback submitted
- DiscordChannel class: implements Channel interface with marketing features
- Signal polling loop: checks DB for unnotified signals
- Button interaction handler: tone selection -> draft generation
- Summary scheduler: cron-like scheduling for periodic summaries
- Emoji stripping: space-based split for cleaning author names

## UI Changes (Latest)
### Signal Embed Layout
- **Title**: `@author - Category` with hyperlink (clean, no emoji, no ID)
- **Fields**: 
  - Priority · Confidence (inline)
  - Risk · Sentiment (inline)
- **Footer**: `Signal #ID` with timestamp
- **Body**: Tweet content + [View Tweet] link + separator line
- **Color**: Based on alert level (red/orange/yellow/none -> green border)

### Button Layout
- **Single row with 5 buttons** (4 tone buttons + Context button)
- First tone button highlighted green (ButtonStyle.Success)
- Context button uses ButtonStyle.Secondary

### Draft Embed
- Twitter blue color (0x1DA1F2)
- Author info with hyperlink
- Safe draft text (backticks escaped)
- Footer: `Draft Reply · {toneLabel} · #{signalId}`

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
