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
import { handleCreateLine } from '../../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import { configRoot, dataRoot, stateRoot } from '../../../src/fleet/paths.ts';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';

// The health-token copy must not query the host keyring from a test.
vi.mock('../../../src/lib/keyring.ts', () => ({ lookupCredential: vi.fn(() => null) }));

// The message of the manager selected on Linux without systemd, whose enable and
// disable both reject (src/fleet/platform.ts NoSystemdServiceManager; pinned in
// tests/fleet/platform-service-manager.test.ts).
const NO_SYSTEMD_ERROR = 'Service management requires systemd. If running under WSL, enable systemd:\n'
  + '  1. Add "[boot]\\nsystemd=true" to /etc/wsl.conf\n'
  + '  2. Restart WSL: wsl --shutdown\n'
  + 'Alternatively, run instances directly: node src/bootstrap.ts <name>';

function failingDeps(): OpsDeps {
  return makeDeps<any>({
    serviceManager: {
      // Force the rollback path: enable() throws after extras are written.
      enable: vi.fn().mockRejectedValue(new Error('boom: simulated service enable failure')),
    } as any,
  });
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
      mockReq({
        method: 'POST',
        body: JSON.stringify({
          name: 'preserve-agent',
          type: 'agent',
          adminPhones: ['15551234567'],
          agentOptions: { cwd: agentCwd, sessionScope: 'per_chat' },
          claudeMd: 'AGENT_PROMPT — should be rolled back\n',
        }),
      }),
      res,
      deps,
    );

    expect(res._status).toBe(500);
    const body = JSON.parse(res._body);
    expect(body.schema).toBe('fleet-error-v1');
    expect(body.code).toBe('internal_error');
    expect(body.operation).toBe('instance_create');
    expect(body.mutation_state).toBe('rolled_back');
    expect(body.rollback_state).toBe('succeeded');

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
      mockReq({
        method: 'POST',
        body: JSON.stringify({
          name: 'fresh-agent',
          type: 'agent',
          adminPhones: ['15551234567'],
          agentOptions: { cwd: agentCwd, sessionScope: 'per_chat' },
          claudeMd: 'AGENT_PROMPT — should be removed\n',
        }),
      }),
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

  function seedUserFiles() {
    const claudeDir = path.join(agentCwd, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    const files = [
      { path: path.join(claudeDir, 'CLAUDE.md'), bytes: Buffer.from('# user instructions\n'), mode: 0o644 },
      { path: path.join(claudeDir, 'settings.json'), bytes: Buffer.from('{ "user": true }\n'), mode: 0o640 },
    ];
    for (const file of files) {
      fs.writeFileSync(file.path, file.bytes);
      fs.chmodSync(file.path, file.mode);
    }
    return files;
  }

  function createRequest(name: string) {
    return mockReq({
      method: 'POST',
      body: JSON.stringify({
        name, type: 'agent', adminPhones: ['15551234567'],
        agentOptions: { cwd: agentCwd, sessionScope: 'per_chat' },
        claudeMd: 'AGENT_PROMPT — must not outlive a failed create\n',
      }),
    });
  }

  function expectRestoredAndRemoved(name: string, files: ReturnType<typeof seedUserFiles>) {
    for (const file of files) {
      expect(fs.readFileSync(file.path)).toEqual(file.bytes);
      expect(fs.statSync(file.path).mode & 0o777).toBe(file.mode);
    }
    for (const dir of [path.join(configRoot(), name), dataRoot(name), stateRoot(name)]) {
      expect(fs.existsSync(dir)).toBe(false);
    }
  }

  async function expectRetryIsNotRefused(name: string) {
    const retry = mockRes();
    await handleCreateLine(createRequest(name), retry, makeDeps<any>({}) as OpsDeps);
    expect(retry._status).toBe(201);
  }

  it.each([
    ['a rejected compensating disable', new Error('disable response lost'), new Error('enable response lost')],
    ['the no-systemd manager rejecting both calls', new Error(NO_SYSTEMD_ERROR), new Error(NO_SYSTEMD_ERROR)],
  ])('restores user files and removes the instance after a rejected enable and %s', async (_case, disableError, enableError) => {
    const files = seedUserFiles();
    const name = 'uncompensated-agent';
    const deps = makeDeps<any>({
      serviceManager: {
        enable: vi.fn().mockRejectedValue(enableError),
        disable: vi.fn().mockRejectedValue(disableError),
      } as any,
    }) as OpsDeps;
    const res = mockRes();

    await handleCreateLine(createRequest(name), res, deps);

    expectRestoredAndRemoved(name, files);
    expect(res._status).toBe(500);
    expect(JSON.parse(res._body)).toMatchObject({
      schema: 'fleet-error-v1', operation: 'instance_create', stage: 'rollback', code: 'rollback_failed',
      mutation_state: 'unknown', rollback_state: 'failed', retryable: false, correlation_id: expect.any(String),
    });
    expect(res._body).not.toContain('systemd');
    expect(res._body).not.toContain('response lost');
    expect(deps.serviceManager.disable).toHaveBeenCalledWith(name);
    expect(deps.realtime.publish).not.toHaveBeenCalled();
    await expectRetryIsNotRefused(name);
  });

  it('restores user files when enable succeeded, a later step failed and the disable rejected', async () => {
    const files = seedUserFiles();
    const name = 'late-failure-agent';
    const deps = makeDeps<any>({
      serviceManager: { disable: vi.fn().mockRejectedValue(new Error('disable response lost')) } as any,
      discovery: { scan: vi.fn(() => { throw new Error('scan failed after enable'); }) } as any,
    }) as OpsDeps;
    const res = mockRes();

    await handleCreateLine(createRequest(name), res, deps);

    expect(deps.serviceManager.enable).toHaveBeenCalledWith(name);
    expect(res._status).toBe(500);
    // The service may still be enabled; the response says so instead of claiming a rollback.
    expect(JSON.parse(res._body)).toMatchObject({
      code: 'rollback_failed', stage: 'rollback', mutation_state: 'unknown', rollback_state: 'failed', retryable: false,
    });
    expectRestoredAndRemoved(name, files);
  });
});
