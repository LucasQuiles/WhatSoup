/**
 * tests/browser/setup.ts — global setup for the D7 browser suite.
 *
 * Two responsibilities:
 *
 * 1. document.fonts.ready — awaited once per file before any test runs.
 *    Self-hosted Geist woff2 is served by the vitest vite server from
 *    console/public (publicDir in vitest.browser.config.ts). Awaiting the
 *    promise means text-metric assertions (scrollWidth, truncation) are stable
 *    rather than racy against the late swap-in of a web font.
 *
 * 2. Network sentinel — patches window.fetch and WebSocket to throw a named
 *    error if any /api or /ws URL is accessed. This enforces the no-backend
 *    strategy: every hook that reaches the fleet server must be stubbed at the
 *    module level. An unmocked path fails LOUDLY at the call site instead of
 *    silently exercising the dev-mode mock-fallback in lib/api.ts
 *    (d7-investigation §0.8c, §6.6).
 *
 * The sentinel itself is tested implicitly by the C-D7-1 smoke: if the sentinel
 * were wrong (throwing on all fetches, not just /api), the module-mock harness
 * would trigger it on its own internal vite requests and the test would fail
 * with the sentinel error rather than the intended assertion — exposing a
 * sentinel bug without a dedicated negative test file.
 */
import { beforeAll } from 'vitest';

// ---------------------------------------------------------------------------
// 1. Font readiness
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await document.fonts.ready;
});

// ---------------------------------------------------------------------------
// 2. Network sentinel
// ---------------------------------------------------------------------------

const BLOCKED_PATTERNS = ['/api', '/ws'];

function isBlockedUrl(url: string | URL | Request): boolean {
  const href = url instanceof Request ? url.url : String(url);
  return BLOCKED_PATTERNS.some((pat) => href.includes(pat));
}

// Patch fetch
const originalFetch = globalThis.fetch;
globalThis.fetch = function sentinel_fetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  if (isBlockedUrl(input)) {
    throw new Error(
      `[D7 network sentinel] fetch to "${String(input)}" is not allowed in browser tests. ` +
        `Stub the hook or lib/api caller at the module level (vi.mock) so no real network ` +
        `request is made. See d7-investigation.md §0.8c.`,
    );
  }
  return originalFetch(input, init);
};

// Patch WebSocket constructor
const OriginalWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class SentinelWebSocket extends OriginalWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    if (isBlockedUrl(url)) {
      throw new Error(
        `[D7 network sentinel] WebSocket to "${String(url)}" is not allowed in browser tests. ` +
          `Stub use-websocket / RealtimeProvider at the module level (vi.mock) so no socket ` +
          `is ever opened. See d7-investigation.md §0.8c.`,
      );
    }
    super(url, protocols);
  }
};
