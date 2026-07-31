import { pathToFileURL } from 'node:url';
import {
  SilenceRegistryResetPreconditionError,
  inspectSilenceRegistryReset,
  resetInvalidSilenceRegistry,
  type SilenceRegistryResetInspection,
} from '../src/fleet/silence-manager.ts';

const REVISION_RE = /^sha256:[a-f0-9]{64}$/;

const EFFECTS = {
  destructive: true,
  idempotent: false,
  open_world: false,
  supports_dry_run: true,
} as const;

interface CliArgs {
  confirmRevision: string | null;
  schema: boolean;
}

function usage(): string {
  return [
    'Usage: npm run fleet-silence-reset -- [--confirm-reset sha256:<revision>] [--format json] [--schema]',
    '',
    'Without --confirm-reset this command is a read-only inspection.',
    'The confirmation value must exactly match the current invalid registry revision.',
  ].join('\n');
}

function parseArgs(argv: string[]): CliArgs {
  let confirmRevision: string | null = null;
  let schema = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--schema') {
      if (schema) throw new Error('duplicate --schema');
      schema = true;
      continue;
    }
    if (flag === '--format') {
      const format = argv[index + 1];
      if (format !== 'json') throw new Error('--format must be json');
      index += 1;
      continue;
    }
    if (flag !== '--confirm-reset') throw new Error(`unknown argument: ${flag}`);
    if (confirmRevision !== null) throw new Error('duplicate --confirm-reset');
    const value = argv[index + 1];
    if (value === undefined || !REVISION_RE.test(value)) {
      throw new Error('--confirm-reset requires a sha256 revision');
    }
    confirmRevision = value;
    index += 1;
  }
  if (schema && confirmRevision !== null) throw new Error('--schema cannot be combined with --confirm-reset');
  return { confirmRevision, schema };
}

function registryRecord(inspection: SilenceRegistryResetInspection): Record<string, unknown> {
  if (inspection.state === 'ready') {
    return {
      state: inspection.state,
      revision: inspection.revision,
      reason_class: inspection.reasonClass,
    };
  }
  return {
    state: inspection.state,
    availability: inspection.availability,
    read_basis: inspection.readBasis,
    ...(inspection.reasonClass ? { reason_class: inspection.reasonClass } : {}),
  };
}

function writeResult(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ schema_version: 1, operation: 'fleet_silence_reset', ...value })}\n`);
}

function writeSchema(): void {
  writeResult({
    outcome: 'schema',
    effects: { read_only: true, ...EFFECTS },
    input_schema: {
      confirm_reset: 'sha256:<64-lowercase-hex>; optional; exact current invalid revision',
      format: ['json'],
    },
    exit_codes: {
      0: 'inspection ready, successful reset, or schema',
      2: 'invalid invocation',
      3: 'reset precondition blocked',
      4: 'mutation did not complete',
    },
  });
}

function blockedResult(inspection: SilenceRegistryResetInspection): number {
  writeResult({
    outcome: 'blocked',
    effects: { read_only: true, ...EFFECTS },
    registry: registryRecord(inspection),
    error: {
      kind: 'reset_precondition_blocked',
      message: 'The silence registry is not eligible for reset.',
      hint: 'Run the command without confirmation after the registry is known to be invalid.',
      retryable: false,
    },
  });
  return 3;
}

export function runFleetSilenceResetCli(argv = process.argv.slice(2)): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch {
    writeResult({
      outcome: 'invalid_invocation',
      effects: { read_only: true, ...EFFECTS },
      error: {
        kind: 'invalid_invocation',
        message: 'Invalid fleet silence reset invocation.',
        hint: usage(),
        retryable: false,
      },
    });
    return 2;
  }

  if (args.schema) {
    writeSchema();
    return 0;
  }

  const inspection = inspectSilenceRegistryReset();
  if (inspection.state !== 'ready') return blockedResult(inspection);

  if (args.confirmRevision === null) {
    writeResult({
      outcome: 'dry_run',
      effects: { read_only: true, ...EFFECTS },
      registry: registryRecord(inspection),
      confirmation_required: inspection.revision,
    });
    return 0;
  }

  try {
    const result = resetInvalidSilenceRegistry(args.confirmRevision);
    writeResult({
      outcome: result.state,
      effects: { read_only: false, ...EFFECTS },
      receipt: {
        repair_id: result.repairId,
        prior_revision: result.priorRevision,
        next_revision: result.nextRevision,
        reason_class: result.reasonClass,
      },
    });
    return 0;
  } catch (err) {
    if (err instanceof SilenceRegistryResetPreconditionError) {
      return blockedResult(inspectSilenceRegistryReset());
    }
    writeResult({
      outcome: 'inconclusive',
      effects: { read_only: false, ...EFFECTS },
      error: {
        kind: 'reset_not_completed',
        message: 'The silence registry reset did not complete.',
        hint: 'Inspect the private quarantine and receipt artifacts before retrying.',
        retryable: false,
      },
    });
    return 4;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runFleetSilenceResetCli(process.argv.slice(2));
}
