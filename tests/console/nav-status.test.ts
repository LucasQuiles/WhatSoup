/**
 * NavRail + status indicators — structural tests.
 * Verifies the v3.5 chrome rail export, realtime hook, and format helpers.
 */
import { describe, it, expect } from 'vitest';
import { getFleetWebSocketUrl } from '../../console/src/lib/realtime-events';

// ---------------------------------------------------------------------------
// Nav component
// ---------------------------------------------------------------------------

describe('NavRail component (v3.5 chrome, T5 b-02)', () => {
  it('is a default export', async () => {
    const mod = await import('../../console/src/components/chrome/NavRail');
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Realtime hooks and helpers
// ---------------------------------------------------------------------------

describe('realtime provider exports', () => {
  it('exports RealtimeProvider and useRealtime', async () => {
    const mod = await import('../../console/src/hooks/use-websocket');
    expect({
      RealtimeProvider: typeof mod.RealtimeProvider,
      useRealtime: typeof mod.useRealtime,
    }).toEqual({
      RealtimeProvider: 'function',
      useRealtime: 'function',
    });
  });
});

describe('WS URL construction', () => {
  const okFetcher = () => Promise.resolve({ ticket: 'tkt', expiresIn: 60 });

  it('uses wss: for https: pages', async () => {
    const url = await getFleetWebSocketUrl({ protocol: 'https:', host: 'app.example.com' }, okFetcher);
    expect(url).toMatch(/^wss:\/\//);
  });

  it('uses ws: for http: pages', async () => {
    const url = await getFleetWebSocketUrl({ protocol: 'http:', host: 'localhost:9099' }, okFetcher);
    expect(url).toMatch(/^ws:\/\//);
  });

  it('returns null when the ticket fetcher rejects', async () => {
    const url = await getFleetWebSocketUrl(
      { protocol: 'http:', host: 'localhost' },
      () => Promise.reject(new Error('unauthenticated')),
    );
    expect(url).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Console auth bootstrap (requires DOM — structural check only)
// ---------------------------------------------------------------------------

describe('console auth bootstrap exports (B1)', () => {
  it('exposes the session-model helpers and not the removed token getter', async () => {
    const mod = await import('../../console/src/lib/api');
    expect(typeof mod.isProductionConsole).toBe('function');
    expect(typeof mod.unlockConsole).toBe('function');
    expect(typeof mod.lockConsole).toBe('function');
    expect((mod as Record<string, unknown>).getFleetToken).toBeUndefined();
  });
});
