/**
 * Nav + status indicators — structural tests.
 * Verifies Nav export, realtime hook, and format helpers.
 */
import { describe, it, expect } from 'vitest';
import { getFleetWebSocketUrl } from '../../console/src/lib/realtime-events';

// ---------------------------------------------------------------------------
// Nav component
// ---------------------------------------------------------------------------

describe('Nav component', () => {
  it('is a default export', async () => {
    const mod = await import('../../console/src/components/Nav');
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
// Fleet token helper (requires DOM — structural check only)
// ---------------------------------------------------------------------------

describe('getFleetToken', () => {
  it('is exported from api module', async () => {
    const mod = await import('../../console/src/lib/api');
    expect(mod.getFleetToken).toBeDefined();
    expect(typeof mod.getFleetToken).toBe('function');
  });
});
