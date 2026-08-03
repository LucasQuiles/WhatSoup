/**
 * qpi/exit-codes restart-flap fix: startup config-validation errors must exit
 * EX_CONFIG(78), not 1.
 *
 * `deploy/whatsoup@.service` sets `Restart=on-failure` + `RestartPreventExitStatus=78`.
 * A PERMANENT config fault that exits 1 restart-flaps forever (systemd only spares
 * exit 78). These tests prove:
 *   1. the `startupExitCode` classifier maps a `ConfigValidationError` → 78, keeps the
 *      database-compatibility permanent error → 78 (regression), and — fail-closed —
 *      leaves every other error at 1 (transient → restart);
 *   2. both node-side producer paths (`config.ts` validation, the early INSTANCE_CONFIG
 *      gate) throw a `ConfigValidationError` rather than a bare `Error`;
 *   3. end-to-end, the bootstrap direct-run entry exits 78 when the main import rejects
 *      with a `ConfigValidationError`, using the REAL classifier.
 *
 * Scope note: the bash launcher (`deploy/whatsoup`) has its own permanent-config
 * `exit 1` paths (missing API key, preflight) that a node-side fix cannot reach —
 * those are a tracked follow-up, deliberately NOT covered here.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startupExitCode,
  DatabaseCompatibilityPermanentStartupError,
} from '../src/core/database-compatibility-early.ts';
import { ConfigValidationError, isConfigValidationError } from '../src/lib/startup-error.ts';
import { EX_CONFIG } from '../src/lib/exit-codes.ts';

describe('startupExitCode classifier (qpi/exit-codes)', () => {
  it('maps a config-validation error to EX_CONFIG(78) so systemd stops restart-flapping', () => {
    expect(EX_CONFIG).toBe(78);
    expect(startupExitCode(new ConfigValidationError('bad config'))).toBe(78);
  });

  it('keeps the database-compatibility permanent error at 78 (regression — unchanged)', () => {
    expect(startupExitCode(new DatabaseCompatibilityPermanentStartupError('x', null))).toBe(78);
  });

  it('leaves any other error at exit 1 (transient → restart; fail-closed)', () => {
    expect(startupExitCode(new Error('disk full'))).toBe(1);
    expect(startupExitCode(new TypeError('a real bug'))).toBe(1);
    expect(startupExitCode('not even an Error')).toBe(1);
    expect(startupExitCode(undefined)).toBe(1);
  });

  it('isConfigValidationError narrows only ConfigValidationError', () => {
    expect(isConfigValidationError(new ConfigValidationError('x'))).toBe(true);
    expect(isConfigValidationError(new Error('x'))).toBe(false);
  });
});

describe('config.ts producer path — validation throws ConfigValidationError (qpi/exit-codes)', () => {
  const saved = process.env.INSTANCE_CONFIG;
  afterEach(() => {
    if (saved === undefined) delete process.env.INSTANCE_CONFIG;
    else process.env.INSTANCE_CONFIG = saved;
    vi.resetModules();
  });

  it('throws ConfigValidationError (not a bare Error) on malformed INSTANCE_CONFIG JSON', async () => {
    vi.resetModules();
    process.env.INSTANCE_CONFIG = '{ this is : not valid json';
    // Import the error class from the SAME (post-reset) module graph config.ts resolves,
    // so instanceof compares identical class identities. resetModules is required (config.ts
    // reads INSTANCE_CONFIG at import time) but would otherwise give config.ts a fresh copy
    // of startup-error.ts and break instanceof against a top-level import.
    const { ConfigValidationError: CVE } = await import('../src/lib/startup-error.ts');
    await expect(import('../src/config.ts')).rejects.toBeInstanceOf(CVE);
  });
});

describe('early INSTANCE_CONFIG gate producer path (qpi/exit-codes)', () => {
  const saved = process.env.INSTANCE_CONFIG;
  afterEach(() => {
    if (saved === undefined) delete process.env.INSTANCE_CONFIG;
    else process.env.INSTANCE_CONFIG = saved;
    vi.resetModules();
  });

  // Load the gate and the error class from ONE fresh module graph so the class the gate
  // throws is identity-equal to the one asserted against (resetModules-safe instanceof).
  async function loadGate(): Promise<{
    CVE: typeof import('../src/lib/startup-error.ts').ConfigValidationError;
    runEarlyDatabaseCompatibilityGate: typeof import('../src/core/database-compatibility-early.ts').runEarlyDatabaseCompatibilityGate;
  }> {
    const { ConfigValidationError: CVE } = await import('../src/lib/startup-error.ts');
    const { runEarlyDatabaseCompatibilityGate } = await import(
      '../src/core/database-compatibility-early.ts'
    );
    return { CVE, runEarlyDatabaseCompatibilityGate };
  }

  it('throws ConfigValidationError when INSTANCE_CONFIG is absent', async () => {
    vi.resetModules();
    delete process.env.INSTANCE_CONFIG;
    const { CVE, runEarlyDatabaseCompatibilityGate } = await loadGate();
    await expect(runEarlyDatabaseCompatibilityGate()).rejects.toBeInstanceOf(CVE);
  });

  it('throws ConfigValidationError on malformed INSTANCE_CONFIG JSON', async () => {
    vi.resetModules();
    process.env.INSTANCE_CONFIG = '{bad';
    const { CVE, runEarlyDatabaseCompatibilityGate } = await loadGate();
    await expect(runEarlyDatabaseCompatibilityGate()).rejects.toBeInstanceOf(CVE);
  });

  it('throws ConfigValidationError when canonical gate fields are missing', async () => {
    vi.resetModules();
    process.env.INSTANCE_CONFIG = JSON.stringify({ name: 'only-a-name' });
    const { CVE, runEarlyDatabaseCompatibilityGate } = await loadGate();
    await expect(runEarlyDatabaseCompatibilityGate()).rejects.toBeInstanceOf(CVE);
  });
});

describe('database-compatibility-bootstrap producer path — Site 3 throws ConfigValidationError (qf/exitcode-rescope-stacked)', () => {
  // checkLoadedInstanceDatabase() (src/database-compatibility-bootstrap.ts) has three throw
  // sites that predate the #2206 typed-store refactor and were never reclassified: a bare
  // `Error` when INSTANCE_CONFIG is absent, and a bare `Error` when the canonical dbPath is
  // missing. startupExitCode() cannot distinguish a bare Error from a transient failure, so
  // both cases misclassify a permanent config fault to exit 1 (systemd restart-flap) instead
  // of 78 (RestartPreventExitStatus, stops the flap) — the same class of bug qpi/exit-codes
  // fixed for Sites 1/2, now closed here for Site 3. Ported from
  // qf/startup-exitcode-classification (11fbbef12), rebased onto the #2206 typed
  // instance-context store (830fd3a95): the malformed-JSON case moved into
  // src/lib/instance-context.ts's readEnvFallback() when the store landed and was already
  // classified there — kept below as a regression guard, not a fix under test here.
  const saved = process.env.INSTANCE_CONFIG;
  afterEach(() => {
    if (saved === undefined) delete process.env.INSTANCE_CONFIG;
    else process.env.INSTANCE_CONFIG = saved;
    vi.resetModules();
  });

  // Load the error class, the classifier, and the function under test from ONE fresh
  // module graph so the class Site 3 throws is identity-equal to the one asserted against
  // (resetModules-safe instanceof), matching the loadGate() precedent above.
  async function loadSite3(): Promise<{
    CVE: typeof import('../src/lib/startup-error.ts').ConfigValidationError;
    startupExitCode: typeof import('../src/core/database-compatibility-early.ts').startupExitCode;
    checkLoadedInstanceDatabase: typeof import('../src/database-compatibility-bootstrap.ts').checkLoadedInstanceDatabase;
  }> {
    const { ConfigValidationError: CVE } = await import('../src/lib/startup-error.ts');
    const { startupExitCode } = await import('../src/core/database-compatibility-early.ts');
    const { checkLoadedInstanceDatabase } = await import('../src/database-compatibility-bootstrap.ts');
    return { CVE, startupExitCode, checkLoadedInstanceDatabase };
  }

  it('classifies an absent INSTANCE_CONFIG to exit 78, not 1', async () => {
    vi.resetModules();
    delete process.env.INSTANCE_CONFIG;
    const { CVE, startupExitCode, checkLoadedInstanceDatabase } = await loadSite3();
    let caught: unknown;
    try {
      checkLoadedInstanceDatabase();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CVE);
    expect(startupExitCode(caught)).toBe(78);
  });

  it('classifies malformed INSTANCE_CONFIG JSON to exit 78, not 1 (regression guard — the store already classifies this)', async () => {
    vi.resetModules();
    process.env.INSTANCE_CONFIG = '{bad';
    const { CVE, startupExitCode, checkLoadedInstanceDatabase } = await loadSite3();
    let caught: unknown;
    try {
      checkLoadedInstanceDatabase();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CVE);
    expect(startupExitCode(caught)).toBe(78);
  });

  it('classifies a missing canonical database path to exit 78, not 1', async () => {
    vi.resetModules();
    process.env.INSTANCE_CONFIG = JSON.stringify({ paths: {} });
    const { CVE, startupExitCode, checkLoadedInstanceDatabase } = await loadSite3();
    let caught: unknown;
    try {
      checkLoadedInstanceDatabase();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CVE);
    expect(startupExitCode(caught)).toBe(78);
  });
});

describe('real-process exit code: a ConfigValidationError maps to OS exit 78 (qpi/exit-codes)', () => {
  // The load-bearing systemd claim is that the *real process* exits exactly 78 (which
  // deploy/whatsoup@.service lists in RestartPreventExitStatus). bootstrap.ts:15 is a
  // literal `process.exit(startupExitCode(err))`, so a real subprocess that classifies a
  // ConfigValidationError through the SAME real modules proves the OS-level exit code
  // end-to-end — no vitest module mocking (which would fork startup-error's identity and
  // break instanceof). RED before the fix: startupExitCode(ConfigValidationError) was 1.
  it('spawns node and exits 78 when startupExitCode classifies a ConfigValidationError', () => {
    const script = [
      "const { ConfigValidationError } = await import('./src/lib/startup-error.ts');",
      "const { startupExitCode } = await import('./src/core/database-compatibility-early.ts');",
      "process.exit(startupExitCode(new ConfigValidationError('malformed instance config')));",
    ].join('\n');

    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(78);
  });

  it('spawns node and exits 1 for a generic Error (transient → restart; fail-closed)', () => {
    const script = [
      "const { startupExitCode } = await import('./src/core/database-compatibility-early.ts');",
      "process.exit(startupExitCode(new Error('transient disk full')));",
    ].join('\n');

    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
  });
});

describe('loadInstance producer path — the PRIMARY config gate throws ConfigValidationError (F1)', () => {
  // loadInstance (bootstrap-common.ts:22) runs BEFORE `await import('./main.ts')`, so it is
  // the FIRST config-validation gate on the systemd path. A malformed config.json or a
  // schema-invalid instance must throw ConfigValidationError here (→ exit 78), or the most
  // common permanent config fault still exits 1 and restart-flaps.
  const saved = process.env.XDG_CONFIG_HOME;
  let root: string | null = null;
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
    vi.resetModules();
  });

  it('throws ConfigValidationError (not a bare Error) on a malformed instance config.json', async () => {
    vi.resetModules();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ws-loadinst-')));
    const instance = 'badinst';
    const dir = join(root, '.config', 'whatsoup', 'instances', instance);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{ this is : not valid json', 'utf8');
    process.env.XDG_CONFIG_HOME = join(root, '.config');
    // Same graph so ConfigValidationError identity matches (resetModules-safe instanceof).
    const { ConfigValidationError: CVE } = await import('../src/lib/startup-error.ts');
    const { loadInstance } = await import('../src/instance-loader.ts');
    expect(() => loadInstance(instance)).toThrow(CVE);
  });
});

describe('end-to-end: real bootstrap.ts exits 78 on a malformed instance config (F1, full chain)', () => {
  // The load-bearing systemd claim: a malformed instance config.json makes the REAL process
  // exit exactly 78 (RestartPreventExitStatus=78) through the whole chain
  // bootstrap.ts → bootstrapCommon → loadInstance (ConfigValidationError) → bootstrap().catch
  // → startupExitCode. Uses a CANONICAL (realpath'd) fleet-config root so the earlier
  // database-compatibility gate passes and loadInstance's throw is the actual cause.
  // RED before the F1 fix: loadInstance threw a bare Error → exit 1.
  it('spawns bootstrap.ts against a malformed config.json and exits 78', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ws-bootstrap-')));
    try {
      const instance = 'testinst';
      const dir = join(root, '.config', 'whatsoup', 'instances', instance);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.json'), '{ this is : not valid json', 'utf8');

      const result = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--disable-warning=ExperimentalWarning',
          join(process.cwd(), 'src/bootstrap.ts'),
          instance,
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: join(root, '.config'),
            XDG_DATA_HOME: join(root, '.data'),
            XDG_STATE_HOME: join(root, '.state'),
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.stdout + result.stderr).toContain('Failed to parse config.json');
      expect(result.status).toBe(78);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
