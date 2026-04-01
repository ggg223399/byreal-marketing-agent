# Thread Display V1

## Context

To keep the next version stable, thread-aware rendering is implemented only in the Discord presentation layer.

Current v1 behavior:

- Detect merged threads by splitting `signal.content` on `\n---\n`
- Show only one selected post in the main Discord card
- Add a `Thread · N posts` label to the card
- Keep normal single-tweet rendering unchanged

## TODO

- Move thread presentation selection out of Discord and into a persisted presentation snapshot once the rule is stable
- Capture explicit per-post thread structure upstream instead of inferring from merged content
- Replace heuristic post selection with a deterministic `displayPost` chosen before notification delivery
