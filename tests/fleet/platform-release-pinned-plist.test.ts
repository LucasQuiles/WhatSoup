/**
 * #3829: lifecycle commands accept a release-pinned instance plist
 * (`<release>/deploy/whatsoup <instance>`, the form the macOS launchd runbook
 * documents) only when its release identity is validated, and the writers that
 * re-render the generated form refuse it instead of repointing the job.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const osMocks = vi.hoisted(() => ({
  homedir: vi.fn(),
}));

const flagsMocks = vi.hoisted(() => ({
  readFileFlags: vi.fn(),
  canWriteFolder: vi.fn(),
}));

vi.mock('node:child_process', () => childProcessMocks);
vi.mock('../../src/fleet/launchd-plist-flags.ts', () => flagsMocks);
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: fsMocks.existsSync,
  mkdirSync: fsMocks.mkdirSync,
  readFileSync: fsMocks.readFileSync,
  renameSync: fsMocks.renameSync,
  writeFileSync: fsMocks.writeFileSync,
  unlinkSync: fsMocks.unlinkSync,
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: osMocks.homedir,
}));

const realFsPromise = vi.importActual<typeof import('node:fs')>('node:fs');
const realPathPromise = vi.importActual<typeof import('node:path')>('node:path');
const realOsPromise = vi.importActual<typeof import('node:os')>('node:os');

const originalPlatform = process.platform;
const MANIFEST = '.whatsoup-release-manifest.json';
const RELEASE_NAME = 'WhatSoup-release-d7c775a746bd';
const RELEASE_REFUSAL = 'does not match the generated WhatSoup instance identity or a release-pinned one';

let SERVICE_HOME: string;
let OUTSIDE_ROOT: string;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

async function importPlatform(): Promise<typeof import('../../src/fleet/platform.ts')> {
  vi.resetModules();
  return import('../../src/fleet/platform.ts');
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') throw new Error('missing test uid');
  return process.getuid();
}

function absentFile(): never {
  const error = new Error('not found') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  throw error;
}

type Shape = 'file' | 'directory' | 'absent' | 'symlink';

const LAUNCHER_BODY = '#!/bin/sh\n';
const LAUNCHER_SHA256 = createHash('sha256').update(LAUNCHER_BODY).digest('hex');

/** A release manifest as the exporter writes it: full commit, deploy/whatsoup digest. */
function manifestFor(releaseName: string, launcherSha256 = LAUNCHER_SHA256, commit?: string): string {
  const sha = releaseName.replace(/^WhatSoup-release-/u, '');
  return `${JSON.stringify({
    schemaVersion: 2,
    source: { ref: 'main', commit: commit ?? sha.padEnd(40, '0') },
    files: [{ path: 'deploy/whatsoup', sha256: launcherSha256 }],
  })}\n`;
}

/**
 * Create a real `<root>/<releaseName>` on disk and return its launcher path.
 * The guard checks real file types, so nothing here is mocked: the launcher and
 * the manifest are each a regular file, a directory, absent, or a symlink to a
 * regular file with the same bytes.
 */
async function makeRelease(
  root: string,
  options: { releaseName?: string; launcher?: Shape; manifest?: Shape; manifestBody?: string } = {},
): Promise<string> {
  const [realFs, realPath] = await Promise.all([realFsPromise, realPathPromise]);
  const releaseName = options.releaseName ?? RELEASE_NAME;
  const release = realPath.join(root, releaseName);
  const program = realPath.join(release, 'deploy', 'whatsoup');
  realFs.mkdirSync(realPath.join(release, 'deploy'), { recursive: true });
  const place = (target: string, shape: Shape, body: string): void => {
    if (shape === 'file') realFs.writeFileSync(target, body);
    if (shape === 'directory') realFs.mkdirSync(target);
    if (shape === 'symlink') {
      realFs.writeFileSync(`${target}.real`, body);
      realFs.symlinkSync(`${target}.real`, target);
    }
  };
  place(program, options.launcher ?? 'file', LAUNCHER_BODY);
  place(realPath.join(release, MANIFEST), options.manifest ?? 'file', options.manifestBody ?? manifestFor(releaseName));
  return program;
}

/** A loadable instance plist: one top-level dict holding Label and ProgramArguments. */
function pinnedPlist(program: string, extraArguments: string[] = []): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    '<dict>',
    '<key>Label</key>',
    '<string>com.whatsoup.agent</string>',
    '<key>ProgramArguments</key>',
    '<array>',
    `<string>${program}</string>`,
    '<string>agent</string>',
    ...extraArguments.map((argument) => `<string>${argument}</string>`),
    '</array>',
    '<key>EnvironmentVariables</key>',
    '<dict><key>PATH</key><string>/usr/bin</string></dict>',
    '</dict>',
    '</plist>',
  ].join('\n');
}

function launchctlSubcommands(): string[] {
  return childProcessMocks.execFile.mock.calls.map((call) => (call[1] as string[])[0]);
}

function launchctlCalls(): string[][] {
  return childProcessMocks.execFile.mock.calls.filter((call) => call[0] === 'launchctl').map((call) => call[1] as string[]);
}

/** Answer the boot preflight with `failure` (null is exit 0); every other command succeeds. */
function preflightAnswers(failure: Error | null): void {
  childProcessMocks.execFile.mockImplementation((command: string, _args, optionsOrCallback, maybeCallback) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    queueMicrotask(() => callback?.(command.endsWith('/preflight-check.sh') ? failure : null, '', ''));
    return new EventEmitter();
  });
}

/** The error execFile reports for a non-zero exit: `code` is the exit status. */
function exitStatus(code: number): Error {
  return Object.assign(new Error('Command failed'), { code });
}

describe('release-pinned launchd plists (#3829)', () => {
  beforeEach(async () => {
    const [realFs, realPath, realOs] = await Promise.all([realFsPromise, realPathPromise, realOsPromise]);
    SERVICE_HOME = realFs.realpathSync.native(realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'whatsoup-home-')));
    OUTSIDE_ROOT = realFs.realpathSync.native(realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'whatsoup-outside-')));

    for (const mock of [...Object.values(childProcessMocks), ...Object.values(fsMocks), osMocks.homedir, ...Object.values(flagsMocks)]) {
      mock.mockReset();
    }
    osMocks.homedir.mockReturnValue(SERVICE_HOME);
    flagsMocks.readFileFlags.mockReturnValue(0);
    flagsMocks.canWriteFolder.mockReturnValue(true);
    fsMocks.readFileSync.mockImplementation(absentFile);
    // existsSync is not part of the release check; a permissive mock proves the
    // guard does not lean on it.
    fsMocks.existsSync.mockReturnValue(true);
    childProcessMocks.execFile.mockImplementation((_cmd, _args, optionsOrCallback, maybeCallback) => {
      const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      queueMicrotask(() => callback?.(null, '', ''));
      return new EventEmitter();
    });
    setPlatform('darwin');
  });

  afterEach(async () => {
    const realFs = await realFsPromise;
    realFs.rmSync(SERVICE_HOME, { recursive: true, force: true });
    realFs.rmSync(OUTSIDE_ROOT, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setPlatform(originalPlatform);
  });

  const releases = (): string => `${SERVICE_HOME}/.local/opt/whatsoup/releases`;

  it('self-restarts a release-pinned job with exactly one kickstart -k and no bootout or bootstrap', async () => {
    fsMocks.readFileSync.mockReturnValue(pinnedPlist(await makeRelease(releases())));
    const { createServiceManager } = await importPlatform();

    await expect(createServiceManager().restartSelf('agent')).resolves.toBeUndefined();

    expect(childProcessMocks.execFile).toHaveBeenCalledTimes(1);
    expect(childProcessMocks.execFile).toHaveBeenCalledWith(
      'launchctl',
      ['kickstart', '-k', `gui/${currentUid()}/com.whatsoup.agent`],
      expect.any(Function),
    );
    expect(launchctlSubcommands()).not.toContain('bootout');
    expect(launchctlSubcommands()).not.toContain('bootstrap');
  });

  it('restarts a release-pinned job from another process by bootout, bootstrap of the same plist, then kickstart -k', async () => {
    fsMocks.readFileSync.mockReturnValue(pinnedPlist(await makeRelease(releases())));
    const { createServiceManager } = await importPlatform();

    await expect(createServiceManager().restart('agent')).resolves.toBeUndefined();

    expect(launchctlSubcommands()).toEqual(['bootout', 'bootstrap', 'kickstart']);
    expect(childProcessMocks.execFile.mock.calls[1][1]).toEqual([
      'bootstrap', `gui/${currentUid()}`, `${SERVICE_HOME}/Library/LaunchAgents/com.whatsoup.agent.plist`,
    ]);
    // bootstrapLaunchdService always follows bootstrap with kickstart -k (same contract as platform-service-manager.test.ts).
    expect(childProcessMocks.execFile.mock.calls[2][1]).toEqual(['kickstart', '-k', `gui/${currentUid()}/com.whatsoup.agent`]);
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });

  // kickstart -k stops the running process before the launcher's boot
  // preflight runs, so restart_self asks the job's own release first.
  describe('boot preflight before a self-restart', () => {
    const release = (): string => `${releases()}/${RELEASE_NAME}`;

    it('runs the release-pinned release preflight, then a self-restart issues exactly one kickstart -k', async () => {
      fsMocks.readFileSync.mockReturnValue(pinnedPlist(await makeRelease(releases())));
      const { createServiceManager, RESTART_SELF_PREFLIGHT_TIMEOUT_MS } = await importPlatform();
      const manager = createServiceManager();

      await expect(manager.checkRestartSelf?.('agent')).resolves.toEqual({ ok: true });
      await expect(manager.restartSelf('agent')).resolves.toBeUndefined();

      expect(childProcessMocks.execFile.mock.calls.map((call) => call[0])).toEqual([
        `${release()}/deploy/preflight-check.sh`,
        'launchctl',
      ]);
      expect(childProcessMocks.execFile.mock.calls[0][1]).toEqual([release(), 'agent']);
      expect(childProcessMocks.execFile.mock.calls[0][2]).toMatchObject({
        cwd: release(),
        timeout: RESTART_SELF_PREFLIGHT_TIMEOUT_MS,
      });
      expect(launchctlCalls()).toEqual([['kickstart', '-k', `gui/${currentUid()}/com.whatsoup.agent`]]);
    });

    it('refuses with the exit code when the release preflight exits 3, before any launchctl call', async () => {
      fsMocks.readFileSync.mockReturnValue(pinnedPlist(await makeRelease(releases())));
      preflightAnswers(exitStatus(3));
      const { createServiceManager } = await importPlatform();

      await expect(createServiceManager().checkRestartSelf?.('agent')).resolves.toEqual({ ok: false, exitCode: 3 });
      expect(childProcessMocks.execFile).toHaveBeenCalledTimes(1);
      expect(launchctlCalls()).toEqual([]);
    });

    it('runs the standalone form: no ledger deferral, no credential, and the job interpreter', async () => {
      vi.stubEnv('WHATSOUP_PREFLIGHT_RESTART_SAFETY', 'wrapper');
      vi.stubEnv('ANTHROPIC_API_KEY', 'placeholder-value');
      vi.stubEnv('WHATSOUP_NODE', '/opt/node-a/bin/node');
      vi.stubEnv('XDG_DATA_HOME', `${SERVICE_HOME}/data-a`);
      fsMocks.readFileSync.mockReturnValue(pinnedPlist(await makeRelease(releases())));
      const { createServiceManager } = await importPlatform();

      await expect(createServiceManager().checkRestartSelf?.('agent')).resolves.toEqual({ ok: true });

      const { env } = childProcessMocks.execFile.mock.calls[0][2] as { env: NodeJS.ProcessEnv };
      expect(env).not.toHaveProperty('WHATSOUP_PREFLIGHT_RESTART_SAFETY');
      expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(env.WHATSOUP_NODE).toBe('/opt/node-a/bin/node');
      expect(env.XDG_DATA_HOME).toBe(`${SERVICE_HOME}/data-a`);
    });

    const notRun: Array<[string, Error]> = [
      // At its timeout execFile kills the child and reports no exit status.
      ['times out', Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null })],
      ['cannot start', Object.assign(new Error('spawn failed'), { code: 'EACCES' })],
    ];

    for (const [outcome, failure] of notRun) {
      it(`refuses with no exit code when the release preflight ${outcome}, before any launchctl call`, async () => {
        fsMocks.readFileSync.mockReturnValue(pinnedPlist(await makeRelease(releases())));
        preflightAnswers(failure);
        const { createServiceManager } = await importPlatform();

        await expect(createServiceManager().checkRestartSelf?.('agent')).resolves.toEqual({ ok: false, exitCode: null });
        expect(childProcessMocks.execFile).toHaveBeenCalledTimes(1);
        expect(launchctlCalls()).toEqual([]);
      });
    }

    it('checks the release the shared wrapper resolves to for a generated plist', async () => {
      const realFs = await realFsPromise;
      const program = await makeRelease(releases());
      realFs.mkdirSync(`${SERVICE_HOME}/.local/bin`, { recursive: true });
      realFs.symlinkSync(program, `${SERVICE_HOME}/.local/bin/whatsoup`);
      fsMocks.readFileSync.mockReturnValue(pinnedPlist(`${SERVICE_HOME}/.local/bin/whatsoup`));
      const { createServiceManager } = await importPlatform();

      await expect(createServiceManager().checkRestartSelf?.('agent')).resolves.toEqual({ ok: true });

      expect(childProcessMocks.execFile).toHaveBeenCalledTimes(1);
      expect(childProcessMocks.execFile.mock.calls[0][0]).toBe(`${release()}/deploy/preflight-check.sh`);
      expect(childProcessMocks.execFile.mock.calls[0][1]).toEqual([release(), 'agent']);
    });
  });

  const refusals: Array<[string, () => Promise<string>]> = [
    ['the manifest is absent', async () => pinnedPlist(await makeRelease(releases(), { manifest: 'absent' }))],
    ['the manifest is a directory', async () => pinnedPlist(await makeRelease(releases(), { manifest: 'directory' }))],
    ['the launcher is absent', async () => pinnedPlist(await makeRelease(releases(), { launcher: 'absent' }))],
    ['the launcher is a directory', async () => pinnedPlist(await makeRelease(releases(), { launcher: 'directory' }))],
    ['the launcher is a symlink to matching bytes', async () => pinnedPlist(await makeRelease(releases(), { launcher: 'symlink' }))],
    ['the manifest is a symlink to a matching manifest', async () => pinnedPlist(await makeRelease(releases(), { manifest: 'symlink' }))],
    ['the manifest is an empty object', async () => pinnedPlist(await makeRelease(releases(), { manifestBody: '{}\n' }))],
    ['the manifest is not JSON', async () => pinnedPlist(await makeRelease(releases(), { manifestBody: 'not json\n' }))],
    ['the manifest names another commit', async () =>
      pinnedPlist(await makeRelease(releases(), { manifestBody: manifestFor(RELEASE_NAME, LAUNCHER_SHA256, 'f'.repeat(40)) }))],
    ['the manifest digest does not match the launcher', async () =>
      pinnedPlist(await makeRelease(releases(), { manifestBody: manifestFor(RELEASE_NAME, '0'.repeat(64)) }))],
    ['the launcher directory is absent', async () => {
      const program = await makeRelease(releases());
      const realFs = await realFsPromise;
      realFs.rmSync(program.slice(0, -'/whatsoup'.length), { recursive: true });
      return pinnedPlist(program);
    }],
    ['a third argument follows the instance', async () => pinnedPlist(await makeRelease(releases()), ['--extra'])],
    ['the directory is not a WhatSoup-release-<sha> directory', async () =>
      pinnedPlist(await makeRelease(`${SERVICE_HOME}/.local/opt`, { releaseName: 'WhatSoup-main' }))],
    ['the release lies outside home', async () => pinnedPlist(await makeRelease(OUTSIDE_ROOT))],
    ['a home path reaches an outside release through a symlink', async () => {
      const realFs = await realFsPromise;
      await makeRelease(OUTSIDE_ROOT);
      realFs.symlinkSync(OUTSIDE_ROOT, `${SERVICE_HOME}/releases`);
      return pinnedPlist(`${SERVICE_HOME}/releases/${RELEASE_NAME}/deploy/whatsoup`);
    }],
    // The next two pass every other check (in-home target, name, manifest,
    // digest), so only the lstat checks on the two directories refuse them.
    ['the release directory is a symlink to a release inside home', async () => {
      const realFs = await realFsPromise;
      const held = `${SERVICE_HOME}/.local/opt/whatsoup/held`;
      await makeRelease(held);
      realFs.mkdirSync(releases(), { recursive: true });
      realFs.symlinkSync(`${held}/${RELEASE_NAME}`, `${releases()}/${RELEASE_NAME}`);
      return pinnedPlist(`${releases()}/${RELEASE_NAME}/deploy/whatsoup`);
    }],
    ['the deploy directory is a symlink to a directory inside home', async () => {
      const realFs = await realFsPromise;
      const release = `${releases()}/${RELEASE_NAME}`;
      const heldDeploy = `${SERVICE_HOME}/.local/opt/whatsoup/held-deploy`;
      realFs.mkdirSync(heldDeploy, { recursive: true });
      realFs.writeFileSync(`${heldDeploy}/whatsoup`, LAUNCHER_BODY);
      realFs.mkdirSync(release, { recursive: true });
      realFs.writeFileSync(`${release}/${MANIFEST}`, manifestFor(RELEASE_NAME));
      realFs.symlinkSync(heldDeploy, `${release}/deploy`);
      return pinnedPlist(`${release}/deploy/whatsoup`);
    }],
    ['the program is not deploy/whatsoup', async () =>
      pinnedPlist((await makeRelease(releases())).replace('/deploy/whatsoup', '/deploy/whatsoup-fleet'))],
    ['the path is not canonical', async () => {
      await makeRelease(releases());
      return pinnedPlist(`${releases()}/../releases/${RELEASE_NAME}/deploy/whatsoup`);
    }],
    ['the instance argument names another instance', async () =>
      pinnedPlist(await makeRelease(releases())).replace('<string>agent</string>', '<string>other</string>')],
  ];

  for (const [reason, plistFor] of refusals) {
    it(`refuses self-restart, stop and disable when ${reason}`, async () => {
      fsMocks.readFileSync.mockReturnValue(await plistFor());
      const { createServiceManager } = await importPlatform();
      const manager = createServiceManager();

      await expect(manager.checkRestartSelf?.('agent')).rejects.toThrow(RELEASE_REFUSAL);
      await expect(manager.restartSelf('agent')).rejects.toThrow(RELEASE_REFUSAL);
      await expect(manager.stop('agent')).rejects.toThrow(RELEASE_REFUSAL);
      await expect(manager.disable('agent')).rejects.toThrow(RELEASE_REFUSAL);
      expect(childProcessMocks.execFile).not.toHaveBeenCalled();
      expect(fsMocks.unlinkSync).not.toHaveBeenCalled();
    });
  }

  it('refuses to reconcile a release-pinned plist rather than repoint it, and writes nothing', async () => {
    const program = await makeRelease(releases());
    fsMocks.readFileSync.mockImplementation((target: unknown) => {
      if (String(target).endsWith('.plist')) return pinnedPlist(program);
      return absentFile();
    });
    const { reconcileLaunchdPlist } = await importPlatform();

    await expect(reconcileLaunchdPlist('agent', {})).rejects.toThrow('is release-pinned');
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(fsMocks.renameSync).not.toHaveBeenCalled();
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  const plistPath = (): string => `${SERVICE_HOME}/Library/LaunchAgents/com.whatsoup.agent.plist`;

  // A root-owned uchg release plist is a documented protected configuration
  // (docs/runbooks/release-deployment.md). unlink(2) fails while one of these is set.
  const protectedFlags: Array<[string, number]> = [
    ['uchg', 0x2],
    ['uappnd', 0x4],
    ['schg', 0x20000],
    ['sappnd', 0x40000],
  ];

  for (const [flag, value] of protectedFlags) {
    it(`refuses to disable a release-pinned plist with ${flag} before any launchctl call, and still stops it`, async () => {
      fsMocks.readFileSync.mockReturnValue(pinnedPlist(await makeRelease(releases())));
      flagsMocks.readFileFlags.mockReturnValue(value);
      const { createServiceManager } = await importPlatform();
      const manager = createServiceManager();

      expect(() => manager.assertCanDisable?.('agent')).toThrow('cannot be removed');
      await expect(manager.disable('agent')).rejects.toThrow('cannot be removed');
      expect(flagsMocks.readFileFlags).toHaveBeenCalledWith(plistPath());
      expect(childProcessMocks.execFile).not.toHaveBeenCalled();
      expect(fsMocks.unlinkSync).not.toHaveBeenCalled();

      // Stopping a protected job stays allowed; only its removal is refused.
      await expect(manager.stop('agent')).resolves.toBeUndefined();
      expect(launchctlSubcommands()).toEqual(['bootout']);
    });
  }

  it('refuses to disable when the plist file flags cannot be read', async () => {
    fsMocks.readFileSync.mockReturnValue(pinnedPlist(await makeRelease(releases())));
    flagsMocks.readFileFlags.mockImplementation(() => { throw new Error('stat timed out'); });
    const { createServiceManager } = await importPlatform();
    const manager = createServiceManager();

    expect(() => manager.assertCanDisable?.('agent')).toThrow('cannot read the file flags');
    await expect(manager.disable('agent')).rejects.toThrow('cannot read the file flags');
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
    expect(fsMocks.unlinkSync).not.toHaveBeenCalled();
  });

  const launchAgentsPath = (): string => `${SERVICE_HOME}/Library/LaunchAgents`;
  const unreadable = (): never => { throw new Error('stat timed out'); };

  // unlink(2) also fails when the plist's folder is immutable or append-only, or
  // when this process cannot write it, whatever the plist's own flags are.
  for (const [flag, value] of protectedFlags) {
    it(`refuses to disable when the LaunchAgents folder has ${flag}, before any launchctl call`, async () => {
      fsMocks.readFileSync.mockReturnValue(pinnedPlist(await makeRelease(releases())));
      flagsMocks.readFileFlags.mockImplementation((filePath: string) => (filePath === launchAgentsPath() ? value : 0));
      const { createServiceManager } = await importPlatform();
      const manager = createServiceManager();

      expect(() => manager.assertCanDisable?.('agent')).toThrow('cannot be removed');
      await expect(manager.disable('agent')).rejects.toThrow('cannot be removed');
      expect(flagsMocks.readFileFlags).toHaveBeenCalledWith(launchAgentsPath());
      expect(childProcessMocks.execFile).not.toHaveBeenCalled();
      expect(fsMocks.unlinkSync).not.toHaveBeenCalled();

      await expect(manager.stop('agent')).resolves.toBeUndefined();
      expect(launchctlSubcommands()).toEqual(['bootout']);
    });
  }

  it('refuses to disable when this process cannot write the LaunchAgents folder, before any launchctl call', async () => {
    fsMocks.readFileSync.mockReturnValue(pinnedPlist(await makeRelease(releases())));
    flagsMocks.canWriteFolder.mockReturnValue(false);
    const { createServiceManager } = await importPlatform();
    const manager = createServiceManager();

    expect(() => manager.assertCanDisable?.('agent')).toThrow('cannot be removed');
    await expect(manager.disable('agent')).rejects.toThrow('cannot be removed');
    expect(flagsMocks.canWriteFolder).toHaveBeenCalledWith(launchAgentsPath());
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
    expect(fsMocks.unlinkSync).not.toHaveBeenCalled();
  });

  it('refuses to disable when the LaunchAgents folder flags cannot be read', async () => {
    fsMocks.readFileSync.mockReturnValue(pinnedPlist(await makeRelease(releases())));
    flagsMocks.readFileFlags.mockImplementation((filePath: string) => (filePath === launchAgentsPath() ? unreadable() : 0));
    const { createServiceManager } = await importPlatform();
    const manager = createServiceManager();

    expect(() => manager.assertCanDisable?.('agent')).toThrow('cannot read the file flags');
    await expect(manager.disable('agent')).rejects.toThrow('cannot read the file flags');
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
    expect(fsMocks.unlinkSync).not.toHaveBeenCalled();
  });

  it('disables a release-pinned plist whose flags do not block removal: bootout, then unlink', async () => {
    fsMocks.readFileSync.mockReturnValue(pinnedPlist(await makeRelease(releases())));
    // UF_NODUMP (0x1) and UF_HIDDEN (0x8000) do not stop unlink(2).
    flagsMocks.readFileFlags.mockReturnValue(0x1 | 0x8000);
    const { createServiceManager } = await importPlatform();
    const manager = createServiceManager();

    expect(() => manager.assertCanDisable?.('agent')).not.toThrow();
    await expect(manager.disable('agent')).resolves.toBeUndefined();
    expect(launchctlSubcommands()).toEqual(['bootout']);
    expect(fsMocks.unlinkSync).toHaveBeenCalledWith(plistPath());
  });

  it('reads no file flags when no plist is installed', async () => {
    const { createServiceManager } = await importPlatform();

    expect(() => createServiceManager().assertCanDisable?.('agent')).not.toThrow();
    expect(flagsMocks.readFileFlags).not.toHaveBeenCalled();
  });
});
