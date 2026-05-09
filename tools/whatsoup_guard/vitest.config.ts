import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
