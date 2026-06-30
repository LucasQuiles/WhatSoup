import { assertNoSecretLike } from './artifact-redaction.ts';

const ARTIFACT_TYPE = 'disposable-client-canary';
const ALLOWED_CLIENT_FAMILIES = new Set(['whatsapp-web-js', 'other']);
const SCAN_VALUES = new Set(['pass', 'fail']);
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

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('artifact must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return value;
}

function requireScanValue(record: Record<string, unknown>, key: string): 'pass' | 'fail' {
  const value = record[key];
  if (typeof value !== 'string' || !SCAN_VALUES.has(value)) {
    throw new Error(`${key} must be pass or fail`);
  }
  return value as 'pass' | 'fail';
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
  const record = asRecord(value);
  assertNoSecretLike(JSON.stringify(record), 'disposable client canary artifact');
  assertAllowedKeys(record);

  if (record.artifact_type !== ARTIFACT_TYPE) {
    throw new Error(`artifact_type must be ${ARTIFACT_TYPE}`);
  }

  const runId = requireString(record, 'run_id');
  const clientFamily = requireString(record, 'client_family');
  if (!ALLOWED_CLIENT_FAMILIES.has(clientFamily)) {
    throw new Error('client_family must be whatsapp-web-js or other');
  }
  if (record.account_class !== 'disposable') {
    throw new Error('account_class must be disposable');
  }
  if (record.send_disabled !== true) {
    throw new Error('send_disabled must be true');
  }

  const authStarted = requireBoolean(record, 'auth_started');
  const authCompleted = requireBoolean(record, 'auth_completed');
  const readySeen = requireBoolean(record, 'ready_seen');
  const linkedDurationSeconds = requireNumber(record, 'linked_duration_seconds');
  const chatListReadable = requireBoolean(record, 'chat_list_readable');
  const logoutSeen = requireBoolean(record, 'logout_seen');
  const ghostConnectionSuspected = requireBoolean(record, 'ghost_connection_suspected');
  const rawIdentifierScan = requireScanValue(record, 'raw_identifier_scan');
  const messageContentScan = requireScanValue(record, 'message_content_scan');
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
