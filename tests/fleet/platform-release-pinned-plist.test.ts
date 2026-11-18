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

vi.mock('node:child_process', () => childProcessMocks);
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

function pinnedPlist(program: string, extraArguments: string[] = []): string {
  return [
    '<plist>',
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
    '</plist>',
  ].join('\n');
}

function launchctlSubcommands(): string[] {
  return childProcessMocks.execFile.mock.calls.map((call) => (call[1] as string[])[0]);
}

describe('release-pinned launchd plists (#3829)', () => {
  beforeEach(async () => {
    const [realFs, realPath, realOs] = await Promise.all([realFsPromise, realPathPromise, realOsPromise]);
    SERVICE_HOME = realFs.realpathSync.native(realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'whatsoup-home-')));
    OUTSIDE_ROOT = realFs.realpathSync.native(realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'whatsoup-outside-')));

    for (const mock of [...Object.values(childProcessMocks), ...Object.values(fsMocks), osMocks.homedir]) {
      mock.mockReset();
    }
    osMocks.homedir.mockReturnValue(SERVICE_HOME);
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
});
