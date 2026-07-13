import {
  assertVendoredAgent365V1Oracle,
  parseMailReceipt,
  parseMicrosoft365Readiness,
  projectMicrosoft365Readiness,
  type ParsedMicrosoft365Readiness,
} from './agent365-v1-contract.ts';
import { createHash } from 'node:crypto';
import { parseLoopbackCapabilityOrigin } from './loopback-endpoint.ts';

const READINESS_PATH = '/capabilities/microsoft-365/readiness';
const SEND_ONCE_PATH = '/mail/send-once';
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const MAX_API_KEY_LENGTH = 4_096;
const MAX_OPERATION_KEY_LENGTH = 128;
const MAX_SUBJECT_LENGTH = 998;
const MAX_BODY_BYTES = 1_048_576;
const MAX_RECIPIENT_LENGTH = 320;
const MAX_RECIPIENTS = 50;
const SAFE_IDENTITY = /^[A-Za-z0-9._~-]{1,128}$/;

export type Agent365ProbeFailureReason =
  | 'timeout'
  | 'transport_unavailable'
  | 'response_url_mismatch'
  | 'response_status_invalid'
  | 'response_content_type_invalid'
  | 'response_too_large'
  | 'response_invalid_utf8'
  | 'response_json_invalid'
  | 'response_contract_invalid';

export type Agent365ReadinessProbeResult =
  | {
    kind: 'evidence';
    evidence: ReturnType<typeof projectMicrosoft365Readiness>;
  }
  | {
    kind: 'unavailable';
    reason: Agent365ProbeFailureReason;
  };

export interface Agent365SendOnceInput {
  operationKey: string;
  accountPermitDigest: string;
  message: {
    subject: string;
    body: string;
    bodyFormat: 'text' | 'html';
    to: readonly string[];
    cc: readonly string[];
    bcc: readonly string[];
  };
}

export interface Agent365AccountPermit {
  readonly accountDigest: string;
}

const INTERNAL_ACCOUNT_PERMIT = Symbol('agent365-internal-account-permit');
const ACCOUNT_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

type EvidenceWithInternalPermit = Extract<
  Agent365ReadinessProbeResult,
  { kind: 'evidence' }
> & { readonly [INTERNAL_ACCOUNT_PERMIT]?: Agent365AccountPermit };

export function agent365AccountDigest(accountId: string): string {
  return createHash('sha256')
    .update('agent365-account-permit:v1\0')
    .update(`${Buffer.byteLength(accountId, 'utf8')}:`)
    .update(accountId)
    .digest('hex');
}

export function attachInternalAgent365AccountPermit(
  result: Extract<Agent365ReadinessProbeResult, { kind: 'evidence' }>,
  accountId: string,
): Extract<Agent365ReadinessProbeResult, { kind: 'evidence' }> {
  if (!SAFE_IDENTITY.test(accountId) || accountId === '.' || accountId === '..') {
    return result;
  }
  Object.defineProperty(result, INTERNAL_ACCOUNT_PERMIT, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ accountDigest: agent365AccountDigest(accountId) }),
  });
  return result;
}

export function getInternalAgent365AccountPermit(
  result: Agent365ReadinessProbeResult,
): Agent365AccountPermit | null {
  if (result.kind !== 'evidence') return null;
  const permit = (result as EvidenceWithInternalPermit)[INTERNAL_ACCOUNT_PERMIT];
  return permit !== undefined && ACCOUNT_DIGEST_PATTERN.test(permit.accountDigest)
    ? permit
    : null;
}

export type Agent365SendOnceResult =
  | { kind: 'accepted' }
  | {
    kind: 'unknown';
    quarantine: true;
    reason:
      | 'backend_nonterminal_receipt'
      | 'dispatch_outcome_unknown'
      | 'dispatch_response_invalid';
  }
  | {
    kind: 'failed';
    provenPreSend: true;
    reason:
      | 'readiness_unavailable'
      | 'mail_send_not_ready'
      | 'mail_request_invalid'
      | 'mail_request_rejected'
      | 'mail_operation_conflict'
      | 'backend_failed_pre_send';
  };

export interface Agent365ClientOptions {
  endpoint: string;
  apiKey: string;
  fetch: typeof fetch;
  clock: () => number;
  timeoutMs: number;
}

export interface Agent365Client {
  probeReadiness(signal?: AbortSignal): Promise<Agent365ReadinessProbeResult>;
  sendOnceForReservedWinner(input: Agent365SendOnceInput): Promise<Agent365SendOnceResult>;
}

type InternalReadinessResult =
  | {
    kind: 'evidence';
    parsed: ParsedMicrosoft365Readiness;
    evidence: ReturnType<typeof projectMicrosoft365Readiness>;
  }
  | {
    kind: 'unavailable';
    reason: Agent365ProbeFailureReason;
  };

class BoundaryFailure {
  readonly reason: Agent365ProbeFailureReason;

  constructor(reason: Agent365ProbeFailureReason) {
    this.reason = reason;
  }
}

function configurationInvalid(): never {
  throw new TypeError('agent365_client_configuration_invalid');
}

function validateOptions(options: Agent365ClientOptions): {
  origin: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  clock: () => number;
  timeoutMs: number;
} {
  const origin = parseLoopbackCapabilityOrigin(options.endpoint);
  if (
    origin === null
    || typeof options.apiKey !== 'string'
    || options.apiKey.length < 1
    || options.apiKey.length > MAX_API_KEY_LENGTH
    || options.apiKey.trim() !== options.apiKey
    || options.apiKey.includes('\r')
    || options.apiKey.includes('\n')
    || typeof options.fetch !== 'function'
    || typeof options.clock !== 'function'
    || !Number.isInteger(options.timeoutMs)
    || options.timeoutMs < 1
    || options.timeoutMs > MAX_TIMEOUT_MS
  ) {
    return configurationInvalid();
  }
  return {
    origin,
    apiKey: options.apiKey,
    fetchImpl: options.fetch,
    clock: options.clock,
    timeoutMs: options.timeoutMs,
  };
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(new BoundaryFailure('timeout'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new BoundaryFailure('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<void> {
  try {
    await waitWithAbort(Promise.resolve(reader.cancel()), signal);
  } catch {
    // Cancellation is best effort; the bounded classification is authoritative.
  }
}

async function readResponseBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const buffer = await waitWithAbort(response.arrayBuffer(), signal);
    if (buffer.byteLength > MAX_RESPONSE_BYTES) {
      throw new BoundaryFailure('response_too_large');
    }
    return new Uint8Array(buffer);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await waitWithAbort(reader.read(), signal);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        throw new BoundaryFailure('response_contract_invalid');
      }
      if (next.value.byteLength > MAX_RESPONSE_BYTES - total) {
        await cancelReader(reader, signal);
        throw new BoundaryFailure('response_too_large');
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } finally {
    if (signal.aborted) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  return value.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function decodeJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BoundaryFailure('response_invalid_utf8');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BoundaryFailure('response_json_invalid');
  }
}

function copyRecipientList(value: unknown, requireOne: boolean): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const length = value.length;
  if (
    !Number.isSafeInteger(length)
    || length > MAX_RECIPIENTS
    || (requireOne && length < 1)
  ) {
    return null;
  }
  const copy: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const recipient = value[index] as unknown;
    if (
      typeof recipient !== 'string'
      || recipient.length < 1
      || recipient.length > MAX_RECIPIENT_LENGTH
    ) {
      return null;
    }
    copy.push(recipient);
  }
  return Object.freeze(copy);
}

function snapshotSendInput(value: unknown): Agent365SendOnceInput | null {
  try {
    if (value === null || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const operationKey = record['operationKey'];
    const accountPermitDigest = record['accountPermitDigest'];
    if (
      typeof operationKey !== 'string'
      || operationKey.length > MAX_OPERATION_KEY_LENGTH
      || operationKey === '.'
      || operationKey === '..'
      || !SAFE_IDENTITY.test(operationKey)
      || typeof accountPermitDigest !== 'string'
      || !ACCOUNT_DIGEST_PATTERN.test(accountPermitDigest)
    ) {
      return null;
    }
    const rawMessage = record['message'];
    if (rawMessage === null || typeof rawMessage !== 'object') return null;
    const message = rawMessage as Record<string, unknown>;
    const subject = message['subject'];
    const body = message['body'];
    const bodyFormat = message['bodyFormat'];
    const to = copyRecipientList(message['to'], true);
    const cc = copyRecipientList(message['cc'], false);
    const bcc = copyRecipientList(message['bcc'], false);
    if (
      typeof subject !== 'string'
      || subject.length > MAX_SUBJECT_LENGTH
      || typeof body !== 'string'
      || body.length > MAX_BODY_BYTES
      || new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES
      || (bodyFormat !== 'text' && bodyFormat !== 'html')
      || to === null
      || cc === null
      || bcc === null
      || to.length + cc.length + bcc.length > MAX_RECIPIENTS
    ) {
      return null;
    }
    return Object.freeze({
      operationKey,
      accountPermitDigest,
      message: Object.freeze({
        subject,
        body,
        bodyFormat,
        to,
        cc,
        bcc,
      }),
    });
  } catch {
    return null;
  }
}

async function fetchReadiness(
  config: ReturnType<typeof validateOptions>,
  externalSignal?: AbortSignal,
): Promise<InternalReadinessResult> {
  const url = `${config.origin}${READINESS_PATH}`;
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  if (externalSignal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    if (controller.signal.aborted) throw new BoundaryFailure('timeout');
    const response = await waitWithAbort(
      config.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        redirect: 'error',
        signal: controller.signal,
      }),
      controller.signal,
    );
    if (response.url !== url) {
      throw new BoundaryFailure('response_url_mismatch');
    }
    if (response.status !== 200 && response.status !== 503) {
      throw new BoundaryFailure('response_status_invalid');
    }
    if (!isJsonContentType(response.headers.get('content-type'))) {
      throw new BoundaryFailure('response_content_type_invalid');
    }
    const bytes = await readResponseBytes(response, controller.signal);
    const payload = decodeJson(bytes);
    let parsed: ParsedMicrosoft365Readiness;
    try {
      parsed = parseMicrosoft365Readiness(payload, config.clock(), response.status);
    } catch {
      throw new BoundaryFailure('response_contract_invalid');
    }
    return {
      kind: 'evidence',
      parsed,
      evidence: projectMicrosoft365Readiness(parsed),
    };
  } catch (error) {
    if (error instanceof BoundaryFailure) {
      return { kind: 'unavailable', reason: error.reason };
    }
    if (controller.signal.aborted) {
      return { kind: 'unavailable', reason: 'timeout' };
    }
    return { kind: 'unavailable', reason: 'transport_unavailable' };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
    controller.abort();
  }
}

async function postSendOnce(
  config: ReturnType<typeof validateOptions>,
  input: Agent365SendOnceInput,
  accountId: string,
): Promise<Agent365SendOnceResult> {
  const url = `${config.origin}${SEND_ONCE_PATH}`;
  let body: string;
  try {
    body = JSON.stringify({
      operation_key: input.operationKey,
      account_id: accountId,
      message: {
        subject: input.message.subject,
        body: input.message.body,
        content_type: input.message.bodyFormat === 'text' ? 'Text' : 'HTML',
        to: input.message.to,
        cc: input.message.cc,
        bcc: input.message.bcc,
      },
    });
  } catch {
    return {
      kind: 'failed',
      provenPreSend: true,
      reason: 'mail_request_rejected',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await waitWithAbort(
      config.fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        redirect: 'error',
        signal: controller.signal,
      }),
      controller.signal,
    );
    if (response.url !== url) {
      throw new BoundaryFailure('response_url_mismatch');
    }
    if (response.status !== 200) {
      return {
        kind: 'unknown',
        quarantine: true,
        reason: 'dispatch_outcome_unknown',
      };
    }
    if (!isJsonContentType(response.headers.get('content-type'))) {
      return {
        kind: 'unknown',
        quarantine: true,
        reason: 'dispatch_response_invalid',
      };
    }

    let parsed: ReturnType<typeof parseMailReceipt>;
    try {
      const payload = decodeJson(await readResponseBytes(response, controller.signal));
      parsed = parseMailReceipt(payload, {
        operationKey: input.operationKey,
        accountId,
      });
    } catch {
      return {
        kind: 'unknown',
        quarantine: true,
        reason: 'dispatch_response_invalid',
      };
    }

    switch (parsed.state) {
      case 'accepted':
        return { kind: 'accepted' };
      case 'failed_pre_send':
        return {
          kind: 'failed',
          provenPreSend: true,
          reason: 'backend_failed_pre_send',
        };
      case 'reserved':
      case 'draft_created':
      case 'unknown':
        return {
          kind: 'unknown',
          quarantine: true,
          reason: 'backend_nonterminal_receipt',
        };
    }
  } catch {
    return {
      kind: 'unknown',
      quarantine: true,
      reason: 'dispatch_outcome_unknown',
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function sendOnceForReservedWinner(
  config: ReturnType<typeof validateOptions>,
  rawInput: Agent365SendOnceInput,
): Promise<Agent365SendOnceResult> {
  const input = snapshotSendInput(rawInput);
  if (input === null) {
    return {
      kind: 'failed',
      provenPreSend: true,
      reason: 'mail_request_invalid',
    };
  }
  const readiness = await fetchReadiness(config);
  if (readiness.kind === 'unavailable') {
    return {
      kind: 'failed',
      provenPreSend: true,
      reason: 'readiness_unavailable',
    };
  }
  const accountId = readiness.parsed.accountId;
  if (
    readiness.parsed.status !== 'ready'
    || !readiness.parsed.read.ready
    || !readiness.parsed.mailSend.ready
    || accountId === null
  ) {
    return {
      kind: 'failed',
      provenPreSend: true,
      reason: 'mail_send_not_ready',
    };
  }
  if (agent365AccountDigest(accountId) !== input.accountPermitDigest) {
    return {
      kind: 'failed',
      provenPreSend: true,
      reason: 'mail_send_not_ready',
    };
  }
  return postSendOnce(config, input, accountId);
}

export function createAgent365Client(options: Agent365ClientOptions): Agent365Client {
  const config = validateOptions(options);
  try {
    assertVendoredAgent365V1Oracle();
  } catch {
    return configurationInvalid();
  }
  const client: Agent365Client = {
    probeReadiness: async (signal?: AbortSignal): Promise<Agent365ReadinessProbeResult> => {
      const result = await fetchReadiness(config, signal);
      if (result.kind !== 'evidence') return result;
      const projected: Extract<Agent365ReadinessProbeResult, { kind: 'evidence' }> = {
        kind: 'evidence',
        evidence: result.evidence,
      };
      return result.parsed.accountId === null
        ? projected
        : attachInternalAgent365AccountPermit(projected, result.parsed.accountId);
    },
    sendOnceForReservedWinner: (input: Agent365SendOnceInput) => (
      sendOnceForReservedWinner(config, input)
    ),
  };
  return Object.freeze(client);
}
