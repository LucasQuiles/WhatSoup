import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const early = vi.hoisted(() => {
  class DatabaseCompatibilityPermanentStartupError extends Error {
    override readonly cause: unknown;

    constructor(message: string, cause: unknown) {
      super(message, { cause });
      this.name = 'DatabaseCompatibilityPermanentStartupError';
      this.cause = cause;
    }
  }
  return {
    DatabaseCompatibilityPermanentStartupError,
    databaseCompatibilityStartupExitCode: vi.fn((err: unknown) => (
      err instanceof DatabaseCompatibilityPermanentStartupError ? 78 : 1
    )),
    inspectExistingDatabaseForBootstrap: vi.fn(),
    runEarlyDatabaseCompatibilityGate: vi.fn(async () => true),
  };
});
const config = vi.hoisted(() => ({
  configureDatabaseCompatibilityBootstrap: vi.fn(),
}));

vi.mock('../src/core/database-compatibility-early.ts', () => early);
vi.mock('../src/database-compatibility-config.ts', () => config);

import {
  checkLoadedInstanceDatabase,
  databaseCompatibilityBootstrap,
} from '../src/database-compatibility-bootstrap.ts';

describe('database compatibility wrapper bootstrap', () => {
  const previousConfig = process.env.INSTANCE_CONFIG;

  beforeEach(() => {
    early.inspectExistingDatabaseForBootstrap.mockReset();
    early.runEarlyDatabaseCompatibilityGate.mockReset();
    early.runEarlyDatabaseCompatibilityGate.mockResolvedValue(true);
    config.configureDatabaseCompatibilityBootstrap.mockReset();
    config.configureDatabaseCompatibilityBootstrap.mockImplementation(() => {
      process.env.INSTANCE_CONFIG = JSON.stringify({ paths: { dbPath: '/canonical/bot.db' } });
    });
  });

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.INSTANCE_CONFIG;
    else process.env.INSTANCE_CONFIG = previousConfig;
    vi.restoreAllMocks();
  });

  it('reports the dependency-free inspection verdict from the loaded canonical path', () => {
    process.env.INSTANCE_CONFIG = JSON.stringify({ paths: { dbPath: '/canonical/bot.db' } });
    early.inspectExistingDatabaseForBootstrap.mockReturnValue({
      outcome: 'drained',
      error: {
        reason: 'future_schema',
        observedMigration: 45,
        requiredMigration: 44,
      },
    });

    expect(checkLoadedInstanceDatabase()).toBe('future_schema');
    expect(early.inspectExistingDatabaseForBootstrap).toHaveBeenCalledWith('/canonical/bot.db');
  });

  it('enters the hold without provider initialization when requested', async () => {
    await databaseCompatibilityBootstrap([
      'node',
      'database-compatibility-bootstrap.ts',
      'q',
      '--hold',
    ]);

    expect(config.configureDatabaseCompatibilityBootstrap).toHaveBeenCalledWith('q');
    expect(early.runEarlyDatabaseCompatibilityGate).toHaveBeenCalledOnce();
  });

  it.each([
    {
      expected: 'ready',
      inspection: { outcome: 'ready' },
    },
    {
      expected: 'future_schema',
      inspection: {
        outcome: 'drained',
        error: { reason: 'future_schema', observedMigration: 45, requiredMigration: 44 },
      },
    },
    {
      expected: 'engine_recovery_required',
      inspection: {
        outcome: 'drained',
        error: { reason: 'engine_recovery_required', observedMigration: null, requiredMigration: 44 },
      },
    },
  ])('prints only $expected from direct --check mode', async ({ expected, inspection }) => {
    early.inspectExistingDatabaseForBootstrap.mockReturnValue(inspection);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await databaseCompatibilityBootstrap([
      'node',
      'database-compatibility-bootstrap.ts',
      'q',
      '--check',
    ]);

    expect(config.configureDatabaseCompatibilityBootstrap).toHaveBeenCalledWith('q');
    expect(writeSpy).toHaveBeenCalledOnce();
    expect(writeSpy).toHaveBeenCalledWith(`${expected}\n`);
  });

  it('wraps a permanent direct inspection for exit status 78 without printing a verdict', async () => {
    const permanentError = Object.assign(new Error('malformed migration ledger'), {
      reason: 'invalid_schema',
    });
    early.inspectExistingDatabaseForBootstrap.mockReturnValue({
      outcome: 'permanent',
      error: permanentError,
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const failure = await databaseCompatibilityBootstrap([
      'node',
      'database-compatibility-bootstrap.ts',
      'q',
      '--check',
    ]).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(early.DatabaseCompatibilityPermanentStartupError);
    expect(failure).toMatchObject({ cause: permanentError });
    expect(early.databaseCompatibilityStartupExitCode(failure)).toBe(78);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('preserves a transient direct inspection for exit status 1 without printing a verdict', async () => {
    const transientError = new Error('database identity changed during inspection');
    early.inspectExistingDatabaseForBootstrap.mockReturnValue({
      outcome: 'transient',
      error: transientError,
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const failure = await databaseCompatibilityBootstrap([
      'node',
      'database-compatibility-bootstrap.ts',
      'q',
      '--check',
    ]).catch((err: unknown) => err);

    expect(failure).toBe(transientError);
    expect(early.databaseCompatibilityStartupExitCode(failure)).toBe(1);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('fails closed if a hold request races to a ready database', async () => {
    early.runEarlyDatabaseCompatibilityGate.mockResolvedValue(false);

    await expect(databaseCompatibilityBootstrap([
      'node',
      'database-compatibility-bootstrap.ts',
      'q',
      '--hold',
    ])).rejects.toThrow(/hold requested for a ready database/i);
  });
});
