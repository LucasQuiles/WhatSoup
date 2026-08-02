import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { assertNoSecretLike } from './artifact-redaction.ts';
import { requireBoolean, requireEnum, requireRecord, requireString } from '../src/lib/type-guards.ts';

const ARTIFACT_TYPE = 'disposable-client-canary';
const ALLOWED_CLIENT_FAMILIES = new Set(['whatsapp-web-js', 'other']);
const SCAN_VALUES = new Set(['pass', 'fail'] as const);
const ALLOWED_KEYS = new Set([
  'artifact_type',
  'run_id',
  'client_family',
  'account_class',
  'send_disabled',
  'auth_started',
  'auth_completed',
  'ready_seen',
  'linked_duration_seconds',
  'chat_list_readable',
  'logout_seen',
  'ghost_connection_suspected',
  'raw_identifier_scan',
  'message_content_scan',
  'kill_reason',
]);
const FORBIDDEN_MESSAGE_CONTENT_KEY_RE = /(?:^|[_-])(message|body|content|text)(?:$|[_-])/i;

export interface DisposableClientCanaryArtifact {
  artifact_type: 'disposable-client-canary';
  run_id: string;
  client_family: 'whatsapp-web-js' | 'other';
  account_class: 'disposable';
  send_disabled: true;
  auth_started: boolean;
  auth_completed: boolean;
  ready_seen: boolean;
  linked_duration_seconds: number;
  chat_list_readable: boolean;
  logout_seen: boolean;
  ghost_connection_suspected: boolean;
  raw_identifier_scan: 'pass' | 'fail';
  message_content_scan: 'pass' | 'fail';
  kill_reason: string | null;
}

interface ParsedArgs {
  artifact: string;
  help: boolean;
}

// Enforces non-negative in addition to finite — SSOT requireNumber only
// checks finiteness. A negative linked_duration_seconds is not a valid
// duration, so this stays local rather than widening to the SSOT check.
function requireNonNegativeNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return value;
}

function assertAllowedKeys(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_MESSAGE_CONTENT_KEY_RE.test(key) && !ALLOWED_KEYS.has(key)) {
      throw new Error(`message content field is forbidden: ${key}`);
    }
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`unexpected artifact field: ${key}`);
    }
  }
}

export function validateDisposableClientCanaryArtifact(
  value: unknown,
): DisposableClientCanaryArtifact {
  const record = requireRecord(value, 'artifact');
  assertNoSecretLike(JSON.stringify(record), 'disposable client canary artifact');
  assertAllowedKeys(record);

  if (record.artifact_type !== ARTIFACT_TYPE) {
    throw new Error(`artifact_type must be ${ARTIFACT_TYPE}`);
  }

  const runId = requireString(record.run_id, 'run_id');
  const clientFamily = requireString(record.client_family, 'client_family');
  if (!ALLOWED_CLIENT_FAMILIES.has(clientFamily)) {
    throw new Error('client_family must be whatsapp-web-js or other');
  }
  if (record.account_class !== 'disposable') {
    throw new Error('account_class must be disposable');
  }
  if (record.send_disabled !== true) {
    throw new Error('send_disabled must be true');
  }

  const authStarted = requireBoolean(record.auth_started, 'auth_started');
  const authCompleted = requireBoolean(record.auth_completed, 'auth_completed');
  const readySeen = requireBoolean(record.ready_seen, 'ready_seen');
  const linkedDurationSeconds = requireNonNegativeNumber(record, 'linked_duration_seconds');
  const chatListReadable = requireBoolean(record.chat_list_readable, 'chat_list_readable');
  const logoutSeen = requireBoolean(record.logout_seen, 'logout_seen');
  const ghostConnectionSuspected = requireBoolean(record.ghost_connection_suspected, 'ghost_connection_suspected');
  const rawIdentifierScan = requireEnum(record.raw_identifier_scan, 'raw_identifier_scan', SCAN_VALUES);
  const messageContentScan = requireEnum(record.message_content_scan, 'message_content_scan', SCAN_VALUES);
  const killReason = record.kill_reason;
  if (killReason !== null && typeof killReason !== 'string') {
    throw new Error('kill_reason must be null or a string');
  }
  if (!authStarted) {
    throw new Error('auth_started must be true for success proof');
  }
  if (!authCompleted) {
    throw new Error('auth_completed must be true for success proof');
  }
  if (!readySeen) {
    throw new Error('ready_seen must be true for success proof');
  }
  if (readySeen && !chatListReadable) {
    throw new Error('ready_seen requires chat_list_readable for success proof');
  }
  if (logoutSeen) {
    throw new Error('logout_seen must be false for success proof');
  }
  if (ghostConnectionSuspected) {
    throw new Error('ghost_connection_suspected must be false for success proof');
  }
  if (rawIdentifierScan !== 'pass') {
    throw new Error('raw_identifier_scan must pass for success proof');
  }
  if (messageContentScan !== 'pass') {
    throw new Error('message_content_scan must pass for success proof');
  }

  return {
    artifact_type: ARTIFACT_TYPE,
    run_id: runId,
    client_family: clientFamily as DisposableClientCanaryArtifact['client_family'],
    account_class: 'disposable',
    send_disabled: true,
    auth_started: authStarted,
    auth_completed: authCompleted,
    ready_seen: readySeen,
    linked_duration_seconds: linkedDurationSeconds,
    chat_list_readable: chatListReadable,
    logout_seen: logoutSeen,
    ghost_connection_suspected: ghostConnectionSuspected,
    raw_identifier_scan: rawIdentifierScan,
    message_content_scan: messageContentScan,
    kill_reason: killReason,
  };
}

function usage(): string {
  return [
    'Usage: disposable-client-canary-artifact.ts --artifact artifact.json',
    '',
    'Validates a local no-send disposable-client canary proof artifact.',
    'This command does not open a browser, log into WhatsApp, send messages, or touch auth state.',
  ].join('\n');
}

function parseArgs(argv: string[]): ParsedArgs {
  let artifact = '';
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--artifact') {
      const value = argv[index + 1];
      if (!value) throw new Error('--artifact requires a path');
      artifact = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  if (!help && !artifact) throw new Error('--artifact is required');
  return { artifact, help };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  try {
    assertNoSecretLike(message, 'canary artifact error');
    return message;
  } catch {
    return 'redaction_violation: canary artifact contains secret-like values';
  }
}

export function run(argv: string[] = process.argv.slice(2)): DisposableClientCanaryArtifact | null {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return null;
    }
    const raw = readFileSync(args.artifact, 'utf8');
    const parsed = JSON.parse(raw);
    const artifact = validateDisposableClientCanaryArtifact(parsed);
    const diagnostic = [
      'DISPOSABLE_CLIENT_CANARY_ARTIFACT',
      'status=pass',
      `artifact_type=${artifact.artifact_type}`,
      `client_family=${artifact.client_family}`,
      `linked_duration_seconds=${artifact.linked_duration_seconds}`,
    ].join(' ');
    assertNoSecretLike(diagnostic, 'canary artifact diagnostic');
    console.log(diagnostic);
    return artifact;
  } catch (error) {
    console.error(`disposable client canary artifact failed: ${safeErrorMessage(error)}`);
    process.exitCode = 1;
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run();
}
