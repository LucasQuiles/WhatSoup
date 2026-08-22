import { spawnSync } from 'node:child_process';

export interface ReleaseAlertEmitOptions {
  repoRoot: string;
  instance: string;
  source: string;
  emitHelper: string;
  python: string;
  /** Pre-generated event id; when omitted the helper mints a uuid4 itself. */
  eventId?: string;
}
export interface ReleaseAlertEmitPayload {
  summary: string;
  evidence: string;
  diagnostics: string[];
  severity: 'warning' | 'critical';
}

export interface ReleaseAlertEmitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The event id passed to (or minted by) the helper; null when no attempt was made. */
  eventId: string | null;
}

const EMIT_ENV_KEYS = [
  'BOT_ERRORS_ALLOW_TEST_LIVE_OUTBOX',
  'BOT_ERRORS_DRY_PLATFORM_RELEASE',
  'BOT_ERRORS_DRY_PLATFORM_SYSTEM',
  'BOT_ERRORS_DRY_SYS_PLATFORM',
  'BOT_ERRORS_LIVE_OUTBOX_DIR',
  'BOT_ERRORS_OUTBOX_DIR',
  'BOT_ERRORS_STATE_DIR',
  'BOT_ERRORS_WRITEFAIL_DIR',
  'HOME',
  'INVOCATION_ID',
  'JEST_WORKER_ID',
  'LOG_DIR',
  'NODE_ENV',
  'PATH',
  'PYTEST_CURRENT_TEST',
  'SYSTEMD_EXEC_PID',
  'SYSTEMD_UNIT',
  'TMPDIR',
  'VITEST',
  'VITEST_WORKER_ID',
  'WSL_DISTRO_NAME',
] as const;

function emitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of EMIT_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function emitReleaseAlert(
  options: ReleaseAlertEmitOptions,
  payload: ReleaseAlertEmitPayload,
  eventType: 'alert' | 'clear',
): ReleaseAlertEmitResult {
  const args = [
    options.emitHelper,
    '--instance', options.instance,
    '--source', options.source,
    '--summary', payload.summary,
    '--evidence', payload.evidence,
  ];
  for (const diagnostic of payload.diagnostics) args.push('--diagnostic', diagnostic);
  if (options.eventId) args.push('--event-id', options.eventId);
  if (eventType === 'clear') args.push('--clear');
  else args.push('--severity', payload.severity);

  const proc = spawnSync(options.python, args, {
    cwd: options.repoRoot,
    encoding: 'utf8',
    env: emitEnvironment(),
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
  });
  return {
    status: proc.status ?? (proc.error ? 1 : null),
    stdout: proc.stdout ?? '',
    stderr: proc.stderr || proc.error?.message || '',
    eventId: options.eventId ?? null,
  };
}
