/**
 * Regression tests for `POST /api/lines` rollback behaviour.
 *
 * Issue #248 — when `serviceManager.enable()` throws after the create path
 * has written `<cwd>/.claude/CLAUDE.md` and `<cwd>/.claude/settings.json`,
 * the rollback must:
 *
 *   1. Restore pre-existing files to their original byte-for-byte contents
 *      (the user-supplied-cwd hazard — overwriting and then deleting a
 *      user's curated CLAUDE.md / settings.json is silent data loss).
 *   2. Remove files that did NOT exist before create (preserving the
 *      original cleanup intent for fresh agent cwds).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleCreateLine } from '../../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';

function mockReq(body = ''): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage;
  (stream as any).headers = {};
  (stream as any).url = '/';
  (stream as any).method = 'POST';
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

function failingDeps(): OpsDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => undefined),
      getInstances: vi.fn(() => new Map()),
      scan: vi.fn(),
    } as any,
    realtime: { publish: vi.fn() },
    serviceManager: {
      // Force the rollback path: enable() throws after extras are written.
      enable: vi.fn().mockRejectedValue(new Error('boom: simulated service enable failure')),
      disable: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue(undefined),
      startFire: vi.fn(),
    },
  };
}

describe('handleCreateLine — rollback preserves pre-existing user files (#248)', () => {
  let tmpDir: string;
  let agentCwd: string;
  let originalHome: string | undefined;
  let originalConfigHome: string | undefined;
  let originalDataHome: string | undefined;
  let originalStateHome: string | undefined;
  let originalUmask: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-rollback-test-'));
    originalHome = process.env.HOME;
    originalConfigHome = process.env.XDG_CONFIG_HOME;
    originalDataHome = process.env.XDG_DATA_HOME;
    originalStateHome = process.env.XDG_STATE_HOME;
    originalUmask = process.umask(0o022);

    process.env.HOME = path.join(tmpDir, 'home');
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');
    fs.mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
    agentCwd = fs.mkdtempSync(path.join(process.env.HOME, 'rollback-cwd-'));
  });

  afterEach(() => {
    process.umask(originalUmask);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigHome;
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = originalStateHome;

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores pre-existing CLAUDE.md and settings.json when enable() throws', async () => {
    // Pre-populate the user's project .claude/ with sentinel content.
    const claudeDir = path.join(agentCwd, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
    const settingsPath = path.join(claudeDir, 'settings.json');

    const sentinelClaudeMd = Buffer.from([0xff, 0xfe, 0x23, 0x20, 0x55, 0x53, 0x45, 0x52, 0x0a]);
    const sentinelSettings = Buffer.from([0x7b, 0x20, 0x22, 0x69, 0x6e, 0x76, 0x61, 0x6c, 0x69, 0x64]);
    fs.writeFileSync(claudeMdPath, sentinelClaudeMd);
    fs.writeFileSync(settingsPath, sentinelSettings);
    fs.chmodSync(claudeMdPath, 0o644);
    fs.chmodSync(settingsPath, 0o640);

    const deps = failingDeps();
    const res = mockRes();
    await handleCreateLine(
      mockReq(JSON.stringify({
        name: 'preserve-agent',
        type: 'agent',
        adminPhones: ['15551234567'],
        agentOptions: { cwd: agentCwd, sessionScope: 'per_chat' },
        claudeMd: 'AGENT_PROMPT — should be rolled back\n',
      })),
      res,
      deps,
    );

    expect(res._status).toBe(500);
    const body = JSON.parse(res._body);
    expect(body.schema).toBe('fleet-error-v1');
    expect(body.code).toBe('internal_error');
    expect(body.operation).toBe('instance_create');
    expect(body.mutation_state).toBe('not_started');

    // CLAUDE.md must be byte-for-byte restored.
    expect(fs.existsSync(claudeMdPath)).toBe(true);
    expect(fs.readFileSync(claudeMdPath)).toEqual(sentinelClaudeMd);
    expect(fs.statSync(claudeMdPath).mode & 0o777).toBe(0o644);

    // settings.json must be restored byte-for-byte even if it was not valid JSON.
    expect(fs.existsSync(settingsPath)).toBe(true);
    expect(fs.readFileSync(settingsPath)).toEqual(sentinelSettings);
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o640);

    // And the instance configRoot must be cleaned up (rollback still removes
    // the dirs it created).
    const configDir = path.join(process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'preserve-agent');
    expect(fs.existsSync(configDir)).toBe(false);
  });

  it('removes freshly-created .claude/CLAUDE.md and settings.json when no prior file existed', async () => {
    // Sanity: agentCwd has no `.claude/` to start with.
    const claudeDir = path.join(agentCwd, '.claude');
    expect(fs.existsSync(claudeDir)).toBe(false);

    const deps = failingDeps();
    const res = mockRes();
    await handleCreateLine(
      mockReq(JSON.stringify({
        name: 'fresh-agent',
        type: 'agent',
        adminPhones: ['15551234567'],
        agentOptions: { cwd: agentCwd, sessionScope: 'per_chat' },
        claudeMd: 'AGENT_PROMPT — should be removed\n',
      })),
      res,
      deps,
    );

    expect(res._status).toBe(500);

    // The fresh CLAUDE.md and settings.json we wrote must be gone.
    expect(fs.existsSync(path.join(claudeDir, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(false);

    // configRoot dir cleaned up too.
    const configDir = path.join(process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'fresh-agent');
    expect(fs.existsSync(configDir)).toBe(false);
  });
});
