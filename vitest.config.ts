import { coverageConfigDefaults, defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: {
      // Force single React instance to avoid duplicate-React hooks errors
      'react': path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
      'react/jsx-runtime': path.resolve(__dirname, 'node_modules/react/jsx-runtime'),
      'react/jsx-dev-runtime': path.resolve(__dirname, 'node_modules/react/jsx-dev-runtime'),
      // Console component test deps. All these packages exist at the root with
      // versions equal to or newer than console/node_modules. Resolve from root
      // so they share the root react/react-dom singletons enforced above —
      // pulling them from console/node_modules pulls a stale react@19.2.4 alongside
      // root's react-dom@19.2.5 and produces "Invalid hook call" failures.
      '@tanstack/react-query': path.resolve(__dirname, 'node_modules/@tanstack/react-query'),
      '@tanstack/react-virtual': path.resolve(__dirname, 'node_modules/@tanstack/react-virtual'),
      'framer-motion': path.resolve(__dirname, 'node_modules/framer-motion'),
      'lucide-react': path.resolve(__dirname, 'node_modules/lucide-react'),
      'qrcode': path.resolve(__dirname, 'node_modules/qrcode'),
      'react-router-dom': path.resolve(__dirname, 'node_modules/react-router-dom'),
      'react-is': path.resolve(__dirname, 'node_modules/react-is'),
      'recharts': path.resolve(__dirname, 'node_modules/recharts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Exclude the browser-mode subtrees so jsdom/node runs do not pick them up.
    // tests/browser/** runs only via vitest.browser.config.ts (npm run test:browser);
    // tests/browser-motion/** runs only via vitest.browser.motion.config.ts (F-B5-1).
    exclude: ['tests/browser/**', 'tests/browser-motion/**'],
    testTimeout: 10_000,
    setupFiles: ['./tests/setup/bot-errors-vitest-isolation.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      reporter: ['text', 'html', 'json', 'json-summary'],
      reportsDirectory: 'coverage',
      exclude: [
        ...coverageConfigDefaults.exclude,
        'tools/whatsoup_guard/**',
      ],
      thresholds: {
        lines: 88,
        branches: 80,
        functions: 87,
      },
    },
    env: {
      INSTANCE_CONFIG: '',
    },
    // vitest 4 removed test.poolOptions; the per-pool maxForks/maxThreads cap is
    // now the unified top-level maxWorkers option (applies to whichever pool runs).
    maxWorkers: 4,
  },
});
