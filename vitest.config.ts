import { defineConfig } from 'vitest/config';
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
