import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const early = vi.hoisted(() => ({
  databaseCompatibilityStartupExitCode: vi.fn(() => 1),
  inspectExistingDatabaseForBootstrap: vi.fn(),
  runEarlyDatabaseCompatibilityGate: vi.fn(async () => true),
}));
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
      reason: 'future_schema',
      observedMigration: 45,
      requiredMigration: 44,
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

  it('performs check mode from the minimal bootstrap config without full instance loading', async () => {
    early.inspectExistingDatabaseForBootstrap.mockReturnValue(null);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await databaseCompatibilityBootstrap([
      'node',
      'database-compatibility-bootstrap.ts',
      'q',
      '--check',
    ]);

    expect(config.configureDatabaseCompatibilityBootstrap).toHaveBeenCalledWith('q');
    expect(writeSpy).toHaveBeenCalledWith('ready\n');
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
