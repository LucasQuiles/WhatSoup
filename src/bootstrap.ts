import './transport/install-third-party-console-redaction.ts';
import { bootstrapCommon } from './bootstrap-common.ts';
import { startupExitCode } from './core/database-compatibility-early.ts';
import { printErr } from './lib/cli-print.ts';
import { errorMessage } from './lib/error-message.ts';

export async function bootstrap(): Promise<void> {
  await bootstrapCommon('./main.ts', 'whatsoup', { databaseCompatibilityGate: true });
}

// Auto-execute when run directly
const isDirectRun = process.argv[1]?.endsWith('bootstrap.ts');
if (isDirectRun) {
  bootstrap().catch((err) => {
    printErr(errorMessage(err));
    process.exit(startupExitCode(err));
  });
}
