/**
 * F3 — route-layer home-confinement of the launchd `service` block
 * (`service.pathPrepend[]` and `service.claudeConfigDir`) on both admission
 * verbs: POST /api/lines (handleCreateLine) and PATCH /api/lines/:name/config
 * (handleConfigUpdate) — the canonical registered paths, per the route table at
 * src/fleet/index.ts:373 and :397.
 *
 * Before this file, `validateLaunchdServiceConfig`
 * (src/lib/launchd-service-config.ts) enforced only the *shape* of those two
 * fields — absolute, no control characters, no ':' — so an absolute path
 * outside the instance user's home was admitted on CREATE (since `service`
 * joined `PASSTHROUGH_FIELDS`) and on PATCH (deepMergeRecords preserves the
 * block), and was then rendered FIRST in the launchd service PATH.
 *
 * Confinement lives at the route layer, not in the shape validator, on
 * purpose: `validateLaunchdServiceConfig` also runs on config *load* and on
 * render admission (assertValidLaunchdPlistRenderOptions -> reconcileLaunchdPlist,
 * src/fleet/platform.ts), so rejecting an out-of-home value there would stop an
 * instance that already persisted one from loading at all. These guards close
 * the ingress; an already-persisted out-of-home entry still passes render
 * admission.
 *
 * Harness mirrors ops-create-service-passthrough.test.ts (HOME/XDG overridden
 * to a synthetic tmp tree) and ops-branches2.test.ts (handleConfigUpdate driven
 * against a discovered instance whose configPath is a real file). Every fixture
 * path is synthetic: out-of-home cases use `/fixture/...`, in-home cases are
 * built from the overridden HOME.
 *
 *   npx vitest run tests/fleet/routes/ops-service-home-confinement.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

import { handleCreateLine, handleConfigUpdate } from '../../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';

/** Absolute, shape-valid, and outside any plausible home directory. */
const OUT_OF_HOME_BIN = '/fixture/out-of-home/pin/bin';
const OUT_OF_HOME_CFG = '/fixture/out-of-home/claude-config';

describe('service block home-confinement (F3)', () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalConfigHome: string | undefined;
  let originalDataHome: string | undefined;
  let originalStateHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-service-confine-'));
    originalHome = process.env.HOME;
    originalConfigHome = process.env.XDG_CONFIG_HOME;
    originalDataHome = process.env.XDG_DATA_HOME;
    originalStateHome = process.env.XDG_STATE_HOME;

    process.env.HOME = path.join(tmpDir, 'home');
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    process.env.XDG_STATE_HOME = path.join(tmpDir, 'state');
    fs.mkdirSync(process.env.HOME, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
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

  /** Guards the harness itself: os.homedir() must follow the HOME override,
   *  otherwise every in-home fixture below would be vacuously out-of-home. */
  function homeDir(): string {
    const home = os.homedir();
    expect(home).toBe(process.env.HOME);
    return home;
  }

  function cfgPathFor(name: string): string {
    return path.join(
      process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', name, 'config.json',
    );
  }

  function createBody(service: Record<string, unknown>, name: string): string {
    return JSON.stringify({
      name,
      type: 'chat',
      adminPhones: ['15551234567'],
      service,
    });
  }

  // -------------------------------------------------------------------------
  // CREATE (handleCreateLine)
  // -------------------------------------------------------------------------

  it('rejects a CREATE whose service.pathPrepend entry is outside the home directory', async () => {
    const res = mockRes();
    await handleCreateLine(
      mockReq({ method: 'POST', body: createBody({ pathPrepend: [OUT_OF_HOME_BIN] }, 'svc-create-prepend-escape') }),
      res,
      makeDeps<any>({}),
    );

    expect(res._status, 'create must be refused: ' + res._body).toBe(400);
    expect(JSON.parse(res._body).error).toBe(
      'service.pathPrepend[0] must be within the home directory',
    );
    expect(fs.existsSync(cfgPathFor('svc-create-prepend-escape'))).toBe(false);
  });

  it('reports the offending index when a later service.pathPrepend entry escapes home', async () => {
    const res = mockRes();
    await handleCreateLine(
      mockReq({
        method: 'POST',
        body: createBody(
          { pathPrepend: [path.join(homeDir(), 'pin', 'bin'), OUT_OF_HOME_BIN] },
          'svc-create-prepend-escape-2',
        ),
      }),
      res,
      makeDeps<any>({}),
    );

    expect(res._status, 'create must be refused: ' + res._body).toBe(400);
    expect(JSON.parse(res._body).error).toBe(
      'service.pathPrepend[1] must be within the home directory',
    );
    expect(fs.existsSync(cfgPathFor('svc-create-prepend-escape-2'))).toBe(false);
  });

  it('rejects a CREATE whose service.claudeConfigDir is outside the home directory', async () => {
    const res = mockRes();
    await handleCreateLine(
      mockReq({ method: 'POST', body: createBody({ claudeConfigDir: OUT_OF_HOME_CFG }, 'svc-create-cfg-escape') }),
      res,
      makeDeps<any>({}),
    );

    expect(res._status, 'create must be refused: ' + res._body).toBe(400);
    expect(JSON.parse(res._body).error).toBe(
      'service.claudeConfigDir must be within the home directory',
    );
    expect(fs.existsSync(cfgPathFor('svc-create-cfg-escape'))).toBe(false);
  });

  it('admits a CREATE whose service paths are inside the home directory and persists them verbatim', async () => {
    const home = homeDir();
    const service = {
      claudeConfigDir: path.join(home, '.config', 'claude-instance'),
      pathPrepend: [path.join(home, 'pin', 'bin'), path.join(home, '.local', 'bin')],
    };
    const res = mockRes();
    await handleCreateLine(
      mockReq({ method: 'POST', body: createBody(service, 'svc-create-in-home') }),
      res,
      makeDeps<any>({}),
    );

    expect(res._status, 'create must succeed: ' + res._body).toBe(201);
    const persisted = JSON.parse(fs.readFileSync(cfgPathFor('svc-create-in-home'), 'utf-8'));
    expect(persisted.type).toBe('chat');
    // Verbatim: the guard validates, it never rewrites the operator's values.
    expect(persisted.service).toEqual(service);
  });

  // -------------------------------------------------------------------------
  // PATCH (handleConfigUpdate)
  // -------------------------------------------------------------------------

  /** A discovered chat instance whose config.json is a real file under the
   *  synthetic XDG config root, so PATCH can read-merge-write it. */
  function patchTarget(existingService?: Record<string, unknown>): { deps: OpsDeps; configPath: string } {
    const name = 'svc-patch-target';
    const configDir = path.join(process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', name);
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(configDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      name,
      type: 'chat',
      adminPhones: ['15551234567'],
      accessMode: 'self_only',
      healthPort: 9099,
      introSent: false,
      ...(existingService ? { service: existingService } : {}),
    }, null, 2) + '\n', { mode: 0o600 });

    const instance = {
      name, type: 'chat', accessMode: 'self_only',
      healthPort: 9099,
      dbPath: path.join(configDir, 'bot.db'),
      stateRoot: configDir,
      logDir: configDir,
      healthToken: 'tok',
      configPath,
      socketPath: null,
    } as DiscoveredInstance;
    const deps = makeDeps<any>({
      discovery: { getInstance: vi.fn(() => instance), scan: vi.fn() } as any,
    });
    return { deps, configPath };
  }

  it('rejects a PATCH whose service.pathPrepend entry is outside the home directory', async () => {
    const { deps, configPath } = patchTarget();
    const before = fs.readFileSync(configPath, 'utf-8');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ method: 'PATCH', body: JSON.stringify({ service: { pathPrepend: [OUT_OF_HOME_BIN] } }) }),
      res,
      deps,
      { name: 'svc-patch-target' },
    );

    expect(res._status, 'patch must be refused: ' + res._body).toBe(400);
    expect(JSON.parse(res._body).error).toBe(
      'service.pathPrepend[0] must be within the home directory',
    );
    // Refused before the read-merge-write commits.
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('rejects a PATCH whose service.claudeConfigDir is outside the home directory', async () => {
    const { deps, configPath } = patchTarget();
    const before = fs.readFileSync(configPath, 'utf-8');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ method: 'PATCH', body: JSON.stringify({ service: { claudeConfigDir: OUT_OF_HOME_CFG } }) }),
      res,
      deps,
      { name: 'svc-patch-target' },
    );

    expect(res._status, 'patch must be refused: ' + res._body).toBe(400);
    expect(JSON.parse(res._body).error).toBe(
      'service.claudeConfigDir must be within the home directory',
    );
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('rejects a PATCH that leaves an out-of-home entry standing in the merged view', async () => {
    // The guard runs on the post-merge config, not the bare patch: an instance
    // that already carries an out-of-home entry cannot be patched on an
    // unrelated field until the entry is corrected. Same property as the
    // sibling pluginDirs guard.
    const { deps } = patchTarget({ pathPrepend: [OUT_OF_HOME_BIN] });
    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ method: 'PATCH', body: JSON.stringify({ description: 'unrelated field' }) }),
      res,
      deps,
      { name: 'svc-patch-target' },
    );

    expect(res._status, 'patch must be refused: ' + res._body).toBe(400);
    expect(JSON.parse(res._body).error).toBe(
      'service.pathPrepend[0] must be within the home directory',
    );
  });

  it('admits a PATCH whose service paths are inside the home directory and persists them verbatim', async () => {
    const home = homeDir();
    const service = {
      claudeConfigDir: path.join(home, '.config', 'claude-instance'),
      pathPrepend: [path.join(home, 'pin', 'bin')],
    };
    const { deps, configPath } = patchTarget();
    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ method: 'PATCH', body: JSON.stringify({ service }) }),
      res,
      deps,
      { name: 'svc-patch-target' },
    );

    expect(res._status, 'patch must succeed: ' + res._body).toBe(200);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(persisted.name).toBe('svc-patch-target');
    expect(persisted.service).toEqual(service);
  });

  // -------------------------------------------------------------------------
  // F6 — `..` traversal THROUGH a symlink escapes home
  //
  // Admission validated the LEXICALLY resolved path but persisted the RAW
  // spelling. `path.resolve()` collapses `..` textually, so `<home>/jump/../x`
  // reads as `<home>/x` and passes the containment check, while the kernel
  // resolves `..` PHYSICALLY after following `jump` at exec time, landing
  // outside home. The raw spelling is what gets rendered into the service PATH.
  //
  // `fs.realpathSync` is NOT a usable oracle here: it calls path.resolve()
  // first, so it collapses `..` lexically before walking symlinks and reports
  // the in-home answer (or ENOENT). Only `fs.realpathSync.native` (libc
  // realpath(3)) performs physical resolution.
  // -------------------------------------------------------------------------

  /** Build a home-rooted spelling that traverses `..` through a symlink to a
   *  real directory outside home, and assert the escape is genuine before any
   *  route assertion depends on it. Returns the RAW spelling to submit. */
  function makeSymlinkEscape(): string {
    const home = homeDir();
    const outside = path.join(tmpDir, 'outside');
    const escapeTarget = path.join(tmpDir, 'escape');
    fs.mkdirSync(path.join(outside, 'bin'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(escapeTarget, { recursive: true, mode: 0o700 });
    fs.symlinkSync(outside, path.join(home, 'jump'));

    // String concatenation, NOT path.join: path.join would normalize the `..`
    // away and the fixture would silently stop exercising the defect.
    const raw = `${home}/jump/../escape`;

    // Harness self-check: this fixture is only meaningful if the spelling
    // LOOKS in-home lexically but resolves OUTSIDE home physically.
    expect(path.resolve(raw), 'lexical resolution must look in-home').toBe(path.join(home, 'escape'));
    expect(fs.realpathSync.native(raw), 'physical resolution must escape home').toBe(
      fs.realpathSync.native(escapeTarget),
    );
    expect(fs.realpathSync.native(raw).startsWith(home + path.sep)).toBe(false);
    return raw;
  }

  it('rejects a CREATE whose service.pathPrepend escapes home via `..` through a symlink', async () => {
    const raw = makeSymlinkEscape();
    const res = mockRes();
    await handleCreateLine(
      mockReq({ method: 'POST', body: createBody({ pathPrepend: [raw] }, 'svc-symlink-escape') }),
      res,
      makeDeps<any>({}),
    );

    expect(res._status, 'create must be refused: ' + res._body).toBe(400);
    expect(fs.existsSync(cfgPathFor('svc-symlink-escape'))).toBe(false);
  });

  it('rejects a CREATE whose service.claudeConfigDir escapes home via `..` through a symlink', async () => {
    const raw = makeSymlinkEscape();
    const res = mockRes();
    await handleCreateLine(
      mockReq({ method: 'POST', body: createBody({ claudeConfigDir: raw }, 'svc-symlink-escape-cfg') }),
      res,
      makeDeps<any>({}),
    );

    expect(res._status, 'create must be refused: ' + res._body).toBe(400);
    expect(fs.existsSync(cfgPathFor('svc-symlink-escape-cfg'))).toBe(false);
  });

  it('rejects a PATCH whose service.pathPrepend escapes home via `..` through a symlink', async () => {
    const raw = makeSymlinkEscape();
    const { deps, configPath } = patchTarget();
    const before = fs.readFileSync(configPath, 'utf-8');
    const res = mockRes();
    await handleConfigUpdate(
      mockReq({ method: 'PATCH', body: JSON.stringify({ service: { pathPrepend: [raw] } }) }),
      res,
      deps,
      { name: 'svc-patch-target' },
    );

    expect(res._status, 'patch must be refused: ' + res._body).toBe(400);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('rejects agentOptions.pluginDirs escaping home the same way (shared predicate)', async () => {
    // Same predicate, same defect. Pinned here so the shared fix is covered on
    // the sibling caller too.
    const raw = makeSymlinkEscape();
    const res = mockRes();
    await handleCreateLine(
      mockReq({
        method: 'POST',
        body: JSON.stringify({
          name: 'svc-plugindirs-escape',
          type: 'agent',
          adminPhones: ['15551234567'],
          agentOptions: { pluginDirs: [raw] },
        }),
      }),
      res,
      makeDeps<any>({}),
    );

    expect(res._status, 'create must be refused: ' + res._body).toBe(400);
    expect(fs.existsSync(cfgPathFor('svc-plugindirs-escape'))).toBe(false);
  });

  it('rejects a service.pathPrepend entry that is the home directory itself', async () => {
    const res = mockRes();
    await handleCreateLine(
      mockReq({ method: 'POST', body: createBody({ pathPrepend: [homeDir()] }, 'svc-prepend-is-home') }),
      res,
      makeDeps<any>({}),
    );

    expect(res._status, 'create must be refused: ' + res._body).toBe(400);
    expect(fs.existsSync(cfgPathFor('svc-prepend-is-home'))).toBe(false);
  });

  it('rejects a non-normalized service.pathPrepend spelling even without a symlink', async () => {
    // Rendered verbatim into PATH, so a `..` segment is refused on spelling
    // alone: whether it escapes depends on filesystem state at exec time, which
    // admission cannot see.
    const home = homeDir();
    const res = mockRes();
    await handleCreateLine(
      mockReq({ method: 'POST', body: createBody({ pathPrepend: [`${home}/pin/../pin/bin`] }, 'svc-unnormalized') }),
      res,
      makeDeps<any>({}),
    );

    expect(res._status, 'create must be refused: ' + res._body).toBe(400);
    expect(fs.existsSync(cfgPathFor('svc-unnormalized'))).toBe(false);
  });

  it('accepts an in-home directory whose name merely starts with dots', async () => {
    // `pathIsInsideDirectory` tested `relative.startsWith('..')`, which also
    // matches a legitimate sibling-free in-home name like `..config`. That is
    // an over-rejection, not an escape: the path is genuinely inside home.
    const home = homeDir();
    const service = { pathPrepend: [path.join(home, '..config', 'bin')] };
    const res = mockRes();
    await handleCreateLine(
      mockReq({ method: 'POST', body: createBody(service, 'svc-dotdot-name') }),
      res,
      makeDeps<any>({}),
    );

    expect(res._status, 'create must succeed: ' + res._body).toBe(201);
    const persisted = JSON.parse(fs.readFileSync(cfgPathFor('svc-dotdot-name'), 'utf-8'));
    expect(persisted.service).toEqual(service);
  });
});
