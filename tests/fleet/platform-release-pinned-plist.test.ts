/**
 * #3829: lifecycle commands accept a release-pinned instance plist
 * (`<release>/deploy/whatsoup <instance>`, the form the macOS launchd runbook
 * documents) only when its release identity is validated, and the writers that
 * re-render the generated form refuse it instead of repointing the job.
 */
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

let SERVICE_HOME: string;
let OUTSIDE_ROOT: string;
/** Release directories whose manifest the mocked existsSync reports present. */
let manifestPresent: Set<string>;

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

/** Create `<root>/<releaseName>/deploy/whatsoup` on disk and return the program path. */
async function makeRelease(root: string, releaseName = RELEASE_NAME, withManifest = true): Promise<string> {
  const [realFs, realPath] = await Promise.all([realFsPromise, realPathPromise]);
  const release = realPath.join(root, releaseName);
  realFs.mkdirSync(realPath.join(release, 'deploy'), { recursive: true });
  const program = realPath.join(release, 'deploy', 'whatsoup');
  realFs.writeFileSync(program, '#!/bin/sh\n');
  if (withManifest) manifestPresent.add(release);
  return program;
}

function pinnedPlist(program: string, name = 'agent'): string {
  return [
    '<plist>',
    '<key>Label</key>',
    `<string>com.whatsoup.${name}</string>`,
    '<key>ProgramArguments</key>',
    '<array>',
    `<string>${program}</string>`,
    `<string>${name}</string>`,
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
    manifestPresent = new Set();

    for (const mock of [...Object.values(childProcessMocks), ...Object.values(fsMocks), osMocks.homedir]) {
      mock.mockReset();
    }
    osMocks.homedir.mockReturnValue(SERVICE_HOME);
    fsMocks.readFileSync.mockImplementation(absentFile);
    fsMocks.existsSync.mockImplementation((target: unknown) => {
      const file = String(target);
      if (file.endsWith(`/${MANIFEST}`)) return manifestPresent.has(file.slice(0, -(MANIFEST.length + 1)));
      return true;
    });
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

  it('self-restarts a release-pinned job with exactly one kickstart -k and no bootout or bootstrap', async () => {
    const program = await makeRelease(`${SERVICE_HOME}/.local/opt/whatsoup/releases`);
    fsMocks.readFileSync.mockReturnValue(pinnedPlist(program));
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

  it('restarts a release-pinned job from another process by bootout then bootstrap of the same plist', async () => {
    const program = await makeRelease(`${SERVICE_HOME}/.local/opt/whatsoup/releases`);
    fsMocks.readFileSync.mockReturnValue(pinnedPlist(program));
    const { createServiceManager } = await importPlatform();

    await expect(createServiceManager().restart('agent')).resolves.toBeUndefined();

    expect(launchctlSubcommands()).toEqual(['bootout', 'bootstrap']);
    expect(childProcessMocks.execFile.mock.calls[1][1]).toEqual([
      'bootstrap', `gui/${currentUid()}`, `${SERVICE_HOME}/Library/LaunchAgents/com.whatsoup.agent.plist`,
    ]);
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });

  const refusals: Array<[string, () => Promise<string>]> = [
    ['the release has no manifest', () => makeRelease(`${SERVICE_HOME}/.local/opt/whatsoup/releases`, RELEASE_NAME, false)],
    ['the directory is not a WhatSoup-release-<sha> directory', () => makeRelease(`${SERVICE_HOME}/.local/opt`, 'WhatSoup-main')],
    ['the release lies outside home', () => makeRelease(OUTSIDE_ROOT)],
    ['a home path reaches an outside release through a symlink', async () => {
      const realFs = await realFsPromise;
      await makeRelease(OUTSIDE_ROOT);
      realFs.symlinkSync(OUTSIDE_ROOT, `${SERVICE_HOME}/releases`);
      // Report the manifest present through the symlink too, so only the home check can refuse.
      manifestPresent.add(`${SERVICE_HOME}/releases/${RELEASE_NAME}`);
      return `${SERVICE_HOME}/releases/${RELEASE_NAME}/deploy/whatsoup`;
    }],
    ['the program is not deploy/whatsoup', async () => {
      const program = await makeRelease(`${SERVICE_HOME}/.local/opt/whatsoup/releases`);
      return program.replace('/deploy/whatsoup', '/deploy/whatsoup-fleet');
    }],
    ['the path is not canonical', async () => {
      await makeRelease(`${SERVICE_HOME}/.local/opt/whatsoup/releases`);
      const release = `${SERVICE_HOME}/.local/opt/whatsoup/releases/../releases/${RELEASE_NAME}`;
      manifestPresent.add(release);
      return `${release}/deploy/whatsoup`;
    }],
  ];

  for (const [reason, programFor] of refusals) {
    it(`refuses a self-restart when ${reason}`, async () => {
      fsMocks.readFileSync.mockReturnValue(pinnedPlist(await programFor()));
      const { createServiceManager } = await importPlatform();

      await expect(createServiceManager().restartSelf('agent'))
        .rejects.toThrow('does not match the generated WhatSoup instance identity or a release-pinned one');
      expect(childProcessMocks.execFile).not.toHaveBeenCalled();
    });
  }

  it('refuses a pinned plist whose instance argument names another instance', async () => {
    const program = await makeRelease(`${SERVICE_HOME}/.local/opt/whatsoup/releases`);
    fsMocks.readFileSync.mockReturnValue(pinnedPlist(program).replace('<string>agent</string>', '<string>other</string>'));
    const { createServiceManager } = await importPlatform();

    await expect(createServiceManager().restartSelf('agent')).rejects.toThrow('or a release-pinned one');
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('refuses to reconcile a release-pinned plist rather than repoint it, and writes nothing', async () => {
    const program = await makeRelease(`${SERVICE_HOME}/.local/opt/whatsoup/releases`);
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
