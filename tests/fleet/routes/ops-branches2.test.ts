/**
 * Branch-coverage supplement #2 for src/fleet/routes/ops.ts.
 *
 * Additive companion to tests/fleet/routes/ops-gaps.test.ts and friends. Targets
 * reachable uncovered branch arms not reached by the existing suites:
 *   - scanHealthPortInventory -> inventoryFailure with BOTH errno code AND
 *     instance fields present (lines 845/846 conditional spreads), surfaced
 *     through handleCreateLine when a sibling instance config is unreadable.
 *   - handleCreateLine directory-create failure that is NOT EEXIST (line 1142
 *     else arm).
 *   - handleAuth: kill of an in-flight auth child from a prior request
 *     (line 1264), blank stdout lines skipped (line 1334), and empty stderr
 *     chunks ignored (line 1367).
 *
 *   npx vitest run --pool=forks tests/fleet/routes/ops-branches2.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ServerResponse } from 'node:http';

vi.mock('../../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { childProcessMock } = await import('../../helpers/child-process.ts');
  return childProcessMock();
});

// Controllable mkdir-failure injection. When `mkdirFailFor` is set, the first
// mkdirSync whose path ends with it throws the configured errno (non-EEXIST),
// exercising the handleCreateLine catch's non-EEXIST else arm. All other
// mkdir calls delegate to the real implementation.
const mkdirControl: { failFor: string | null; code: string } = { failFor: null, code: 'ENOTDIR' };
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    default: actual,
    mkdirSync: ((p: fs.PathLike, opts?: unknown) => {
      if (mkdirControl.failFor !== null && String(p).endsWith(mkdirControl.failFor)) {
        mkdirControl.failFor = null; // one-shot
        const err = new Error(`${mkdirControl.code}: injected mkdir failure`) as NodeJS.ErrnoException;
        err.code = mkdirControl.code;
        throw err;
      }
      return (actual.mkdirSync as unknown as (a: fs.PathLike, b?: unknown) => string | undefined)(p, opts);
    }) as typeof actual.mkdirSync,
  };
});

import {
  handleCreateLine,
  handleConfigUpdate,
  handleAuth,
} from '../../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { REQUIRED_DENY } from '../../../src/core/settings-template.ts';
import { spawn } from 'node:child_process';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockSseRes(): ServerResponse & { _chunks: string[]; _ended: boolean } {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _chunks: [] as string[],
    _ended: false,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
    },
    write(chunk: string) {
      res._chunks.push(chunk);
      return true;
    },
    end(data?: string) {
      if (data) res._chunks.push(data);
      res._ended = true;
    },
    // ServerResponse is an EventEmitter; createSSEWriter attaches an 'error'
    // listener (#2292 L7), so a fake without `on` is an incomplete fake.
    on() {
      return res;
    },
  };
  return res as unknown as ServerResponse & { _chunks: string[]; _ended: boolean };
}

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
    configPath: '/nonexistent-ops-branches2/config.json',
    socketPath: null,
    ...overrides,
  } as DiscoveredInstance;
}

function depsFor(instance: DiscoveredInstance | null = null): OpsDeps {
  return makeDeps({ discovery: { getInstance: vi.fn(() => instance ?? undefined), scan: vi.fn() } as any });
}

// ---------------------------------------------------------------------------
// scanHealthPortInventory -> inventoryFailure code + instance (lines 845/846)
// ---------------------------------------------------------------------------
describe('handleCreateLine: inventory failure carries errno code and instance', () => {
  let tmpDir: string;
  let prevConfig: string | undefined;
  let prevData: string | undefined;
  let prevState: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ops-branches2-inv-'));
    prevConfig = process.env.XDG_CONFIG_HOME;
    prevData = process.env.XDG_DATA_HOME;
    prevState = process.env.XDG_STATE_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');
  });

  afterEach(() => {
    if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevConfig;
    if (prevData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevData;
    if (prevState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevState;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns 500 with code and instance when a sibling config read fails (EISDIR)', async () => {
    // Create a sibling instance directory whose config.json is itself a
    // DIRECTORY, so readFileSync throws EISDIR (a non-ENOENT errno). The
    // inventory builder then populates BOTH the `code` and `instance` spread
    // fields (lines 845/846 right arms).
    const configRootDir = path.join(tmpDir, 'config', 'whatsoup', 'instances');
    const siblingDir = path.join(configRootDir, 'existing-sib');
    fs.mkdirSync(path.join(siblingDir, 'config.json'), { recursive: true });

    const deps = depsFor();
    const req = mockReq({ method: 'POST', body: JSON.stringify({
      name: 'new-line',
      type: 'chat',
      adminPhones: ['15551230006'],
    }) });
    const res = mockRes();
    await handleCreateLine(req, res, deps);

    expect(res._status).toBe(500);
    const body = JSON.parse(res._body) as { error: string; code?: string; instance?: string };
    expect(body.code).toBe('EISDIR');
    expect(body.instance).toBe('existing-sib');
  });
});

// ---------------------------------------------------------------------------
// handleCreateLine: non-EEXIST directory-create failure (line 1142 else arm)
// ---------------------------------------------------------------------------
describe('handleCreateLine: mkdir failure other than EEXIST surfaces as 500', () => {
  let tmpDir: string;
  let prevConfig: string | undefined;
  let prevData: string | undefined;
  let prevState: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-ops-branches2-mkdir-'));
    prevConfig = process.env.XDG_CONFIG_HOME;
    prevData = process.env.XDG_DATA_HOME;
    prevState = process.env.XDG_STATE_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');
  });

  afterEach(() => {
    if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevConfig;
    if (prevData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevData;
    if (prevState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevState;
    vi.restoreAllMocks();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  afterEach(() => {
    mkdirControl.failFor = null;
  });

  it('maps a non-EEXIST mkdir error (ENOTDIR) to a 500 creation-failed response', async () => {
    // The inventory scan succeeds against an empty config root; the per-instance
    // configDir mkdir (handleCreateLine line ~1140) then throws an injected
    // ENOTDIR — a non-EEXIST error — exercising the catch's else arm (line 1142)
    // that maps it to a generic 500 creation-failed response (line 1146).
    mkdirControl.code = 'ENOTDIR';
    mkdirControl.failFor = path.join('instances', 'mkdir-line');

    const deps = depsFor();
    const req = mockReq({ method: 'POST', body: JSON.stringify({
      name: 'mkdir-line',
      type: 'chat',
      adminPhones: ['15551230006'],
    }) });
    const res = mockRes();
    await handleCreateLine(req, res, deps);

    expect(res._status).toBe(500);
    const body = JSON.parse(res._body) as { schema: string; code: string; operation: string };
    expect(body.schema).toBe('fleet-error-v1');
    expect(body.code).toBe('source_unavailable');
    expect(body.operation).toBe('instance_create');
  });
});

// ---------------------------------------------------------------------------
// handleAuth branch arms
// ---------------------------------------------------------------------------
describe('handleAuth: branch arms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips blank stdout lines and ignores empty stderr chunks (lines 1334, 1367)', async () => {
    const deps = depsFor(fakeInstance());
    const req = mockReq({ method: 'POST' });
    const res = mockSseRes();
    const pending = handleAuth(req, res, deps, { name: 'test-line' });
    await vi.waitFor(() => expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1));
    const child = vi.mocked(spawn).mock.results[0]!.value as {
      stdout: { emit: (event: string, chunk: Buffer) => void };
      stderr: { emit: (event: string, chunk: Buffer) => void };
      emit: (event: string, code: number) => void;
    };

    const chunkCountBefore = res._chunks.length;

    // Blank line between newlines -> `if (!line.trim()) continue` (line 1334).
    child.stdout.emit('data', Buffer.from('\n   \n'));
    // Whitespace-only stderr -> `if (text)` false arm (line 1367): no SSE/info.
    child.stderr.emit('data', Buffer.from('   '));

    // Neither produced any new SSE output.
    expect(res._chunks.length).toBe(chunkCountBefore);

    // A real allowed event still flows so the handler reaches a normal exit.
    child.stdout.emit('data', Buffer.from(JSON.stringify({ event: 'qr', data: { code: 'x' } }) + '\n'));
    expect(res._chunks.some((c) => c.includes('qr'))).toBe(true);

    child.emit('exit', 0);
    await pending;
  });
});

// ---------------------------------------------------------------------------
// handleConfigUpdate agent-cwd / pluginDirs / settings.deny branch arms
// ---------------------------------------------------------------------------
describe('handleConfigUpdate: agent path validation branch arms', () => {
  let homeTmp: string;
  let configFile: string;

  function makeHomeTmpDir(): string {
    const base = path.join(os.homedir(), '.whatsoup-test-tmp');
    fs.mkdirSync(base, { recursive: true });
    return fs.mkdtempSync(path.join(base, 'ops-branches2-'));
  }

  function agentInstance(cwd: string): { instance: DiscoveredInstance; deps: OpsDeps } {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-branches2-cfg-'));
    configFile = path.join(configDir, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({
      name: 'agent-x',
      type: 'agent',
      adminPhones: ['15551230006'],
      accessMode: 'self_only',
      agentOptions: { sessionScope: 'per_chat', cwd },
    }));
    const instance = {
      name: 'agent-x', type: 'agent', accessMode: 'self_only',
      healthPort: 9099, dbPath: '/tmp/bot.db', stateRoot: '/tmp/state',
      logDir: '/tmp/logs', healthToken: 'tok', configPath: configFile, socketPath: null,
    } as DiscoveredInstance;
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => instance), scan: vi.fn() } as any });
    return { instance, deps };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    homeTmp = makeHomeTmpDir();
  });

  afterEach(() => {
    try { fs.rmSync(homeTmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('rejects an agentOptions.cwd with an unsupported ~user tilde prefix (line 711)', async () => {
    const { deps } = agentInstance(homeTmp);
    // Patch cwd to a ~user form (not ~ or ~/) -> hasUnsupportedTildePrefix true.
    const req = mockReq({ method: 'PATCH', body: JSON.stringify({ agentOptions: { cwd: '~root/workspace' } }) });
    const res = mockRes();
    await handleConfigUpdate(req, res, deps, { name: 'agent-x' });

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toBe('agentOptions.cwd must be within the home directory');
  });

  it('rejects a string pluginDir outside the home directory (route confinement)', async () => {
    const { deps } = agentInstance(homeTmp);
    // The shared validator only checks string-ness; the route-level
    // validatePluginDirs enforces home-confinement and rejects an absolute
    // path that resolves outside $HOME.
    const req = mockReq({ method: 'PATCH', body: JSON.stringify({ agentOptions: { pluginDirs: ['/etc/not-home'] } }) });
    const res = mockRes();
    await handleConfigUpdate(req, res, deps, { name: 'agent-x' });

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body) as { error: string };
    expect(body.error).toBe('pluginDirs entries must be within the home directory');
  });

  it('normalises a non-array permissions.deny in existing settings.json (line 573)', async () => {
    const { deps } = agentInstance(homeTmp);
    // Pre-seed settings.json whose permissions.deny is NOT an array so the
    // enabledPlugins merge takes the `Array.isArray(deny) ? deny : []` else arm.
    const claudeDir = path.join(homeTmp, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      permissions: { allow: ['Bash'], deny: 'not-an-array', defaultMode: 'bypassPermissions' },
    }));

    const plugins = { 'tmup@tmup-dev': true };
    const req = mockReq({ method: 'PATCH', body: JSON.stringify({ agentOptions: { enabledPlugins: plugins } }) });
    const res = mockRes();
    await handleConfigUpdate(req, res, deps, { name: 'agent-x' });

    expect(res._status).toBe(200);
    const written = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
    expect(written.enabledPlugins).toEqual(plugins);
    // Non-array deny was discarded and replaced with the required deny floor.
    expect(written.permissions.deny).toEqual(REQUIRED_DENY);
    expect(written.permissions.allow).toEqual(['Bash']);
  });
});

// ---------------------------------------------------------------------------
// handleConfigUpdate: transport immutability + per-transport admin IDs (S9)
// ---------------------------------------------------------------------------
describe('handleConfigUpdate: transport immutability + per-transport admin IDs', () => {
  function transportInstance(transport: string): { instance: DiscoveredInstance; deps: OpsDeps; configFile: string } {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-s9-cfg-'));
    const configFile = path.join(configDir, 'config.json');
    const base: Record<string, unknown> = {
      name: 'line-x',
      type: 'passive',
      adminPhones: ['15551230006'],
      accessMode: 'self_only',
    };
    if (transport !== 'baileys') {
      base.transport = transport;
      if (transport === 'signal') {
        base.signalConfig = {
          account: 'line-x', phoneNumber: '+15551110000',
          socketPath: '/tmp/signal-cli-line-x.sock',
          inboundMode: 'poll', pollIntervalMs: 15000, rateLimit: { messagesPerMinute: 30 },
        };
      }
      if (transport === 'imessage') {
        base.imessageConfig = {
          account: 'line-x', backend: 'bluebubbles',
          bluebubblesUrl: 'https://bb.example.test', bluebubblesPasswordService: 'bb-pw',
          sender: 'me@heal.internal',
          inboundMode: 'poll', pollIntervalMs: 15000, rateLimit: { messagesPerMinute: 30 },
        };
      }
    }
    fs.writeFileSync(configFile, JSON.stringify(base));
    const instance = {
      name: 'line-x', type: 'passive', accessMode: 'self_only',
      healthPort: 9099, dbPath: '/tmp/bot.db', stateRoot: '/tmp/state',
      logDir: '/tmp/logs', healthToken: 'tok', configPath: configFile, socketPath: null,
    } as DiscoveredInstance;
    const deps = makeDeps({ discovery: { getInstance: vi.fn(() => instance), scan: vi.fn() } as any });
    return { instance, deps, configFile };
  }

  it('rejects a transport change with 409 (immutable)', async () => {
    const { deps } = transportInstance('baileys');
    const req = mockReq({ method: 'PATCH', body: JSON.stringify({ transport: 'twilio' }) });
    const res = mockRes();
    await handleConfigUpdate(req, res, deps, { name: 'line-x' });
    expect(res._status).toBe(409);
    expect(JSON.parse(res._body).error).toMatch(/transport is immutable/);
  });

  it('accepts a patch that restates the same transport (no change)', async () => {
    const { deps, configFile } = transportInstance('signal');
    const req = mockReq({ method: 'PATCH', body: JSON.stringify({ transport: 'signal', rateLimitPerHour: 50 }) });
    const res = mockRes();
    await handleConfigUpdate(req, res, deps, { name: 'line-x' });
    expect(res._status).toBe(200);
    const merged = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    expect(merged.transport).toBe('signal');
  });

  it('normalizes a Signal UUID admin ID verbatim on a signal line', async () => {
    const { deps, configFile } = transportInstance('signal');
    const uuid = 'a1b2c3d4-1234-1234-1234-a1b2c3d4e5f6';
    const req = mockReq({ method: 'PATCH', body: JSON.stringify({ adminPhones: [uuid] }) });
    const res = mockRes();
    await handleConfigUpdate(req, res, deps, { name: 'line-x' });
    expect(res._status).toBe(200);
    const merged = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    expect(merged.adminPhones).toEqual([uuid]);
  });

  it('normalizes an AppleID email admin ID verbatim on an imessage line', async () => {
    const { deps, configFile } = transportInstance('imessage');
    const req = mockReq({ method: 'PATCH', body: JSON.stringify({ adminPhones: ['boss@heal.internal'] }) });
    const res = mockRes();
    await handleConfigUpdate(req, res, deps, { name: 'line-x' });
    expect(res._status).toBe(200);
    const merged = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    expect(merged.adminPhones).toEqual(['boss@heal.internal']);
  });

  it('still digit-normalizes E.164 admin phones on a baileys line', async () => {
    const { deps, configFile } = transportInstance('baileys');
    const req = mockReq({ method: 'PATCH', body: JSON.stringify({ adminPhones: ['+1 (555) 123-0006'] }) });
    const res = mockRes();
    await handleConfigUpdate(req, res, deps, { name: 'line-x' });
    expect(res._status).toBe(200);
    const merged = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    expect(merged.adminPhones).toEqual(['15551230006']);
  });
});
