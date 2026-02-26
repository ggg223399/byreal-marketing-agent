import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'skills-engine/**/*.test.ts', 'tests/**/*.test.ts', 'marketing-agent/tests/**/*.test.ts'],
  },
});
