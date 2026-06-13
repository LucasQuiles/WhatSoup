/**
 * vitest.browser.motion.config.ts — no-reduce browser context for animated-exit proofs.
 *
 * B5 C-B5-7: animated-exit proofs need a separate browser context WITHOUT
 * reducedMotion so CSS animations actually play and computed animation-duration
 * resolves to the real token value (120ms / 180ms).
 *
 * The existing vitest.browser.config.ts uses `reducedMotion: 'reduce'` as
 * deliberate determinism machinery (d7-investigation §6.1) and MUST NOT be
 * changed. This config is additive and uses a separate test include glob
 * (tests/browser-motion/**) so it never overlaps with the existing D7 suite.
 *
 * This file is intentionally NOT wired to npm scripts or the verify chain —
 * it is produced for the D7 lane to wire (as noted in the B5 packet §8.2 and
 * the evidence packet). The D7 lane owns the decision on whether to use this
 * config split or a per-test emulation route (playwright.context API).
 *
 * To run manually (for local development of the motion lane proofs):
 *   npx vitest run --config vitest.browser.motion.config.ts
 */
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },

  publicDir: path.resolve(__dirname, 'console/public'),

  plugins: [tailwindcss()],

  resolve: {
    alias: {
      'react': path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
      'react/jsx-runtime': path.resolve(__dirname, 'node_modules/react/jsx-runtime'),
      'react/jsx-dev-runtime': path.resolve(__dirname, 'node_modules/react/jsx-dev-runtime'),
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

  optimizeDeps: {
    include: [
      'vitest-browser-react',
      'react/jsx-dev-runtime',
      'react',
      'react-dom',
      'react/jsx-runtime',
    ],
  },

  test: {
    // Motion-lane subtree only (separate from tests/browser/ D7 suite).
    include: ['tests/browser-motion/**/*.test.tsx', 'tests/browser-motion/**/*.test.ts'],

    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [
        {
          browser: 'chromium',
          // NO reducedMotion here — animations must actually play so we can
          // assert computed durations and data-state="closing" dwell behavior.
          context: {},
        },
      ],
      screenshotFailures: true,
    },

    fileParallelism: false,

    // Reuse the same setup (font-ready + network sentinel).
    setupFiles: ['tests/browser/setup.ts'],

    env: {
      INSTANCE_CONFIG: '',
    },
  },
});
