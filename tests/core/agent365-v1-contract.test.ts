import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AGENT365_V1_ORACLE_SHA256,
  MICROSOFT365_EVIDENCE_TTL_MS,
  assertVendoredAgent365V1Oracle,
  parseMailReceipt,
  parseMicrosoft365Readiness,
  projectMicrosoft365Readiness,
} from '../../src/core/capabilities/agent365-v1-contract.ts';

const oracleUrl = new URL('../../contracts/agent365-whatsoup-v1.json', import.meta.url);
const oracleBytes = readFileSync(oracleUrl);
const oracle = JSON.parse(oracleBytes.toString('utf8')) as Oracle;
const nowMs = Date.parse('2026-07-11T16:00:30Z');

interface Oracle {
  contract: string;
  version: number;
  schemas: {
    mail_receipt: Record<string, unknown>;
    readiness: Record<string, unknown>;
  };
  samples: {
    mail_receipt: ReceiptSample[];
    readiness: ReadinessSample[];
  };
}

interface ReceiptSample {
  name: string;
  http_status: number;
  body: MutableReceipt;
}

interface ReadinessSample {
  name: string;
  http_status: number;
  body: MutableReadiness;
}

interface MutableReadiness {
  version: unknown;
  status: unknown;
  account_id: unknown;
  observed_at: unknown;
  expires_at: unknown;
  read: {
    ready: unknown;
    reason_codes: unknown;
    authenticated: unknown;
    token_broker_enabled: unknown;
    subscriptions_current: unknown;
    ingestion_fresh: unknown;
    public_ingress_ready: unknown;
    [key: string]: unknown;
  };
  mail_send: {
    ready: unknown;
    reason_codes: unknown;
    permission_ready: unknown;
    ledger_ready: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface MutableReceipt {
  operation_key: unknown;
  account_id: unknown;
  state: unknown;
  error_code: unknown;
  attempt_count: unknown;
  created_at: unknown;
  updated_at: unknown;
  accepted_at: unknown;
  [key: string]: unknown;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function readinessSample(name: string): ReadinessSample {
  const sample = oracle.samples.readiness.find((candidate) => candidate.name === name);
  if (!sample) throw new Error('oracle readiness sample missing');
  return sample;
}

function receiptSample(name: string): ReceiptSample {
  const sample = oracle.samples.mail_receipt.find((candidate) => candidate.name === name);
  if (!sample) throw new Error('oracle receipt sample missing');
  return sample;
}

function expectReadinessRejected(
  body: unknown,
  options: { httpStatus?: number; atMs?: number; canary?: string } = {},
): void {
  let thrown: unknown;
  try {
    parseMicrosoft365Readiness(body, options.atMs ?? nowMs, options.httpStatus);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe('invalid_agent365_v1_readiness');
  if (options.canary) expect(String(thrown)).not.toContain(options.canary);
}

function expectReceiptRejected(
  body: unknown,
  expected = { operationKey: 'operation-contract', accountId: 'acct-contract' },
  canary?: string,
): void {
  let thrown: unknown;
  try {
    parseMailReceipt(body, expected);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe('invalid_agent365_v1_mail_receipt');
  if (canary) expect(String(thrown)).not.toContain(canary);
}

describe('Agent365 Microsoft 365 v1 oracle', () => {
  it('pins the exact canonical vendored bytes and digest', () => {
    expect(AGENT365_V1_ORACLE_SHA256).toBe(
      'ce63cd1ef1143d43bce1a40bcd88f3ec60106089958f1bd7bd539e0255cc1a59',
    );
    expect(createHash('sha256').update(oracleBytes).digest('hex')).toBe(
      AGENT365_V1_ORACLE_SHA256,
    );
    expect(oracleBytes.equals(Buffer.from(`${JSON.stringify(oracle)}\n`, 'utf8'))).toBe(true);
    expect(() => assertVendoredAgent365V1Oracle()).not.toThrow();
  });

  it('contains the complete readiness and receipt sample matrix', () => {
    expect(oracle.contract).toBe('agent365-whatsoup-microsoft-365');
    expect(oracle.version).toBe(1);
    expect(oracle.samples.readiness.map((sample) => sample.name)).toEqual([
      'ready',
      'not_ready_no_authenticated_account',
      'not_ready_multiple_authenticated_accounts',
      'not_ready_account_selection_unavailable',
      'not_ready_authenticated_account_changed',
      'not_ready_readiness_snapshot_unavailable',
      'not_ready_read_token_unavailable',
      'not_ready_token_broker_disabled',
      'not_ready_subscriptions_not_current',
      'not_ready_ingestion_not_fresh',
      'not_ready_public_ingress_not_ready',
      'degraded_mail_permission_unavailable',
      'degraded_mail_ledger_unavailable',
    ]);
    expect(oracle.samples.mail_receipt.map((sample) => sample.name)).toEqual([
      'reserved',
      'draft_created',
      'accepted',
      'failed_pre_send',
      'unknown',
    ]);
    expect(Object.keys(oracle.schemas).sort()).toEqual(['mail_receipt', 'readiness']);
  });
});

describe('parseMicrosoft365Readiness', () => {
  it('consumes all thirteen authoritative readiness samples including valid HTTP 503 evidence', () => {
    expect(MICROSOFT365_EVIDENCE_TTL_MS).toBe(60_000);
    for (const sample of oracle.samples.readiness) {
      const parsed = parseMicrosoft365Readiness(sample.body, nowMs, sample.http_status);
      expect(parsed.version).toBe(1);
      expect(parsed.status).toBe(sample.body.status);
      expect(parsed.accountId).toBe(sample.body.account_id);
      expect(parsed.expiresAtMs - parsed.observedAtMs).toBe(MICROSOFT365_EVIDENCE_TTL_MS);
    }
  });

  it('accepts an omitted HTTP status and exact freshness boundaries inside the lifetime', () => {
    const sample = readinessSample('ready');
    const observedAtMs = Date.parse(sample.body.observed_at as string);
    const expiresAtMs = Date.parse(sample.body.expires_at as string);
    expect(parseMicrosoft365Readiness(sample.body, observedAtMs).status).toBe('ready');
    expect(parseMicrosoft365Readiness(sample.body, expiresAtMs - 1).status).toBe('ready');
  });

  it('accepts aware RFC3339 offsets and fractional seconds with the exact TTL', () => {
    const body = clone(readinessSample('ready').body);
    body.observed_at = '2026-07-11T12:00:00.123456789-04:00';
    body.expires_at = '2026-07-11T12:01:00.123456789-04:00';
    const parsed = parseMicrosoft365Readiness(body, Date.parse('2026-07-11T16:00:30Z'), 200);
    expect(parsed.observedAt).toBe(body.observed_at);
    expect(parsed.expiresAt).toBe(body.expires_at);
  });

  it('projects bounded readiness without retaining the ephemeral account identity', () => {
    const body = clone(readinessSample('ready').body);
    body.account_id = 'acct-projection-secret-canary';
    const parsed = parseMicrosoft365Readiness(body, nowMs, 200);
    const projected = projectMicrosoft365Readiness(parsed);
    expect(projected).toEqual({
      version: 1,
      status: 'ready',
      observedAt: '2026-07-11T16:00:00Z',
      expiresAt: '2026-07-11T16:01:00Z',
      observedAtMs: Date.parse('2026-07-11T16:00:00Z'),
      expiresAtMs: Date.parse('2026-07-11T16:01:00Z'),
      read: {
        ready: true,
        reasonCodes: [],
        authenticated: true,
        tokenBrokerEnabled: true,
        subscriptionsCurrent: true,
        ingestionFresh: true,
        publicIngressReady: true,
      },
      mailSend: {
        ready: true,
        reasonCodes: [],
        permissionReady: true,
        ledgerReady: true,
      },
    });
    expect(JSON.stringify(projected)).not.toContain('acct-projection-secret-canary');
    expect('accountId' in projected).toBe(false);
  });

  it('rejects non-objects and extra or missing keys at every contract level', () => {
    const ready = readinessSample('ready').body;
    expectReadinessRejected(null);
    expectReadinessRejected([]);
    expectReadinessRejected('ready');

    const topExtra = clone(ready);
    topExtra.secret_extra = true;
    expectReadinessRejected(topExtra);
    const topMissing = clone(ready);
    delete topMissing.expires_at;
    expectReadinessRejected(topMissing);

    const readExtra = clone(ready);
    readExtra.read.secret_extra = true;
    expectReadinessRejected(readExtra);
    const readMissing = clone(ready);
    delete readMissing.read.ingestion_fresh;
    expectReadinessRejected(readMissing);

    const mailExtra = clone(ready);
    mailExtra.mail_send.secret_extra = true;
    expectReadinessRejected(mailExtra);
    const mailMissing = clone(ready);
    delete mailMissing.mail_send.ledger_ready;
    expectReadinessRejected(mailMissing);
  });

  it('rejects non-v1 status values and non-boolean readiness flags', () => {
    const ready = readinessSample('ready').body;
    for (const [field, value] of [
      ['version', 2],
      ['version', '1'],
      ['status', 'sent'],
    ] as const) {
      const body = clone(ready);
      body[field] = value;
      expectReadinessRejected(body);
    }

    const readBoolean = clone(ready);
    readBoolean.read.authenticated = 1;
    expectReadinessRejected(readBoolean);
    const mailBoolean = clone(ready);
    mailBoolean.mail_send.permission_ready = 'true';
    expectReadinessRejected(mailBoolean);
  });

  it('rejects unsafe, dot-only, or overlong account identities without echoing them', () => {
    const ready = readinessSample('ready').body;
    for (const identity of [
      '.',
      '..',
      'acct/unsafe',
      'acct\nidentity-secret-canary',
      'a'.repeat(129),
    ]) {
      const body = clone(ready);
      body.account_id = identity;
      expectReadinessRejected(body, { httpStatus: 200, canary: identity });
    }
  });

  it('enforces closed, unique, canonically ordered readiness reasons', () => {
    const snapshotUnavailable = readinessSample('not_ready_readiness_snapshot_unavailable');

    const unknown = clone(snapshotUnavailable.body);
    unknown.read.reason_codes = ['raw-secret-reason-canary'];
    expectReadinessRejected(unknown, {
      httpStatus: snapshotUnavailable.http_status,
      canary: 'raw-secret-reason-canary',
    });

    const duplicate = clone(snapshotUnavailable.body);
    duplicate.read.reason_codes = [
      'readiness_snapshot_unavailable',
      'readiness_snapshot_unavailable',
    ];
    expectReadinessRejected(duplicate, { httpStatus: snapshotUnavailable.http_status });

    const outOfOrder = clone(snapshotUnavailable.body);
    outOfOrder.read.reason_codes = ['token_broker_disabled', 'read_token_unavailable'];
    expectReadinessRejected(outOfOrder, { httpStatus: snapshotUnavailable.http_status });

    const canonical = clone(snapshotUnavailable.body);
    canonical.read.reason_codes = ['read_token_unavailable', 'token_broker_disabled'];
    expect(
      parseMicrosoft365Readiness(canonical, nowMs, snapshotUnavailable.http_status).read
        .reasonCodes,
    ).toEqual(['read_token_unavailable', 'token_broker_disabled']);
  });

  it('derives nested readiness and top-level status from the exact booleans and reasons', () => {
    const ready = readinessSample('ready').body;

    const readDerivedMismatch = clone(ready);
    readDerivedMismatch.read.authenticated = false;
    expectReadinessRejected(readDerivedMismatch, { httpStatus: 200 });

    const mailDerivedMismatch = clone(ready);
    mailDerivedMismatch.mail_send.ledger_ready = false;
    expectReadinessRejected(mailDerivedMismatch, { httpStatus: 200 });

    const readyWithReasons = clone(ready);
    readyWithReasons.read.reason_codes = ['read_token_unavailable'];
    expectReadinessRejected(readyWithReasons, { httpStatus: 200 });

    const statusMismatch = clone(readinessSample('degraded_mail_permission_unavailable').body);
    statusMismatch.status = 'ready';
    expectReadinessRejected(statusMismatch, { httpStatus: 503 });
  });

  it('requires selected-account read readiness before mail send may be ready', () => {
    const readUnavailable = clone(readinessSample('not_ready_read_token_unavailable').body);
    readUnavailable.mail_send.ready = true;
    readUnavailable.mail_send.reason_codes = [];

    expectReadinessRejected(readUnavailable, {
      httpStatus: 503,
    });

    const parsed = parseMicrosoft365Readiness(
      readinessSample('not_ready_read_token_unavailable').body,
      nowMs,
      503,
    );
    expect(parsed.mailSend).toEqual({
      ready: false,
      reasonCodes: ['mail_readiness_dependency_unavailable'],
      permissionReady: true,
      ledgerReady: true,
    });
  });

  it.each([
    {
      reasonCodes: ['mail_permission_unavailable'],
      permissionReady: false,
      ledgerReady: true,
    },
    {
      reasonCodes: ['mail_ledger_unavailable'],
      permissionReady: true,
      ledgerReady: false,
    },
    {
      reasonCodes: ['mail_permission_unavailable', 'mail_ledger_unavailable'],
      permissionReady: false,
      ledgerReady: false,
    },
  ])(
    'requires the dependency reason alongside selected-account probe failures: $reasonCodes',
    ({ reasonCodes, permissionReady, ledgerReady }) => {
      const body = clone(readinessSample('not_ready_read_token_unavailable').body);
      body.mail_send.reason_codes = reasonCodes;
      body.mail_send.permission_ready = permissionReady;
      body.mail_send.ledger_ready = ledgerReady;

      expectReadinessRejected(body, { httpStatus: 503 });
    },
  );

  it.each([
    {
      reasonCodes: [
        'mail_readiness_dependency_unavailable',
        'mail_permission_unavailable',
      ],
      permissionReady: false,
      ledgerReady: true,
    },
    {
      reasonCodes: [
        'mail_readiness_dependency_unavailable',
        'mail_ledger_unavailable',
      ],
      permissionReady: true,
      ledgerReady: false,
    },
    {
      reasonCodes: [
        'mail_readiness_dependency_unavailable',
        'mail_permission_unavailable',
        'mail_ledger_unavailable',
      ],
      permissionReady: false,
      ledgerReady: false,
    },
  ])(
    'accepts canonical combined dependency and probe reasons: $reasonCodes',
    ({ reasonCodes, permissionReady, ledgerReady }) => {
      const body = clone(readinessSample('not_ready_read_token_unavailable').body);
      body.mail_send.reason_codes = reasonCodes;
      body.mail_send.permission_ready = permissionReady;
      body.mail_send.ledger_ready = ledgerReady;

      const parsed = parseMicrosoft365Readiness(body, nowMs, 503);
      expect(parsed.mailSend).toEqual({
        ready: false,
        reasonCodes,
        permissionReady,
        ledgerReady,
      });
    },
  );

  it.each([
    'degraded_mail_permission_unavailable',
    'degraded_mail_ledger_unavailable',
  ])(
    'rejects a spurious dependency reason when selected-account read is ready: %s',
    (name) => {
      const body = clone(readinessSample(name).body);
      body.mail_send.reason_codes = [
        'mail_readiness_dependency_unavailable',
        ...(body.mail_send.reason_codes as string[]),
      ];

      expectReadinessRejected(body, { httpStatus: 503 });
    },
  );

  it('enforces nullable-account selection relations without retaining raw identities', () => {
    const noAccount = readinessSample('not_ready_no_authenticated_account');

    const divergentReasons = clone(noAccount.body);
    divergentReasons.mail_send.reason_codes = ['multiple_authenticated_accounts'];
    expectReadinessRejected(divergentReasons, { httpStatus: noAccount.http_status });

    const extraReason = clone(noAccount.body);
    extraReason.read.reason_codes = ['no_authenticated_account', 'read_token_unavailable'];
    expectReadinessRejected(extraReason, { httpStatus: noAccount.http_status });

    const contradictoryFlag = clone(noAccount.body);
    contradictoryFlag.read.authenticated = true;
    expectReadinessRejected(contradictoryFlag, { httpStatus: noAccount.http_status });

    const selectedWithSelectionReason = clone(noAccount.body);
    selectedWithSelectionReason.account_id = 'acct-secret-selection-canary';
    expectReadinessRejected(selectedWithSelectionReason, {
      httpStatus: noAccount.http_status,
      canary: 'acct-secret-selection-canary',
    });

    const readyWithoutAccount = clone(readinessSample('ready').body);
    readyWithoutAccount.account_id = null;
    expectReadinessRejected(readyWithoutAccount, { httpStatus: 200 });
  });

  it('requires valid aware RFC3339 timestamps, exact TTL, and current evidence', () => {
    const ready = readinessSample('ready').body;

    for (const timestamp of [
      '2026-07-11T16:00:00',
      '0000-07-11T16:00:00Z',
      '2026-02-30T16:00:00Z',
      '2026-07-11 16:00:00Z',
      '2026-07-11T16:00:00+24:00',
    ]) {
      const body = clone(ready);
      body.observed_at = timestamp;
      expectReadinessRejected(body, { httpStatus: 200 });
    }

    const shortTtl = clone(ready);
    shortTtl.expires_at = '2026-07-11T16:00:59.999Z';
    expectReadinessRejected(shortTtl, { httpStatus: 200 });
    const longTtl = clone(ready);
    longTtl.expires_at = '2026-07-11T16:01:00.001Z';
    expectReadinessRejected(longTtl, { httpStatus: 200 });

    expectReadinessRejected(ready, {
      httpStatus: 200,
      atMs: Date.parse('2026-07-11T15:59:59.999Z'),
    });
    expectReadinessRejected(ready, {
      httpStatus: 200,
      atMs: Date.parse('2026-07-11T16:01:00Z'),
    });
    expectReadinessRejected(ready, { httpStatus: 200, atMs: Number.NaN });
    expectReadinessRejected(ready, { httpStatus: 200, atMs: nowMs + 0.5 });
  });

  it('requires the exact body-to-HTTP status mapping when status is supplied', () => {
    expectReadinessRejected(readinessSample('ready').body, { httpStatus: 503 });
    expectReadinessRejected(readinessSample('degraded_mail_permission_unavailable').body, {
      httpStatus: 200,
    });
    expectReadinessRejected(readinessSample('not_ready_read_token_unavailable').body, {
      httpStatus: 204,
    });
  });
});

describe('parseMailReceipt', () => {
  it('consumes all five authoritative receipt states and strips the account identity', () => {
    for (const sample of oracle.samples.mail_receipt) {
      const parsed = parseMailReceipt(sample.body, {
        operationKey: 'operation-contract',
        accountId: 'acct-contract',
      });
      expect(parsed.state).toBe(sample.name);
      expect(parsed.operationKey).toBe('operation-contract');
      expect('accountId' in parsed).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain('acct-contract');
    }
  });

  it('returns the exact bounded seven-field local receipt projection', () => {
    const body = clone(receiptSample('accepted').body);
    body.account_id = 'acct-receipt-secret-canary';
    const parsed = parseMailReceipt(body, {
      operationKey: 'operation-contract',
      accountId: 'acct-receipt-secret-canary',
    });
    expect(parsed).toEqual({
      operationKey: 'operation-contract',
      state: 'accepted',
      errorCode: null,
      attemptCount: 1,
      createdAt: '2026-07-11T16:00:00Z',
      updatedAt: '2026-07-11T16:00:01Z',
      acceptedAt: '2026-07-11T16:00:01Z',
    });
    expect(JSON.stringify(parsed)).not.toContain('acct-receipt-secret-canary');
  });

  it('rejects non-objects and exact-field violations', () => {
    const reserved = receiptSample('reserved').body;
    expectReceiptRejected(null);
    expectReceiptRejected([]);

    const extra = clone(reserved);
    extra.duplicate = false;
    expectReceiptRejected(extra);
    const missing = clone(reserved);
    delete missing.accepted_at;
    expectReceiptRejected(missing);
  });

  it('rejects unsafe identities and context mismatches without echoing them', () => {
    const accepted = receiptSample('accepted').body;
    for (const field of ['operation_key', 'account_id'] as const) {
      for (const identity of ['.', '..', 'unsafe/value', 'identity\nsecret-canary']) {
        const body = clone(accepted);
        body[field] = identity;
        const expected = {
          operationKey: field === 'operation_key' ? identity : 'operation-contract',
          accountId: field === 'account_id' ? identity : 'acct-contract',
        };
        expectReceiptRejected(body, expected, identity);
      }
    }

    expectReceiptRejected(accepted, {
      operationKey: 'other-operation-secret-canary',
      accountId: 'acct-contract',
    }, 'other-operation-secret-canary');
    expectReceiptRejected(accepted, {
      operationKey: 'operation-contract',
      accountId: 'other-account-secret-canary',
    }, 'other-account-secret-canary');
  });

  it('enforces closed states, safe error reasons, and integer attempt bounds', () => {
    const unknown = receiptSample('unknown').body;
    for (const mutation of [
      { state: 'sent' },
      { error_code: 'raw secret reason' },
      { error_code: 'raw\nsecret-reason-canary' },
      { error_code: 'a'.repeat(129) },
      { attempt_count: -1 },
      { attempt_count: 2 },
      { attempt_count: 0.5 },
      { attempt_count: true },
    ]) {
      expectReceiptRejected({ ...clone(unknown), ...mutation }, undefined, 'secret-reason-canary');
    }
  });

  it('enforces timestamp ordering and accepted timestamp bounds', () => {
    const accepted = receiptSample('accepted').body;
    for (const mutation of [
      { created_at: '2026-07-11T16:00:00' },
      { updated_at: '2026-02-30T16:00:01Z' },
      { updated_at: '2026-07-11T15:59:59Z' },
      { accepted_at: '2026-07-11T15:59:59Z' },
      { accepted_at: '2026-07-11T16:00:02Z' },
    ]) {
      expectReceiptRejected({ ...clone(accepted), ...mutation });
    }
  });

  it('enforces the exact state-specific receipt relations', () => {
    const accepted = receiptSample('accepted').body;
    expectReceiptRejected({ ...clone(accepted), attempt_count: 0 });
    expectReceiptRejected({ ...clone(accepted), error_code: 'mail_command_failed' });
    expectReceiptRejected({ ...clone(accepted), accepted_at: null });

    const reserved = receiptSample('reserved').body;
    expectReceiptRejected({ ...clone(reserved), attempt_count: 1 });
    expectReceiptRejected({ ...clone(reserved), error_code: 'reserved_failed' });

    const draft = receiptSample('draft_created').body;
    expectReceiptRejected({ ...clone(draft), error_code: 'draft_failed' });
    expect(parseMailReceipt({ ...clone(draft), attempt_count: 0 }, {
      operationKey: 'operation-contract',
      accountId: 'acct-contract',
    }).attemptCount).toBe(0);

    const failed = receiptSample('failed_pre_send').body;
    expectReceiptRejected({ ...clone(failed), attempt_count: 1 });
    expectReceiptRejected({ ...clone(failed), error_code: null });

    const unknown = receiptSample('unknown').body;
    expectReceiptRejected({ ...clone(unknown), error_code: null });
    expect(parseMailReceipt({ ...clone(unknown), attempt_count: 0 }, {
      operationKey: 'operation-contract',
      accountId: 'acct-contract',
    }).attemptCount).toBe(0);

    for (const sample of ['reserved', 'draft_created', 'failed_pre_send', 'unknown']) {
      expectReceiptRejected({
        ...clone(receiptSample(sample).body),
        accepted_at: '2026-07-11T16:00:01Z',
      });
    }
  });
});
