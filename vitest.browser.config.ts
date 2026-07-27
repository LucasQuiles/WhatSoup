/**
 * vitest.browser.config.ts — browser-mode configuration for D7 test suites.
 *
 * Separate from vitest.config.ts (jsdom/node) so the existing 2,120-test suite
 * is completely untouched. This config:
 *   - Uses the esbuild JSX transform (proven by the 132 console component test
 *     files under the root jsdom suite — no @vitejs/plugin-react needed here).
 *   - Adds @tailwindcss/vite for CSS processing (vite-7 compatible; the
 *     console's @tailwindcss/vite requires vite ^8 and cannot be imported here
 *     — see d7-investigation.md §0.3 for the vite-split rationale).
 *   - Serves self-hosted Geist fonts via publicDir so text-metric assertions
 *     are identical on macOS-local and ubuntu-CI (no system-font variance).
 *   - Runs a single chromium instance, files sequential (fileParallelism:false),
 *     reduced-motion enabled — geometry assertions hit end-states on first paint.
 *
 * DO NOT add this config's include glob to vitest.config.ts — the browser
 * subtree runs ONLY through npm run test:browser.
 */
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  // esbuild JSX: same transform the root config uses for console component tests.
  // @vitejs/plugin-react is NOT imported — it requires vite ^8 (console-only).
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },

  // Serve Geist woff2 from console/public so /fonts/... references resolve.
  // fonts.css declares @font-face with src: url('/fonts/Geist-Regular.woff2') etc.
  publicDir: path.resolve(__dirname, 'console/public'),

  plugins: [
    // tailwindcss vite plugin processes console/src/index.css (@import "tailwindcss").
    // Root install is vite-7 compatible; console install is vite-8 only (separate tree).
    tailwindcss(),
  ],

  resolve: {
    alias: {
      // Mirror the alias block from vitest.config.ts to guarantee the same
      // single-React-instance guarantee in browser mode.
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

  // Pre-optimize deps that the browser runner discovers dynamically to avoid
  // mid-test Vite reloads (which cause "Failed to fetch dynamically imported
  // module" errors on the first run after config changes).
  optimizeDeps: {
    include: [
      'vitest-browser-react',
      'react/jsx-dev-runtime',
      'react',
      'react-dom',
      'react/jsx-runtime',
      // Additional deps discovered during viewport-matrix tests.
      // Without these, Vite restarts mid-test causing double-React-instance
      // "Invalid hook call" errors and QueryClient context failures.
      'recharts',
      '@tanstack/react-virtual',
      '@tanstack/react-query',
      'react-router-dom',
      'framer-motion',
    ],
  },

  test: {
    // Browser-mode subtree only.
    include: ['tests/browser/**/*.test.tsx', 'tests/browser/**/*.test.ts'],

    // Single chromium instance, sequential files — deterministic geometry.
    browser: {
      enabled: true,
      // The playwright provider takes context options at the FACTORY level
      // (provider options — see @vitest/browser-playwright types), not the
      // instance config; `instances[].context` was never read (b-10 probe:
      // matchMedia did NOT match). Corrected + probe-pinned.
      provider: playwright({
        contextOptions: {
          // reducedMotion: 'reduce' makes CSS animations resolve to end-state
          // on first paint so geometry assertions are stable (d7-investigation §6.1).
          reducedMotion: 'reduce',
        },
      }),
      headless: true,
      instances: [
        {
          browser: 'chromium',
        },
      ],
      // Screenshot on failure for CI artifact upload.
      screenshotFailures: true,
    },

    // One file at a time — the single chromium instance is the determinism anchor.
    fileParallelism: false,

    // Setup file: document.fonts.ready await + network sentinel.
    setupFiles: ['tests/browser/setup.ts'],

    // No INSTANCE_CONFIG env needed for browser tests; inherit root defaults.
    env: {
      INSTANCE_CONFIG: '',
    },
  },
});
