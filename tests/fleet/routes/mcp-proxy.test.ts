import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleCreateGroup, handleSearchContacts } from '../../../src/fleet/routes/mcp-proxy.ts';
import { mcpCall } from '../../../src/fleet/mcp-client.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';

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

function makeDeps() {
  return {
    discovery: {
      getInstance: vi.fn(() => makeInstance()),
    },
  };
}

function mockReq(body: string, url = '/api/lines/alpha/groups'): IncomingMessage {
  const req = new PassThrough() as IncomingMessage;
  req.method = 'POST';
  req.url = url;
  process.nextTick(() => {
    req.end(body);
  });
  return req;
}

function mockRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    writeHead(status: number) { res._status = status; },
    end(data?: string) { res._body = data ?? ''; },
  };
  return res as unknown as ServerResponse & { _status: number; _body: string };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-mcp-proxy-'));
  socketPath = path.join(tmpDir, 'whatsoup.sock');
  fs.writeFileSync(socketPath, '');
  vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '{"ok":true}' }] } });
});

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('mcp proxy body handlers', () => {
  it('rejects null JSON bodies before calling MCP tools', async () => {
    const res = mockRes();
    await handleCreateGroup(mockReq('null'), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'JSON body must be an object' });
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('rejects array JSON bodies before calling MCP tools', async () => {
    const res = mockRes();
    await handleCreateGroup(mockReq('[]'), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'JSON body must be an object' });
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('forwards object JSON bodies to MCP tools', async () => {
    const res = mockRes();
    await handleCreateGroup(mockReq('{"subject":"Ops","participants":[]}'), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(201);
    expect(JSON.parse(res._body)).toEqual({ ok: true });
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'group_create', { subject: 'Ops', participants: [] }, undefined);
  });

  it('treats null contact search tool payloads as an empty contact list', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: 'null' }] } });
    const res = mockRes();

    await handleSearchContacts(mockReq('', '/api/lines/alpha/contacts/search?q=ana'), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ contacts: [] });
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'search_contacts', { query: 'ana' });
  });
});
