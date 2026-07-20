import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isRecord } from '../../lib/type-guards.ts';

export const AGENT365_V1_ORACLE_SHA256 =
  'ce63cd1ef1143d43bce1a40bcd88f3ec60106089958f1bd7bd539e0255cc1a59';
export const MICROSOFT365_EVIDENCE_TTL_MS = 60_000;

const READINESS_ERROR = 'invalid_agent365_v1_readiness';
const MAIL_RECEIPT_ERROR = 'invalid_agent365_v1_mail_receipt';
const ORACLE_ERROR = 'invalid_agent365_v1_oracle';
const IDENTITY_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const REASON_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

const READ_REASON_ORDER = [
  'no_authenticated_account',
  'multiple_authenticated_accounts',
  'account_selection_unavailable',
  'authenticated_account_changed',
  'readiness_snapshot_unavailable',
  'read_token_unavailable',
  'token_broker_disabled',
  'subscriptions_not_current',
  'ingestion_not_fresh',
  'public_ingress_not_ready',
] as const;

const MAIL_REASON_ORDER = [
  'no_authenticated_account',
  'multiple_authenticated_accounts',
  'account_selection_unavailable',
  'authenticated_account_changed',
  'mail_readiness_dependency_unavailable',
  'mail_permission_unavailable',
  'mail_ledger_unavailable',
] as const;

const ACCOUNT_SELECTION_REASONS = new Set<ReadReasonCode | MailReasonCode>([
  'no_authenticated_account',
  'multiple_authenticated_accounts',
  'account_selection_unavailable',
  'authenticated_account_changed',
]);

const READINESS_KEYS = [
  'version',
  'status',
  'account_id',
  'observed_at',
  'expires_at',
  'read',
  'mail_send',
] as const;
const READ_KEYS = [
  'ready',
  'reason_codes',
  'authenticated',
  'token_broker_enabled',
  'subscriptions_current',
  'ingestion_fresh',
  'public_ingress_ready',
] as const;
const MAIL_KEYS = ['ready', 'reason_codes', 'permission_ready', 'ledger_ready'] as const;
const RECEIPT_KEYS = [
  'operation_key',
  'account_id',
  'state',
  'error_code',
  'attempt_count',
  'created_at',
  'updated_at',
  'accepted_at',
] as const;

export type ReadReasonCode = (typeof READ_REASON_ORDER)[number];
export type MailReasonCode = (typeof MAIL_REASON_ORDER)[number];
export type Microsoft365ReadinessStatus = 'ready' | 'degraded' | 'not_ready';
export type MailReceiptState =
  | 'reserved'
  | 'draft_created'
  | 'accepted'
  | 'failed_pre_send'
  | 'unknown';

export interface ParsedMicrosoft365Readiness {
  version: 1;
  status: Microsoft365ReadinessStatus;
  accountId: string | null;
  observedAt: string;
  expiresAt: string;
  observedAtMs: number;
  expiresAtMs: number;
  read: {
    ready: boolean;
    reasonCodes: readonly ReadReasonCode[];
    authenticated: boolean;
    tokenBrokerEnabled: boolean;
    subscriptionsCurrent: boolean;
    ingestionFresh: boolean;
    publicIngressReady: boolean;
  };
  mailSend: {
    ready: boolean;
    reasonCodes: readonly MailReasonCode[];
    permissionReady: boolean;
    ledgerReady: boolean;
  };
}

export type ProjectedMicrosoft365Readiness = Omit<
  ParsedMicrosoft365Readiness,
  'accountId'
>;

export interface ParsedMailReceipt {
  operationKey: string;
  state: MailReceiptState;
  errorCode: string | null;
  attemptCount: 0 | 1;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
}

interface ParsedTimestamp {
  text: string;
  epochMicroseconds: bigint;
  epochMilliseconds: number;
}

type ParsedReadReadiness = ParsedMicrosoft365Readiness['read'];
type ParsedMailReadiness = ParsedMicrosoft365Readiness['mailSend'];

function failReadiness(): never {
  throw new Error(READINESS_ERROR);
}

function failMailReceipt(): never {
  throw new Error(MAIL_RECEIPT_ERROR);
}

function failOracle(): never {
  throw new Error(ORACLE_ERROR);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

function isSafeIdentity(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value !== '.'
    && value !== '..'
    && IDENTITY_PATTERN.test(value)
  );
}

function parseTimestamp(value: unknown): ParsedTimestamp | null {
  if (typeof value !== 'string') return null;
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? '';
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);

  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    return null;
  }

  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute, second, 0);
  const localMilliseconds = utc.getTime();
  if (!Number.isFinite(localMilliseconds)) return null;

  const offsetSign = match[9] === '-' ? -1 : 1;
  const offsetMilliseconds = offsetSign * (offsetHour * 60 + offsetMinute) * 60_000;
  const wholeMilliseconds = localMilliseconds - offsetMilliseconds;
  const fractionalMicroseconds = BigInt((fraction || '0').slice(0, 6).padEnd(6, '0'));
  const epochMicroseconds = BigInt(wholeMilliseconds) * 1_000n + fractionalMicroseconds;

  return {
    text: value,
    epochMicroseconds,
    epochMilliseconds: Number(epochMicroseconds) / 1_000,
  };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseReasons<T extends string>(
  value: unknown,
  canonicalOrder: readonly T[],
): readonly T[] | null {
  if (!Array.isArray(value)) return null;
  let priorIndex = -1;
  const reasons: T[] = [];
  for (const reason of value) {
    if (typeof reason !== 'string') return null;
    const index = canonicalOrder.indexOf(reason as T);
    if (index <= priorIndex) return null;
    priorIndex = index;
    reasons.push(reason as T);
  }
  return Object.freeze(reasons);
}

function parseRead(value: unknown): ParsedReadReadiness {
  if (!isRecord(value) || !hasExactKeys(value, READ_KEYS)) failReadiness();
  const reasons = parseReasons(value.reason_codes, READ_REASON_ORDER);
  if (
    typeof value.ready !== 'boolean'
    || reasons === null
    || typeof value.authenticated !== 'boolean'
    || typeof value.token_broker_enabled !== 'boolean'
    || typeof value.subscriptions_current !== 'boolean'
    || typeof value.ingestion_fresh !== 'boolean'
    || typeof value.public_ingress_ready !== 'boolean'
  ) {
    failReadiness();
  }

  const derivedReady = value.authenticated
    && value.token_broker_enabled
    && value.subscriptions_current
    && value.ingestion_fresh
    && value.public_ingress_ready;
  if (value.ready !== derivedReady || value.ready !== (reasons.length === 0)) {
    failReadiness();
  }

  return Object.freeze({
    ready: value.ready,
    reasonCodes: reasons,
    authenticated: value.authenticated,
    tokenBrokerEnabled: value.token_broker_enabled,
    subscriptionsCurrent: value.subscriptions_current,
    ingestionFresh: value.ingestion_fresh,
    publicIngressReady: value.public_ingress_ready,
  });
}

function parseMailReadiness(value: unknown): ParsedMailReadiness {
  if (!isRecord(value) || !hasExactKeys(value, MAIL_KEYS)) failReadiness();
  const reasons = parseReasons(value.reason_codes, MAIL_REASON_ORDER);
  if (
    typeof value.ready !== 'boolean'
    || reasons === null
    || typeof value.permission_ready !== 'boolean'
    || typeof value.ledger_ready !== 'boolean'
  ) {
    failReadiness();
  }

  const dependencyReady = !reasons.includes('mail_readiness_dependency_unavailable');
  const derivedReady = dependencyReady && value.permission_ready && value.ledger_ready;
  if (value.ready !== derivedReady || value.ready !== (reasons.length === 0)) {
    failReadiness();
  }

  return Object.freeze({
    ready: value.ready,
    reasonCodes: reasons,
    permissionReady: value.permission_ready,
    ledgerReady: value.ledger_ready,
  });
}

function expectedReadinessStatus(
  read: ParsedReadReadiness,
  mail: ParsedMailReadiness,
): Microsoft365ReadinessStatus {
  if (read.ready && mail.ready) return 'ready';
  return read.ready ? 'degraded' : 'not_ready';
}

function isReadinessStatus(value: unknown): value is Microsoft365ReadinessStatus {
  return value === 'ready' || value === 'degraded' || value === 'not_ready';
}

function validateAccountRelations(
  accountId: string | null,
  status: Microsoft365ReadinessStatus,
  read: ParsedReadReadiness,
  mail: ParsedMailReadiness,
): void {
  if ((status === 'ready' || status === 'degraded') && accountId === null) {
    failReadiness();
  }

  const readSelection = read.reasonCodes.filter((reason) => ACCOUNT_SELECTION_REASONS.has(reason));
  const mailSelection = mail.reasonCodes.filter((reason) => ACCOUNT_SELECTION_REASONS.has(reason));
  if (accountId === null) {
    if (
      readSelection.length !== 1
      || readSelection[0] !== mailSelection[0]
      || read.reasonCodes.length !== 1
      || mail.reasonCodes.length !== 1
      || read.authenticated
      || read.subscriptionsCurrent
      || read.ingestionFresh
      || read.publicIngressReady
      || mail.permissionReady
      || mail.ledgerReady
    ) {
      failReadiness();
    }
  } else if (readSelection.length !== 0 || mailSelection.length !== 0) {
    failReadiness();
  }

  const dependencyUnavailable = mail.reasonCodes.includes(
    'mail_readiness_dependency_unavailable',
  );
  if (dependencyUnavailable !== (accountId !== null && !read.ready)) {
    failReadiness();
  }
}

function parseMicrosoft365ReadinessInternal(
  value: unknown,
  nowMs: number,
  httpStatus?: number,
): ParsedMicrosoft365Readiness {
  if (!isRecord(value) || !hasExactKeys(value, READINESS_KEYS)) failReadiness();
  if (value.version !== 1 || !isReadinessStatus(value.status)) failReadiness();
  if (value.account_id !== null && !isSafeIdentity(value.account_id)) failReadiness();
  if (!Number.isSafeInteger(nowMs)) failReadiness();

  const observedAt = parseTimestamp(value.observed_at);
  const expiresAt = parseTimestamp(value.expires_at);
  if (observedAt === null || expiresAt === null) failReadiness();
  if (
    expiresAt.epochMicroseconds - observedAt.epochMicroseconds
      !== BigInt(MICROSOFT365_EVIDENCE_TTL_MS) * 1_000n
  ) {
    failReadiness();
  }
  const nowMicroseconds = BigInt(nowMs) * 1_000n;
  if (
    nowMicroseconds < observedAt.epochMicroseconds
    || nowMicroseconds >= expiresAt.epochMicroseconds
  ) {
    failReadiness();
  }

  const read = parseRead(value.read);
  const mailSend = parseMailReadiness(value.mail_send);
  const status = expectedReadinessStatus(read, mailSend);
  if (value.status !== status) failReadiness();

  const accountId = value.account_id as string | null;
  validateAccountRelations(accountId, status, read, mailSend);

  if (httpStatus !== undefined) {
    const expectedHttpStatus = status === 'ready' ? 200 : 503;
    if (!Number.isInteger(httpStatus) || httpStatus !== expectedHttpStatus) failReadiness();
  }

  return Object.freeze({
    version: 1,
    status,
    accountId,
    observedAt: observedAt.text,
    expiresAt: expiresAt.text,
    observedAtMs: observedAt.epochMilliseconds,
    expiresAtMs: expiresAt.epochMilliseconds,
    read,
    mailSend,
  });
}

export function assertVendoredAgent365V1Oracle(): void {
  try {
    const bytes = readFileSync(
      new URL('../../../contracts/agent365-whatsoup-v1.json', import.meta.url),
    );
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== AGENT365_V1_ORACLE_SHA256) failOracle();
  } catch {
    failOracle();
  }
}

export function parseMicrosoft365Readiness(
  value: unknown,
  nowMs: number,
  httpStatus?: number,
): ParsedMicrosoft365Readiness {
  try {
    return parseMicrosoft365ReadinessInternal(value, nowMs, httpStatus);
  } catch {
    failReadiness();
  }
}

export function projectMicrosoft365Readiness(
  value: ParsedMicrosoft365Readiness,
): ProjectedMicrosoft365Readiness {
  return Object.freeze({
    version: value.version,
    status: value.status,
    observedAt: value.observedAt,
    expiresAt: value.expiresAt,
    observedAtMs: value.observedAtMs,
    expiresAtMs: value.expiresAtMs,
    read: Object.freeze({
      ready: value.read.ready,
      reasonCodes: Object.freeze([...value.read.reasonCodes]),
      authenticated: value.read.authenticated,
      tokenBrokerEnabled: value.read.tokenBrokerEnabled,
      subscriptionsCurrent: value.read.subscriptionsCurrent,
      ingestionFresh: value.read.ingestionFresh,
      publicIngressReady: value.read.publicIngressReady,
    }),
    mailSend: Object.freeze({
      ready: value.mailSend.ready,
      reasonCodes: Object.freeze([...value.mailSend.reasonCodes]),
      permissionReady: value.mailSend.permissionReady,
      ledgerReady: value.mailSend.ledgerReady,
    }),
  });
}

function isReceiptState(value: unknown): value is MailReceiptState {
  return (
    value === 'reserved'
    || value === 'draft_created'
    || value === 'accepted'
    || value === 'failed_pre_send'
    || value === 'unknown'
  );
}

function parseMailReceiptInternal(
  value: unknown,
  expected: { operationKey: string; accountId: string },
): ParsedMailReceipt {
  if (!isRecord(value) || !hasExactKeys(value, RECEIPT_KEYS)) failMailReceipt();
  if (!isSafeIdentity(expected.operationKey) || !isSafeIdentity(expected.accountId)) {
    failMailReceipt();
  }
  if (!isSafeIdentity(value.operation_key) || !isSafeIdentity(value.account_id)) {
    failMailReceipt();
  }
  if (
    value.operation_key !== expected.operationKey
    || value.account_id !== expected.accountId
    || !isReceiptState(value.state)
  ) {
    failMailReceipt();
  }
  if (
    value.error_code !== null
    && (typeof value.error_code !== 'string' || !REASON_PATTERN.test(value.error_code))
  ) {
    failMailReceipt();
  }
  if (
    !Number.isInteger(value.attempt_count)
    || (value.attempt_count !== 0 && value.attempt_count !== 1)
  ) {
    failMailReceipt();
  }

  const createdAt = parseTimestamp(value.created_at);
  const updatedAt = parseTimestamp(value.updated_at);
  const acceptedAt = value.accepted_at === null ? null : parseTimestamp(value.accepted_at);
  if (
    createdAt === null
    || updatedAt === null
    || (value.accepted_at !== null && acceptedAt === null)
    || updatedAt.epochMicroseconds < createdAt.epochMicroseconds
  ) {
    failMailReceipt();
  }

  const attemptCount = value.attempt_count as 0 | 1;
  const errorCode = value.error_code as string | null;
  if (value.state === 'accepted') {
    if (
      attemptCount !== 1
      || errorCode !== null
      || acceptedAt === null
      || acceptedAt.epochMicroseconds < createdAt.epochMicroseconds
      || acceptedAt.epochMicroseconds > updatedAt.epochMicroseconds
    ) {
      failMailReceipt();
    }
  } else if (acceptedAt !== null) {
    failMailReceipt();
  } else if (value.state === 'reserved') {
    if (attemptCount !== 0 || errorCode !== null) failMailReceipt();
  } else if (value.state === 'draft_created') {
    if (errorCode !== null) failMailReceipt();
  } else if (value.state === 'failed_pre_send') {
    if (attemptCount !== 0 || errorCode === null) failMailReceipt();
  } else if (errorCode === null) {
    failMailReceipt();
  }

  return Object.freeze({
    operationKey: value.operation_key,
    state: value.state,
    errorCode,
    attemptCount,
    createdAt: createdAt.text,
    updatedAt: updatedAt.text,
    acceptedAt: acceptedAt?.text ?? null,
  });
}

export function parseMailReceipt(
  value: unknown,
  expected: { operationKey: string; accountId: string },
): ParsedMailReceipt {
  try {
    return parseMailReceiptInternal(value, expected);
  } catch {
    failMailReceipt();
  }
}
