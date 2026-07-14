import {
  databaseCompatibilityStartupExitCode,
  inspectExistingDatabaseForBootstrap,
  runEarlyDatabaseCompatibilityGate,
  type DrainableDatabaseCompatibilityReason,
} from './core/database-compatibility-early.ts';
import { configureDatabaseCompatibilityBootstrap } from './database-compatibility-config.ts';
import { errorMessage } from './lib/error-message.ts';

export function checkLoadedInstanceDatabase(): 'ready' | DrainableDatabaseCompatibilityReason {
  const encoded = process.env.INSTANCE_CONFIG;
  if (!encoded) throw new Error('INSTANCE_CONFIG is required for database compatibility inspection');
  const parsed = JSON.parse(encoded) as { paths?: { dbPath?: unknown } };
  if (typeof parsed.paths?.dbPath !== 'string') {
    throw new Error('INSTANCE_CONFIG is missing the canonical database path');
  }
  return inspectExistingDatabaseForBootstrap(parsed.paths.dbPath)?.reason ?? 'ready';
}

export async function databaseCompatibilityBootstrap(argv = process.argv): Promise<void> {
  const instanceName = argv[2];
  const mode = argv[3];
  if (!instanceName || (mode !== '--check' && mode !== '--hold')) {
    throw new Error('Usage: database-compatibility-bootstrap.ts <instance-name> --check|--hold');
  }
  configureDatabaseCompatibilityBootstrap(instanceName);
  if (mode === '--check') {
    process.stdout.write(`${checkLoadedInstanceDatabase()}\n`);
    return;
  }
  if (!await runEarlyDatabaseCompatibilityGate()) {
    throw new Error('database compatibility hold requested for a ready database');
  }
}

const isDirectRun = process.argv[1]?.endsWith('database-compatibility-bootstrap.ts');
if (isDirectRun) {
  databaseCompatibilityBootstrap().catch((err) => {
    process.stderr.write(`${errorMessage(err)}\n`);
    process.exit(databaseCompatibilityStartupExitCode(err));
  });
}
