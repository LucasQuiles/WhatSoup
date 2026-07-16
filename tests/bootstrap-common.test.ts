/**
 * Direct unit coverage for src/bootstrap-common.ts.
 *
 * `bootstrapCommon(targetModule, usageCommand, opts?)` is the shared entry-
 * point helper invoked by every bin script (bootstrap.ts, bootstrap-auth.ts).
 * It:
 *   1. Reads `process.argv[2]` for the instance name
 *   2. Throws a `Usage:` error if missing — message uses the supplied
 *      `usageCommand` so callers can show "whatsoup", "whatsoup-auth", etc.
 *   3. For the production bootstrap, prepares and runs the dependency-free
 *      database gate before loading the full instance config
 *   4. Calls `loadInstance(name, opts)` to side-effect env + config
 *   5. Dynamically imports the supplied `targetModule`
 *
 * Existing `tests/bootstrap-auth.test.ts` exercises this indirectly with the
 * auth-target case only. This file pins the parameterized behavior across
 * different `usageCommand` strings and `opts` variants.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const targetModuleImport = vi.hoisted(() => vi.fn());
const databaseGate = vi.hoisted(() => vi.fn(async () => false));
const databaseConfigure = vi.hoisted(() => vi.fn());

// Mock instance-loader before importing bootstrap-common.
vi.mock('../src/instance-loader.ts', () => ({
  loadInstance: vi.fn(),
}));
vi.mock('../src/core/database-compatibility-early.ts', () => ({
  runEarlyDatabaseCompatibilityGate: databaseGate,
}));
vi.mock('../src/database-compatibility-config.ts', () => ({
  configureDatabaseCompatibilityBootstrap: databaseConfigure,
}));

// Provide stub target modules to test the dynamic-import side effect.
// We mock the auth module so the auth bootstrap path won't have side effects.
vi.mock('../src/transport/auth.ts', () => ({}));
vi.mock('../src/transport/auth.ts?bootstrap-common-happy', () => {
  targetModuleImport();
  return {};
});
vi.mock('../src/transport/auth.ts?bootstrap-common-database-ready', () => {
  targetModuleImport();
  return {};
});

import { loadInstance } from '../src/instance-loader.ts';
import { bootstrapCommon } from '../src/bootstrap-common.ts';

const mockLoadInstance = vi.mocked(loadInstance);

describe('bootstrapCommon', () => {
  let savedArgv: string[];

  beforeEach(() => {
    savedArgv = process.argv.slice();
    mockLoadInstance.mockReset();
    targetModuleImport.mockReset();
    databaseConfigure.mockReset();
    databaseGate.mockReset();
    databaseGate.mockResolvedValue(false);
  });

  afterEach(() => {
    process.argv = savedArgv;
  });

  it('throws with the supplied usageCommand in the error message when argv[2] is missing', async () => {
    process.argv = ['node', 'bin.ts'];
    await expect(
      bootstrapCommon('../src/transport/auth.ts', 'whatsoup-custom'),
    ).rejects.toThrow(/Usage: whatsoup-custom <instance-name>/);
  });

  it('error message includes an example invocation using the same usageCommand', async () => {
    process.argv = ['node', 'bin.ts'];
    await expect(
      bootstrapCommon('../src/transport/auth.ts', 'whatsoup-cli'),
    ).rejects.toThrow(/Example: whatsoup-cli loops/);
  });

  it('calls loadInstance with the instance name from argv[2] and undefined opts when not provided', async () => {
    process.argv = ['node', 'bin.ts', 'personal'];
    await bootstrapCommon('../src/transport/auth.ts', 'whatsoup');
    expect(mockLoadInstance).toHaveBeenCalledOnce();
    expect(mockLoadInstance).toHaveBeenCalledWith('personal', undefined);
  });

  it('forwards opts verbatim to loadInstance when provided', async () => {
    process.argv = ['node', 'bin.ts', 'instance-b'];
    await bootstrapCommon('../src/transport/auth.ts', 'whatsoup-auth', { authOnly: true });
    expect(mockLoadInstance).toHaveBeenCalledWith('instance-b', { authOnly: true });
  });

  it('resolves successfully (returns Promise<void>) on the happy path, with side effects observed', async () => {
    process.argv = ['node', 'bin.ts', 'happy'];
    const result = await bootstrapCommon('../src/transport/auth.ts?bootstrap-common-happy', 'whatsoup');
    // Promise<void> means the resolved value is undefined…
    expect(result).toBeUndefined();
    // …and the contract of "successful bootstrap" is that loadInstance ran
    // with the parsed instance name and the target module import ran.
    expect(mockLoadInstance).toHaveBeenCalledOnce();
    expect(mockLoadInstance).toHaveBeenCalledWith('happy', undefined);
    expect(targetModuleImport).toHaveBeenCalledOnce();
  });

  it('does not import the runtime target when the early database gate drains startup', async () => {
    process.argv = ['node', 'bin.ts', 'future-db'];
    databaseGate.mockResolvedValue(true);

    await expect(bootstrapCommon(
      '../src/module-that-must-not-load.ts',
      'whatsoup',
      { databaseCompatibilityGate: true },
    )).resolves.toBeUndefined();

    expect(databaseConfigure).toHaveBeenCalledWith('future-db');
    expect(databaseGate).toHaveBeenCalledOnce();
    expect(mockLoadInstance).not.toHaveBeenCalled();
    expect(targetModuleImport).not.toHaveBeenCalled();
  });

  it('runs the dependency-free database gate before full instance loading and runtime import', async () => {
    process.argv = ['node', 'bin.ts', 'ready-db'];
    await bootstrapCommon(
      '../src/transport/auth.ts?bootstrap-common-database-ready',
      'whatsoup',
      { databaseCompatibilityGate: true },
    );

    expect(databaseConfigure.mock.invocationCallOrder[0]).toBeLessThan(
      databaseGate.mock.invocationCallOrder[0]!,
    );
    expect(databaseGate.mock.invocationCallOrder[0]).toBeLessThan(
      mockLoadInstance.mock.invocationCallOrder[0]!,
    );
    expect(mockLoadInstance.mock.invocationCallOrder[0]).toBeLessThan(
      targetModuleImport.mock.invocationCallOrder[0]!,
    );
  });

  it('uses argv[2] literally as the instance name', async () => {
    // bootstrapCommon reads argv[2] literally — process.argv[0]=node,
    // process.argv[1]=script, process.argv[2]=instanceName.
    process.argv = ['node', 'bin.ts', 'expected-name', 'extra-arg'];
    await bootstrapCommon('../src/transport/auth.ts', 'whatsoup');
    expect(mockLoadInstance).toHaveBeenCalledWith('expected-name', undefined);
  });

  it('the usageCommand and targetModule are independent — different combos work', async () => {
    process.argv = ['node', 'bin.ts', 'two'];
    await bootstrapCommon('../src/transport/auth.ts', 'whatsoup-tier-two', { authOnly: true });
    expect(mockLoadInstance).toHaveBeenCalledWith('two', { authOnly: true });
  });

  it('does not call loadInstance when argv[2] is missing (early throw)', async () => {
    process.argv = ['node', 'bin.ts'];
    await expect(
      bootstrapCommon('../src/transport/auth.ts', 'whatsoup'),
    ).rejects.toThrow();
    expect(mockLoadInstance).not.toHaveBeenCalled();
  });
});
