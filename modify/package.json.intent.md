# Intent: package.json modifications

## What changed
The `build` script now runs a cross-platform sync step after `tsc`: `node marketing-agent/scripts/sync-build-output.mjs`.

## Key sections
- `scripts.build`: changed from `tsc` to `tsc && node marketing-agent/scripts/sync-build-output.mjs`

## Invariants
- All non-`build` scripts are preserved exactly
- Dependencies and devDependencies remain unchanged
- Node engine constraint remains unchanged

## Must-keep
- The sync script runs after `tsc` in the same `build` command
- No other `package.json` fields are modified unless required by core changes
