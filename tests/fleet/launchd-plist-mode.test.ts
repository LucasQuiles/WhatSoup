/**
 * Mode of the macOS instance plist across the platform writers (reconcile, its
 * rollback, and the first install after authentication), against a real
 * temporary HOME. Only launchctl (child_process) and the home directory are
 * replaced; every file is real, so the modes asserted are the kernel's.
 *
 * An instance plist can carry credentials in its EnvironmentVariables and is
 * then installed owner-only. Replacing it must never widen it: the new file
 * keeps the installed file's permission bits, capped at 0644 because launchd
 * refuses group- or world-writable job definitions. A plist with no installed
 * predecessor keeps the writer's default. All identifiers are fabricated.
 *
 * Modes are set explicitly with chmod, so the owner-only cases do not depend on
 * the runner's umask. The pair "0600 stays 0600" and "0644 stays 0644" also
 * pins the fix under any umask: a writer that ignores the installed mode fails
 * one of the two.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

const osMocks = vi.hoisted(() => ({
  homedir: vi.fn(),
}));

vi.mock('node:child_process', () => childProcessMocks);
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: osMocks.homedir,
}));

type PlatformModule = typeof import('../../src/fleet/platform.ts');

const INSTANCE = 'mode-line';
const LABEL = `com.whatsoup.${INSTANCE}`;
const originalPlatform = process.platform;

let home: string;
let launchAgents: string;
let dest: string;
/** Bootstrap calls still to fail (non-transient) before launchctl succeeds again. */
let bootstrapFailures: number;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

async function importPlatform(): Promise<PlatformModule> {
  vi.resetModules();
  return import('../../src/fleet/platform.ts');
}

function modeOf(target: string): number {
  return fs.lstatSync(target).mode & 0o777;
}

/**
 * The installed plist: the generator's own render with one non-governed field
 * changed, so every write below is observable as a content change while the
 * governed environment still matches and no apply is refused.
 */
function installedFrom(rendered: string): string {
  const installed = rendered.replace('<integer>60</integer>', '<integer>30</integer>');
  expect(installed).not.toBe(rendered);
  return installed;
}

function install(contents: string, mode: number, at: string = dest): void {
  fs.writeFileSync(at, contents, { mode });
  fs.chmodSync(at, mode);
}

/** The mode a fresh file created with 0644 gets in this directory under this process's umask. */
function defaultNewFileMode(): number {
  const probe = path.join(launchAgents, '.mode-probe');
  fs.writeFileSync(probe, '', { mode: 0o644 });
  try {
    return modeOf(probe);
  } finally {
    fs.unlinkSync(probe);
  }
}

beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-plist-mode-')));
  launchAgents = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(launchAgents, { recursive: true });
  dest = path.join(launchAgents, `${LABEL}.plist`);
  bootstrapFailures = 0;

  osMocks.homedir.mockReset();
  osMocks.homedir.mockReturnValue(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
  vi.stubEnv('XDG_DATA_HOME', path.join(home, '.local', 'share'));
  vi.stubEnv('XDG_STATE_HOME', path.join(home, '.local', 'state'));

  childProcessMocks.execFile.mockReset();
  childProcessMocks.execFile.mockImplementation((_cmd, args, optionsOrCallback, maybeCallback) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    let error: Error | null = null;
    if ((args as string[])[0] === 'bootstrap' && bootstrapFailures > 0) {
      bootstrapFailures -= 1;
      error = Object.assign(new Error('Bootstrap failed: 37: Operation already in progress'), { code: 37 });
    }
    queueMicrotask(() => callback?.(error, '', ''));
    return new EventEmitter();
  });
  setPlatform('darwin');
});

afterEach(() => {
  setPlatform(originalPlatform);
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('launchd instance plist mode: reconcile', () => {
  it.each([
    ['0600', 0o600],
    ['0640', 0o640],
    ['0644', 0o644],
  ])('keeps a plist installed at %s at that mode when an apply rewrites it', async (_octal, installedMode) => {
    const { buildPlist, reconcileLaunchdPlist } = await importPlatform();
    const rendered = buildPlist(INSTANCE);
    install(installedFrom(rendered), installedMode);

    await reconcileLaunchdPlist(INSTANCE);

    expect(fs.readFileSync(dest, 'utf-8')).toBe(rendered);
    expect(modeOf(dest)).toBe(installedMode);
  });

  it('never installs a plist wider than 0644, even over a group-writable one', async () => {
    const { buildPlist, reconcileLaunchdPlist } = await importPlatform();
    const rendered = buildPlist(INSTANCE);
    install(installedFrom(rendered), 0o664);

    await reconcileLaunchdPlist(INSTANCE);

    expect(fs.readFileSync(dest, 'utf-8')).toBe(rendered);
    expect(modeOf(dest)).toBe(0o644);
  });

  it('keeps an owner-only plist owner-only when a failed reload restores the previous bytes', async () => {
    const { buildPlist, reconcileLaunchdPlist } = await importPlatform();
    const installed = installedFrom(buildPlist(INSTANCE));
    install(installed, 0o600);
    bootstrapFailures = 1;

    await expect(reconcileLaunchdPlist(INSTANCE)).rejects.toThrow('Operation already in progress');

    expect(fs.readFileSync(dest, 'utf-8')).toBe(installed);
    expect(modeOf(dest)).toBe(0o600);
  });

  it('writes nothing on a dry run', async () => {
    const { buildPlist, reconcileLaunchdPlist } = await importPlatform();
    const installed = installedFrom(buildPlist(INSTANCE));
    install(installed, 0o600);
    const inodeBefore = fs.lstatSync(dest).ino;

    await reconcileLaunchdPlist(INSTANCE, { dryRun: true });

    expect(fs.lstatSync(dest).ino).toBe(inodeBefore);
    expect(fs.readFileSync(dest, 'utf-8')).toBe(installed);
    expect(modeOf(dest)).toBe(0o600);
  });

  it('replaces a symlinked plist with a regular file at the mode of the file it pointed to, leaving that file untouched', async () => {
    const { buildPlist, reconcileLaunchdPlist } = await importPlatform();
    const rendered = buildPlist(INSTANCE);
    const installed = installedFrom(rendered);
    const target = path.join(home, 'elsewhere', `${LABEL}.plist`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    install(installed, 0o600, target);
    fs.symlinkSync(target, dest);

    await reconcileLaunchdPlist(INSTANCE);

    // The same-directory rename replaces the link itself, as it always has.
    expect(fs.lstatSync(dest).isFile()).toBe(true);
    expect(fs.readFileSync(dest, 'utf-8')).toBe(rendered);
    expect(modeOf(dest)).toBe(0o600);
    expect(fs.readFileSync(target, 'utf-8')).toBe(installed);
    expect(modeOf(target)).toBe(0o600);
  });
});

describe('launchd instance plist mode: first install after authentication', () => {
  it('installs a new plist at the writer default when none is installed', async () => {
    const { createServiceManager } = await importPlatform();
    const manager = createServiceManager();
    const expected = defaultNewFileMode();

    await new Promise<void>((resolve, reject) => {
      manager.startAfterAuthFire!(INSTANCE, (err) => (err ? reject(err) : resolve()));
    });

    expect(fs.readFileSync(dest, 'utf-8')).toContain(`<string>${LABEL}</string>`);
    expect(modeOf(dest)).toBe(expected);
  });
});
