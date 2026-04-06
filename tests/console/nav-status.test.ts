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
    expect(mod.RealtimeProvider).toBeDefined();
    expect(mod.useRealtime).toBeDefined();
  });
});

describe('WS URL construction', () => {
  it('uses wss: for https: pages', () => {
    const url = getFleetWebSocketUrl({ protocol: 'https:', host: 'app.example.com' }, 'token123');
    expect(url).toMatch(/^wss:\/\//);
  });

  it('uses ws: for http: pages', () => {
    const url = getFleetWebSocketUrl({ protocol: 'http:', host: 'localhost:9099' }, 'token123');
    expect(url).toMatch(/^ws:\/\//);
  });

  it('returns null without a token', () => {
    expect(getFleetWebSocketUrl({ protocol: 'http:', host: 'localhost' }, null)).toBeNull();
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
