import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  handleGetGroupDetail,
  handleUpdateGroupSubject,
  handleLeaveGroup,
} from '../../../src/fleet/routes/mcp-proxy.ts';
import type { McpProxyDeps } from '../../../src/fleet/routes/mcp-proxy.ts';
import { mcpCall } from '../../../src/fleet/mcp-client.ts';
import type { DiscoveredInstance, FleetDiscovery } from '../../../src/fleet/discovery.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

vi.mock('../../../src/fleet/mcp-client.ts', () => ({
  mcpCall: vi.fn(),
}));

let tmpDir: string;
let socketPath: string;

function makeInstance(): DiscoveredInstance {
  return {
    name: 'alpha',
    type: 'agent',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath: '/tmp/alpha.db',
    stateRoot: '/tmp/alpha-state',
    logDir: '/tmp/alpha-logs',
    healthToken: null,
    configPath: '/tmp/alpha-config.json',
    socketPath,
  };
}

function makeDeps(): McpProxyDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => makeInstance()),
    } as unknown as FleetDiscovery,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-mcp-proxy-jid-'));
  socketPath = path.join(tmpDir, 'whatsoup.sock');
  fs.writeFileSync(socketPath, '');
  vi.mocked(mcpCall).mockResolvedValue({
    success: true,
    result: { content: [{ type: 'text', text: '{"ok":true}' }] },
  });
});

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('mcp proxy group JID decode — malformed percent-encoding', () => {
  // (a) malformed JID → 400 on a GET (no-body) group route
  it('returns 400 for malformed %-encoded JID on GET /groups/:jid (handleGetGroupDetail)', async () => {
    const res = mockRes();
    await handleGetGroupDetail(
      mockReq({ method: 'GET', url: '/api/lines/alpha/groups/%E0%A4%A' }),
      res,
      makeDeps(),
      { name: 'alpha', jid: '%E0%A4%A' },
    );

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.error).toMatch(/invalid jid/i);
    expect(mcpCall).not.toHaveBeenCalled();
  });

  // (a-bis) malformed JID → 400 on a PUT-with-body group route (different code path: mcpWithBody)
  it('returns 400 for malformed %-encoded JID on PUT /groups/:jid/subject (handleUpdateGroupSubject)', async () => {
    const res = mockRes();
    await handleUpdateGroupSubject(
      mockReq({
        method: 'PUT',
        url: '/api/lines/alpha/groups/%E0%A4%A/subject',
        body: '{"subject":"x"}',
      }),
      res,
      makeDeps(),
      { name: 'alpha', jid: '%E0%A4%A' },
    );

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.error).toMatch(/invalid jid/i);
    expect(mcpCall).not.toHaveBeenCalled();
  });

  // (b) valid percent-encoded JID still routes correctly and reaches mcpCall with decoded jid
  it('decodes and forwards valid %-encoded JID (1234567890%40g.us) to MCP on GET handleGetGroupDetail', async () => {
    const res = mockRes();
    const encoded = encodeURIComponent('1234567890@g.us'); // 1234567890%40g.us
    await handleGetGroupDetail(
      mockReq({ method: 'GET', url: `/api/lines/alpha/groups/${encoded}` }),
      res,
      makeDeps(),
      { name: 'alpha', jid: encoded },
    );

    expect(res._status).toBe(200);
    expect(mcpCall).toHaveBeenCalledWith(
      socketPath,
      'get_group_metadata',
      { jid: '1234567890@g.us' },
      15_000,
    );
  });

  // (c) third distinct group route — handleLeaveGroup (DELETE, uses `id` field not `jid`)
  it('returns 400 for malformed JID on DELETE /groups/:jid (handleLeaveGroup) without calling mcp', async () => {
    const res = mockRes();
    await handleLeaveGroup(
      mockReq({ method: 'DELETE', url: '/api/lines/alpha/groups/%E0%A4%A' }),
      res,
      makeDeps(),
      { name: 'alpha', jid: '%E0%A4%A' },
    );

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.error).toMatch(/invalid jid/i);
    expect(mcpCall).not.toHaveBeenCalled();
  });
});
