import {
  startupExitCode,
  DatabaseCompatibilityPermanentStartupError,
  inspectExistingDatabaseForBootstrap,
  runEarlyDatabaseCompatibilityGate,
  type DrainableDatabaseCompatibilityReason,
} from './core/database-compatibility-early.ts';
import { configureDatabaseCompatibilityBootstrap } from './database-compatibility-config.ts';
import { errorMessage } from './lib/error-message.ts';
import { getBootstrapInstanceContextOrNull } from './lib/instance-context.ts';
import { ConfigValidationError } from './lib/startup-error.ts';

export function checkLoadedInstanceDatabase(): 'ready' | DrainableDatabaseCompatibilityReason {
  // Typed store over the env round-trip (#2206); error wording preserved. Site 3
  // reclassification (qf/exitcode-rescope-stacked, ported from
  // qf/startup-exitcode-classification 11fbbef12): these were bare Error before, which
  // startupExitCode() cannot tell apart from a transient failure — both fell through to
  // exit 1 (systemd restart-flap) instead of 78. The malformed-JSON case is already
  // classified inside getBootstrapInstanceContextOrNull() (instance-context.ts's
  // readEnvFallback throws ConfigValidationError there); these two are the remaining sites.
  const context = getBootstrapInstanceContextOrNull();
  if (!context) throw new ConfigValidationError('INSTANCE_CONFIG is required for database compatibility inspection');
  if (typeof context.paths?.dbPath !== 'string') {
    throw new ConfigValidationError('INSTANCE_CONFIG is missing the canonical database path');
  }
  const inspection = inspectExistingDatabaseForBootstrap(context.paths.dbPath);
  if (inspection.outcome === 'ready') return 'ready';
  if (inspection.outcome === 'drained') return inspection.error.reason;
  if (inspection.outcome === 'permanent') {
    throw new DatabaseCompatibilityPermanentStartupError(
      inspection.error.message,
      inspection.error,
    );
  }
  throw inspection.error;
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
    process.exit(startupExitCode(err));
  });
}
