import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

vi.mock('../../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

import { handleConfigUpdate } from '../../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';

function mockReq(body = ''): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage;
  (stream as any).headers = {};
  (stream as any).url = '/';
  (stream as any).method = 'PATCH';
  process.nextTick(() => {
    (stream as unknown as PassThrough).write(body);
    (stream as unknown as PassThrough).end();
  });
  return stream;
}

function mockRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    writeHead(status: number) { res._status = status; },
    end(data?: string) { if (data) res._body = data; },
  };
  return res as any;
}

describe('handleConfigUpdate — plaintext provider-key strip', () => {
  let tmpDir: string;
  let configPath: string;
  let deps: OpsDeps;
  const envKeys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-pk-strip-'));
    for (const k of envKeys) { saved[k] = process.env[k]; }
    process.env.HOME = tmpDir;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, '.config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, '.local', 'share');
    process.env.XDG_STATE_HOME = path.join(tmpDir, '.local', 'state');
    const dir = path.join(process.env.XDG_CONFIG_HOME, 'whatsoup', 'instances', 'pk-line');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    configPath = path.join(dir, 'config.json');
    // adminPhones must be non-empty — the shared validator (agent-config-validator.ts)
    // rejects an empty array on PATCH with a 400, which would fail these tests for the
    // wrong reason (setup/validation), not the one under test (key persistence).
    fs.writeFileSync(configPath, JSON.stringify({
      name: 'pk-line', type: 'chat', adminPhones: ['15551234567'], healthPort: 9095,
      accessMode: 'self_only', introSent: true,
    }, null, 2) + '\n', { mode: 0o600 });
    deps = {
      discovery: {
        getInstance: vi.fn(() => ({ name: 'pk-line', configPath })),
        getInstances: vi.fn(() => new Map()),
        scan: vi.fn(),
      } as any,
      realtime: { publish: vi.fn() },
      serviceManager: {
        enable: vi.fn(), disable: vi.fn(), start: vi.fn(), stop: vi.fn(),
        restart: vi.fn(), startFire: vi.fn(),
      } as any,
    } as OpsDeps;
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('strips apiKey/openaiKey from a hostile PATCH; control sibling survives', async () => {
    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ apiKey: 'sk-ant-evil', openaiKey: 'sk-evil', description: 'kept' })),
      res, deps, { name: 'pk-line' },
    );
    expect(res._status).toBe(200);
    const disk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(disk.apiKey).toBeUndefined();
    expect(disk.openaiKey).toBeUndefined();
    expect(disk.description).toBe('kept');
    const body = JSON.parse(res._body);
    expect(body.apiKey).toBeUndefined();
    expect(body.openaiKey).toBeUndefined();
    // strong terminal assertion: the raw on-disk bytes carry no key material
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('sk-ant-evil');
  });

  it('remediation: a pre-existing on-disk plaintext key is scrubbed by an unrelated PATCH', async () => {
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    existing.apiKey = 'sk-ant-victim';
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });

    const res = mockRes();
    await handleConfigUpdate(
      mockReq(JSON.stringify({ description: 'unrelated touch' })),
      res, deps, { name: 'pk-line' },
    );
    expect(res._status).toBe(200);
    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).not.toContain('sk-ant-victim');
    expect(JSON.parse(raw).description).toBe('unrelated touch');
  });
});

describe('handleCreateLine — plaintext provider-key strip guard', () => {
  let tmpDir: string;
  const envKeys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-pk-create-'));
    for (const k of envKeys) { saved[k] = process.env[k]; }
    process.env.HOME = tmpDir;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, '.config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, '.local', 'share');
    process.env.XDG_STATE_HOME = path.join(tmpDir, '.local', 'state');
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('CREATE guard: top-level apiKey/openaiKey in the create body never reach disk', async () => {
    const { handleCreateLine } = await import('../../../src/fleet/routes/ops.ts');
    // CREATE needs its own deps shape (mirrors ops-create-byok-roundtrip.test.ts's
    // successDeps()): getInstance must return undefined, not a fixed truthy stub,
    // or CREATE's uniqueness check 409s before the disk write is ever reached.
    const createDeps: OpsDeps = {
      discovery: {
        getInstance: vi.fn(() => undefined),
        getInstances: vi.fn(() => new Map()),
        scan: vi.fn(),
      } as any,
      realtime: { publish: vi.fn() },
      serviceManager: {
        enable: vi.fn().mockResolvedValue(undefined),
        disable: vi.fn().mockResolvedValue(undefined),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        restart: vi.fn().mockResolvedValue(undefined),
        startFire: vi.fn(),
      } as any,
    } as OpsDeps;

    const res = mockRes();
    const req = mockReq(JSON.stringify({
      name: 'pk-create', type: 'chat', adminPhones: ['15550000000'],
      apiKey: 'sk-ant-x1', openaiKey: 'sk-x1',
    }));
    (req as any).method = 'POST';
    await handleCreateLine(req, res, createDeps);
    // The SECURITY assertion is disk content. Assert the write was reached as an
    // explicit precondition (createDeps mirrors the byte-identical successDeps()
    // that ops-create-byok-roundtrip.test.ts proves reaches a written config.json),
    // then assert the typed keys never landed in it.
    const createdPath = path.join(
      process.env.XDG_CONFIG_HOME as string, 'whatsoup', 'instances', 'pk-create', 'config.json',
    );
    expect(fs.existsSync(createdPath)).toBe(true); // precondition: CREATE reached the disk write
    const raw = fs.readFileSync(createdPath, 'utf8');
    expect(raw).not.toContain('sk-ant-x1');
    expect(raw).not.toContain('sk-x1');
  });
});
