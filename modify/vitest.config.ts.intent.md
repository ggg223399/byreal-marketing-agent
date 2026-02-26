# Intent: vitest.config.ts modifications

## What changed
Added `marketing-agent/tests/**/*.test.ts` to the test include pattern.

## Key sections
- `include` array: appended marketing-agent test glob

## Invariants
- All existing test patterns preserved
- No patterns removed or modified

## Must-keep
- All existing include patterns (src, setup, skills-engine, tests)
