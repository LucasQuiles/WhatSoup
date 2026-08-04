/**
 * Tests for the fleet POST /api/lines/:name/mark-read endpoint.
 * Verifies handleMarkRead in src/fleet/routes/ops.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { handleMarkRead } from '../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../src/fleet/routes/ops.ts';
import { makeDeps } from '../helpers/http-mocks.ts';
import type { DiscoveredInstance } from '../../src/fleet/discovery.ts';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/fleet/http-proxy.ts', () => ({
  proxyToInstance: vi.fn(),
}));

import { proxyToInstance } from '../../src/fleet/http-proxy.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

import { mockReq, mockRes } from '../helpers/http-mocks.ts';

function fakeInstance(overrides: Partial<DiscoveredInstance> = {}): DiscoveredInstance {
  return {
    name: 'test-line',
    type: 'chat',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath: '/data/test-line/bot.db',
    stateRoot: '/state/test-line',
    logDir: '/data/test-line/logs',
    healthToken: 'tok123',
    configPath: '/config/test-line/config.json',
    socketPath: null,
    ...overrides,
  };
}

function depsFor(overrides: Partial<OpsDeps> = {}): OpsDeps {
  return makeDeps(overrides);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleMarkRead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when instance not found', async () => {
    const deps = depsFor();
    const res = mockRes();
    await handleMarkRead(mockReq({ body: '{}', method: 'POST' }), res, deps, { name: 'unknown-line' });
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body).error).toMatch(/unknown-line/);
  });

  it('proxies to /mark-read on the health server', async () => {
    const inst = fakeInstance();
    const deps = depsFor({ discovery: { getInstance: vi.fn(() => inst) } as any });
    vi.mocked(proxyToInstance).mockResolvedValue({ status: 200, body: '{"ok":true}' });

    const res = mockRes();
    const body = '{"chatJid":"123@s.whatsapp.net"}';
    await handleMarkRead(mockReq({ body: body, method: 'POST' }), res, deps, { name: 'test-line' });

    expect(proxyToInstance).toHaveBeenCalledWith(3010, '/mark-read', 'POST', body, 'tok123');
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ ok: true });
  });

  it('publishes feedEvent on success (2xx)', async () => {
    const inst = fakeInstance();
    const realtime = { publish: vi.fn() };
    const deps = depsFor({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      realtime,
    });
    vi.mocked(proxyToInstance).mockResolvedValue({ status: 200, body: '{"ok":true}' });

    const res = mockRes();
    await handleMarkRead(mockReq({ body: '{}', method: 'POST' }), res, deps, { name: 'test-line' });

    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat_updated' }),
    );
    expect(realtime.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'feed_event' }),
    );
  });

  it('does not publish feedEvent on failure (non-2xx)', async () => {
    const inst = fakeInstance();
    const realtime = { publish: vi.fn() };
    const deps = depsFor({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      realtime,
    });
    vi.mocked(proxyToInstance).mockResolvedValue({ status: 500, body: '{"error":"fail"}' });

    const res = mockRes();
    await handleMarkRead(mockReq({ body: '{}', method: 'POST' }), res, deps, { name: 'test-line' });

    expect(res._status).toBe(500);
    expect(realtime.publish).not.toHaveBeenCalled();
  });

  it('passes through non-2xx status from instance', async () => {
    const inst = fakeInstance();
    const deps = depsFor({ discovery: { getInstance: vi.fn(() => inst) } as any });
    vi.mocked(proxyToInstance).mockResolvedValue({ status: 422, body: '{"error":"unprocessable"}' });

    const res = mockRes();
    await handleMarkRead(mockReq({ body: '{}', method: 'POST' }), res, deps, { name: 'test-line' });

    expect(res._status).toBe(422);
    expect(JSON.parse(res._body).error).toBe('unprocessable');
  });
});
