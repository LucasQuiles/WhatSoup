/**
 * Coverage supplement for src/bootstrap.ts and src/bootstrap-auth.ts —
 * the `isDirectRun` auto-execute branch (lines 9-15 in each file).
 *
 * Existing tests/bootstrap.test.ts and tests/bootstrap-auth.test.ts cover
 * the exported functions (bootstrap() / bootstrapAuth()) but NOT the
 * module-level direct-run guard:
 *
 *   bootstrap.ts:
 *     stmt 3 (lines 11-14) — `if (isDirectRun)` block body
 *     stmt 4 (line 12)     — bootstrap().catch(...)
 *     stmt 5 (line 13)     — console.error + process.exit(1)
 *     branch 0[0] (line 10) — isDirectRun truthy
 *     branch 1[0] (line 12) — err instanceof Error = true
 *     branch 1[1] (line 12) — err instanceof Error = false (String(err))
 *
 *   bootstrap-auth.ts: identical structure, same stmts/branches
 *
 * Strategy: mock bootstrapCommon dependencies, set process.argv[1] to match
 * the filename so isDirectRun fires on import, then use vi.waitFor() to
 * observe side effects from the async .catch() without wall-clock sleeps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/database-compatibility-early.ts', () => ({
  startupExitCode: vi.fn(() => 1),
  runEarlyDatabaseCompatibilityGate: vi.fn(async () => false),
}));
vi.mock('../src/database-compatibility-config.ts', () => ({
  configureDatabaseCompatibilityBootstrap: vi.fn(),
}));

const savedArgv = process.argv.slice();

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...savedArgv);
  vi.resetModules();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// bootstrap.ts direct-run
// ─────────────────────────────────────────────────────────────────────────────

describe('bootstrap.ts — isDirectRun auto-execute block', () => {
  it('auto-executes bootstrap() successfully when argv[1] ends with bootstrap.ts', async () => {
    vi.resetModules();
    process.argv = ['node', '/path/to/bootstrap.ts', 'loops'];

    vi.doMock('../src/instance-loader.ts', () => ({ loadInstance: vi.fn() }));
    vi.doMock('../src/main.ts', () => ({}));
    vi.doMock('../src/transport/install-third-party-console-redaction.ts', () => ({}));

    // Import should succeed; the guard fires bootstrap() which resolves cleanly
    await expect(import('../src/bootstrap.ts')).resolves.toBeDefined();
  });

  it('calls console.error(err.message) + process.exit(1) when bootstrap() rejects with an Error', async () => {
    vi.resetModules();
    // No argv[2] — bootstrapCommon throws "Usage: whatsoup …"
    process.argv = ['node', '/path/to/bootstrap.ts'];

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.doMock('../src/instance-loader.ts', () => ({ loadInstance: vi.fn() }));
    vi.doMock('../src/main.ts', () => ({}));
    vi.doMock('../src/transport/install-third-party-console-redaction.ts', () => ({}));

    await import('../src/bootstrap.ts');

    // .catch() fires in a microtask after import; waitFor polls until spy called
    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled(), { timeout: 500 });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: whatsoup'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls console.error(String(err)) when bootstrap() rejects with a non-Error value', async () => {
    vi.resetModules();
    process.argv = ['node', '/path/to/bootstrap.ts', 'loops'];

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // loadInstance throws a non-Error to reach the `String(err)` branch
    vi.doMock('../src/instance-loader.ts', () => ({
      loadInstance: vi.fn(() => { throw 'plain string error'; }),
    }));
    vi.doMock('../src/main.ts', () => ({}));
    vi.doMock('../src/transport/install-third-party-console-redaction.ts', () => ({}));

    await import('../src/bootstrap.ts');

    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled(), { timeout: 500 });
    expect(consoleSpy).toHaveBeenCalledWith('plain string error');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does NOT auto-execute bootstrap() when argv[1] does not end with bootstrap.ts', async () => {
    vi.resetModules();
    process.argv = ['node', '/path/to/some-other-script.ts', 'loops'];

    const loadInstance = vi.fn();
    vi.doMock('../src/instance-loader.ts', () => ({ loadInstance }));
    vi.doMock('../src/main.ts', () => ({}));
    vi.doMock('../src/transport/install-third-party-console-redaction.ts', () => ({}));

    await import('../src/bootstrap.ts');

    // No microtask wait needed — if isDirectRun were true, bootstrap() fires
    // synchronously during module eval. Absence of a call proves the branch is false.
    expect(loadInstance).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bootstrap-auth.ts direct-run
// ─────────────────────────────────────────────────────────────────────────────

describe('bootstrap-auth.ts — isDirectRun auto-execute block', () => {
  it('auto-executes bootstrapAuth() successfully when argv[1] ends with bootstrap-auth.ts', async () => {
    vi.resetModules();
    process.argv = ['node', '/path/to/bootstrap-auth.ts', 'personal'];

    vi.doMock('../src/instance-loader.ts', () => ({ loadInstance: vi.fn() }));
    vi.doMock('../src/transport/auth.ts', () => ({}));

    await expect(import('../src/bootstrap-auth.ts')).resolves.toBeDefined();
  });

  it('calls console.error(err.message) + process.exit(1) when bootstrapAuth() rejects with an Error', async () => {
    vi.resetModules();
    process.argv = ['node', '/path/to/bootstrap-auth.ts']; // no argv[2]

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.doMock('../src/instance-loader.ts', () => ({ loadInstance: vi.fn() }));
    vi.doMock('../src/transport/auth.ts', () => ({}));

    await import('../src/bootstrap-auth.ts');

    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled(), { timeout: 500 });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: whatsoup-auth'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls console.error(String(err)) when bootstrapAuth() rejects with a non-Error value', async () => {
    vi.resetModules();
    process.argv = ['node', '/path/to/bootstrap-auth.ts', 'personal'];

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.doMock('../src/instance-loader.ts', () => ({
      loadInstance: vi.fn(() => { throw 99; }),
    }));
    vi.doMock('../src/transport/auth.ts', () => ({}));

    await import('../src/bootstrap-auth.ts');

    await vi.waitFor(() => expect(consoleSpy).toHaveBeenCalled(), { timeout: 500 });
    expect(consoleSpy).toHaveBeenCalledWith('99');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does NOT auto-execute bootstrapAuth() when argv[1] does not end with bootstrap-auth.ts', async () => {
    vi.resetModules();
    process.argv = ['node', '/path/to/bootstrap.ts', 'personal'];

    const loadInstance = vi.fn();
    vi.doMock('../src/instance-loader.ts', () => ({ loadInstance }));
    vi.doMock('../src/transport/auth.ts', () => ({}));

    await import('../src/bootstrap-auth.ts');

    expect(loadInstance).not.toHaveBeenCalled();
  });
});
