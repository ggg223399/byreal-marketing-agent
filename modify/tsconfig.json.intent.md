# Intent: tsconfig.json modifications

## What changed
Expanded rootDir from `./src` to `.` and added `marketing-agent/**/*` to the include array so TypeScript compiles the marketing-agent module. Added test file exclusions.

## Key sections
- `rootDir`: changed from `./src` to `.` to allow imports from marketing-agent at the project root
- `include` array: appended `marketing-agent/**/*` glob
- `exclude` array: added `**/*.test.ts` and `**/__tests__` to keep test files out of the build

## Invariants
- All existing compiler options preserved
- Original `src/**/*` include pattern kept
- `node_modules` and `dist` exclusions kept

## Must-keep
- All existing compilerOptions values
- `src/**/*` in include array
- `node_modules` and `dist` in exclude array
