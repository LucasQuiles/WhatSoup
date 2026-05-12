import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
