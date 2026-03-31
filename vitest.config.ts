import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    env: {
      INSTANCE_CONFIG: '',
    },
    poolOptions: {
      forks: { maxForks: 4 },
      threads: { maxThreads: 4 },
    },
  },
});
