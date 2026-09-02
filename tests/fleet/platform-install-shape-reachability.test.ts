/**
 * Reachability proof for the render-option SHAPE assertion at the install site.
 *
 * The question the gate's MED-2 ruling needs answered: with home confinement
 * added beside the install call, does `assertValidLaunchdPlistRenderOptions`
 * become reachable again, or does it stay dead?
 *
 * It cannot be answered through the production path, because
 * `installLaunchdPlist` takes only an instance name and
 * `resolveLaunchdPlistRenderOptions` validates shape and throws before the
 * assertion could run. So these tests mock the resolver to hand back a
 * SHAPE-INVALID options object directly, which is the only way anything
 * unvalidated reaches that line. That models exactly one future: a caller, or a
 * changed resolver contract, that supplies options the resolver did not check.
 *
 * The two tests are deliberately contradictory. Exactly one passes per variant,
 * and which one passes IS the answer:
 *   variant A = confinement only, shape assertion removed
 *   variant B = confinement plus the shape assertion restored
 *
 * Home confinement is not what is under test here; the mocked options are
 * home-confined so only the shape rule can refuse them.
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

// The pair is deliberately contradictory: exactly one member passes per
// variant, so one of them ALWAYS fails. That is the measurement, not a defect,
// but it must not sit red in ordinary runs, so the suite is opt-in:
//
//   WHATSOUP_REACHABILITY_PROBE=1 npx vitest run tests/fleet/platform-install-shape-reachability.test.ts
//
// Run it once per variant and record which member passed.
describe.runIf(process.env.WHATSOUP_REACHABILITY_PROBE === '1')(
  'install-site render-option shape assertion — reachability', () => {
  beforeEach(async () => {
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
    // that too, via its lexical gate, so both variants refuse and the probes
    // agree for the wrong reason. (Measured: the first attempt used a relative
    // path and DEAD-PROBE failed under BOTH variants.)
    //
    // A `pathPrepend` entry containing ':' is the discriminator. It is absolute
    // and inside home, so confinement admits it, and it violates the shape rule,
    // which forbids ':' because the rendered PATH is colon-separated.
    renderOptionsMocks.resolveLaunchdPlistRenderOptions.mockReturnValue({
      pathPrepend: [`${SERVICE_HOME}/pin:bin`],
    });
  });

  afterEach(async () => {
    const realFs = await realFsPromise;
    if (SERVICE_HOME) realFs.rmSync(SERVICE_HOME, { recursive: true, force: true });
    setPlatform(originalPlatform);
    vi.restoreAllMocks();
  });

  async function runInstall(): Promise<{ error: Error | null }> {
    vi.resetModules();
    const { createServiceManager } = await import('../../src/fleet/platform.ts');
    const manager = createServiceManager();
    if (!manager.startAfterAuthFire) throw new Error('missing macOS authenticated-start hook');
    return new Promise((resolve) => {
      manager.startAfterAuthFire!('agent', (err) => resolve({ error: (err as Error) ?? null }));
    });
  }

  it('REACHABLE-PROBE: unvalidated shape-invalid options are refused at the install site', async () => {
    // Passes under B. Fails under A, where nothing at the install site checks shape.
    const { error } = await runInstall();
    expect(error, 'install should have refused the unvalidated invalid shape').not.toBeNull();
    expect(String(error?.message)).toContain('service.pathPrepend');
  });

  it('DEAD-PROBE: unvalidated shape-invalid options pass the install site unchallenged', async () => {
    // Passes under A. Fails under B, where the shape assertion catches them.
    //
    // "No error" alone would be a weak terminal assertion: it also holds if the
    // install never ran at all. So this asserts the install actually PROCEEDED
    // past the assertion site and rendered the invalid entry into the plist,
    // which is what "unchallenged" has to mean for the probe to say anything.
    const { error } = await runInstall();
    expect(error, 'install should NOT have refused on shape').toBeNull();
    expect(fsMocks.writeFileSync, 'the plist must actually have been written').toHaveBeenCalled();
    const written = String(fsMocks.writeFileSync.mock.calls[0]?.[1]);
    expect(written, 'the shape-invalid entry must have reached the rendered PATH')
      .toContain(`${SERVICE_HOME}/pin:bin`);
  });
});
