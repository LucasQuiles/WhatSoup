/**
 * Direct tests for src/fleet/routes/ops-messages.ts (#2239 slice 4/5).
 *
 * The four message handlers (send, access update, mark-read, save contact)
 * moved out of ops.ts. These cases import the new module directly and exercise
 * the moved behaviour; the shim case pins that ops.ts still re-exports the
 * same functions, so existing callers keep working unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

vi.mock('../../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));

import {
  handleAccessUpdate,
  handleMarkRead,
  handleSaveContact,
  handleSend,
} from '../../../src/fleet/routes/ops-messages.ts';
import * as opsShim from '../../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { proxyToInstance } from '../../../src/fleet/http-proxy.ts';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';

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

function depsFor(instance: DiscoveredInstance): OpsDeps {
  return makeDeps<any>({ discovery: { getInstance: vi.fn(() => instance) } });
}

describe('ops-messages handlers', () => {
  beforeEach(() => {
    vi.mocked(proxyToInstance).mockReset();
  });

  it('are the same functions ops.ts re-exports', () => {
    expect(opsShim.handleSend).toBe(handleSend);
    expect(opsShim.handleAccessUpdate).toBe(handleAccessUpdate);
    expect(opsShim.handleMarkRead).toBe(handleMarkRead);
    expect(opsShim.handleSaveContact).toBe(handleSaveContact);
  });

  it('send refuses a body carrying both chatJid and to, without proxying', async () => {
    const res = mockRes();

    await handleSend(
      mockReq({ method: 'POST', body: JSON.stringify({ chatJid: '15551230006', to: 'alias', text: 'hi' }) }),
      res, depsFor(fakeInstance()), { name: 'test-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({
      error: 'chatJid and to are mutually exclusive; provide exactly one',
    });
    expect(proxyToInstance).not.toHaveBeenCalled();
  });

  it('send normalizes a bare phone chatJid before proxying to the health port', async () => {
    vi.mocked(proxyToInstance).mockResolvedValue({ status: 200, body: '{"ok":true}' });
    const deps = depsFor(fakeInstance());
    const res = mockRes();

    await handleSend(
      mockReq({ method: 'POST', body: JSON.stringify({ chatJid: '15551230006', text: 'hi' }) }),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    const [port, route, method, forwarded, token] = vi.mocked(proxyToInstance).mock.calls[0]!;
    expect([port, route, method, token]).toEqual([3010, '/send', 'POST', 'tok123']);
    expect(JSON.parse(forwarded as string).chatJid).toBe('15551230006@s.whatsapp.net');
    expect(deps.realtime.publish).toHaveBeenCalled();
  });

  it('access update rejects an invalid action with the unchanged 400 message', async () => {
    const res = mockRes();

    await handleAccessUpdate(
      mockReq({ method: 'POST', body: JSON.stringify({ subjectType: 'phone', subjectId: '1555', action: 'maybe' }) }),
      res, depsFor(fakeInstance()), { name: 'test-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({
      error: 'body must include subjectType (phone|group), subjectId (string), action (allow|block)',
    });
    expect(proxyToInstance).not.toHaveBeenCalled();
  });

  it('mark-read passes the upstream status and body through', async () => {
    vi.mocked(proxyToInstance).mockResolvedValue({ status: 422, body: '{"error":"unprocessable"}' });
    const res = mockRes();

    await handleMarkRead(
      mockReq({ method: 'POST', body: '{"chatJid":"x"}' }),
      res, depsFor(fakeInstance()), { name: 'test-line' },
    );

    expect(res._status).toBe(422);
    expect(res._body).toBe('{"error":"unprocessable"}');
  });

  it('save contact reports 503 when no MCP socket is available', async () => {
    const res = mockRes();

    await handleSaveContact(
      mockReq({ method: 'POST', body: JSON.stringify({ jid: '15551230006@s.whatsapp.net', firstName: 'A' }) }),
      res, depsFor(fakeInstance({ socketPath: null })), { name: 'test-line' },
    );

    expect(res._status).toBe(503);
    expect(JSON.parse(res._body)).toEqual({
      error: 'MCP socket not available — contact management requires a running instance with MCP',
    });
  });

  it('keeps direct file writes off bare utf-8 string encoding (mirrors ops-private-writes)', () => {
    const source = fs.readFileSync('src/fleet/routes/ops-messages.ts', 'utf-8');
    const unsafeWrites = source
      .split('\n')
      .map((line, index) => ({ line: index + 1, text: line.trim() }))
      .filter(({ text }) => text.includes('fs.writeFileSync('))
      .filter(({ text }) => /,\s*['"]utf-8['"]\s*\)/.test(text));

    expect(source).toContain('export async function handleSend(');
    expect(unsafeWrites).toEqual([]);
  });
});
