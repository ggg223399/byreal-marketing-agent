# package.json modification intent

## What changed
The `build` script needs a post-build step to sync compiled `.js` files from `dist/marketing-agent/` back to `marketing-agent/`.

## Why
The marketing-agent `.ts` files use `.js` extension in imports (ESM convention). The cron collector runs via `npx tsx` which needs `.js` files present alongside `.ts` files. Without syncing, editing a `.ts` file and running `npm run build` leaves stale `.js` files in `marketing-agent/`, causing the Discord bot to use outdated code.

## How to merge
Change the `build` script in `package.json` from:
```json
"build": "tsc"
```
to:
```json
"build": "tsc && cd dist/marketing-agent && find . \\( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \\) -exec cp --parents {} ../../marketing-agent/ \\;"
```

Only the `build` script changes. All other fields remain untouched.
