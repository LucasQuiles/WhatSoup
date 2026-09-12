/**
 * Regression guard for the render-option SHAPE assertion at the install site.
 *
 * The assertion cannot be reached through the production path, because
 * `installLaunchdPlist` takes only an instance name and
 * `resolveLaunchdPlistRenderOptions` validates shape and throws before the
 * assertion could run. So this test mocks the resolver to hand back a
 * SHAPE-INVALID options object directly, which is the only way anything
 * unvalidated reaches that line. That models exactly one future: a caller, or a
 * changed resolver contract, that supplies options the resolver did not check.
 *
 * Home confinement is not what is under test here. The mocked entry is absolute
 * and inside home, so confinement admits it and only the shape rule can refuse
 * it; the test asserts the shape reason for that reason.
 *
 * An earlier version of this file also carried a deliberately contradictory
 * pair of probes behind `describe.runIf`, which measured whether the assertion
 * was reachable at all. Exactly one member passed per variant, so the file was
 * skipped by default and guaranteed red when enabled. The measurement is done
 * and its result is recorded in the change record; a suite is the wrong place
 * to keep an experiment that cannot be green. Deleting it also removes the only
 * `fitness/categorized-skips` warning this work introduced.
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
const osMocks = vi.hoisted(() => ({ homedir: vi.fn() }));
const renderOptionsMocks = vi.hoisted(() => ({ resolveLaunchdPlistRenderOptions: vi.fn() }));

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
// The load-bearing mock: bypasses the resolver's own validation.
vi.mock('../../src/fleet/launchd-render-options.ts', () => renderOptionsMocks);

const originalPlatform = process.platform;
let SERVICE_HOME: string;
const realFsPromise = vi.importActual<typeof import('node:fs')>('node:fs');
const realPathPromise = vi.importActual<typeof import('node:path')>('node:path');
const realOsPromise = vi.importActual<typeof import('node:os')>('node:os');

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

async function installFixtureSetUp(): Promise<void> {
  const [realFs, realPath, realOs] = await Promise.all([
    realFsPromise, realPathPromise, realOsPromise,
  ]);
  SERVICE_HOME = realFs.realpathSync.native(
    realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'whatsoup-reach-')),
  );
  vi.clearAllMocks();
  setPlatform('darwin');
  osMocks.homedir.mockReturnValue(SERVICE_HOME);
  fsMocks.existsSync.mockReturnValue(false);
  fsMocks.readFileSync.mockImplementation(() => {
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
  childProcessMocks.execFile.mockImplementation((_c, _a, optionsOrCb, maybeCb) => {
    const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
    queueMicrotask(() => cb?.(null, '', ''));
    return new EventEmitter();
  });
  // The input has to be shape-INVALID but confinement-VALID, or the two rules
  // cannot be told apart. A relative path does not work: confinement refuses
  // that too, via its spelling gate, so both rules refuse and the test would
  // pass for the wrong reason. (Measured: a first attempt used a relative path
  // and could not distinguish the two rules at all.)
  //
  // A `pathPrepend` entry containing ':' is the discriminator. It is absolute
  // and inside home, so confinement admits it, and it violates the shape rule,
  // which forbids ':' because the rendered PATH is colon-separated.
  renderOptionsMocks.resolveLaunchdPlistRenderOptions.mockReturnValue({
    pathPrepend: [`${SERVICE_HOME}/pin:bin`],
  });
}

async function installFixtureTearDown(): Promise<void> {
  const realFs = await realFsPromise;
  if (SERVICE_HOME) realFs.rmSync(SERVICE_HOME, { recursive: true, force: true });
  setPlatform(originalPlatform);
  vi.restoreAllMocks();
}

async function runInstall(): Promise<{ error: Error | null }> {
  vi.resetModules();
  const { createServiceManager } = await import('../../src/fleet/platform.ts');
  const manager = createServiceManager();
  if (!manager.startAfterAuthFire) throw new Error('missing macOS authenticated-start hook');
  return new Promise((resolve) => {
    manager.startAfterAuthFire!('agent', (err) => resolve({ error: (err as Error) ?? null }));
  });
}

// Always-on, and the only suite in this file: it runs in every ordinary suite
// run and goes red the moment the install-site shape assertion is deleted.
describe('install-site render-option shape assertion — regression guard', () => {
  beforeEach(installFixtureSetUp);
  afterEach(installFixtureTearDown);

  it('refuses unvalidated shape-invalid render options before rendering the plist', async () => {
    const { error } = await runInstall();
    expect(error, 'the install site must refuse options the resolver did not validate').not.toBeNull();
    // Asserted on the SHAPE reason specifically. Confinement admits this entry
    // (absolute, inside home), so a refusal carrying the confinement reason
    // would mean a different rule fired and this guard would be measuring
    // something other than what it names.
    expect(String(error?.message)).toContain('service.pathPrepend[0] must be an absolute directory path');
    expect(String(error?.message)).toContain("without ':' or control characters");
    expect(fsMocks.writeFileSync, 'a refused install must render no plist bytes').not.toHaveBeenCalled();
    expect(fsMocks.mkdirSync, 'a refused install must create no LaunchAgents directory').not.toHaveBeenCalled();
  });
});
