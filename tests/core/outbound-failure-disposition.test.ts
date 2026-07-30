import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AuthRequiredError,
  PayloadTooLargeError,
  RateLimitedError,
  SendAmbiguousError,
  TransientProviderError,
  UnsupportedCapabilityError,
} from '../../src/transport/contract/errors.ts';
import {
  classifyOutboundFailure,
  decodeOutboundFailureEvidence,
  encodeOutboundFailureEvidence,
  outboundFailureWarrantsUserNotice,
  OUTBOUND_FAILURE_EVIDENCE_MAX_BYTES,
} from '../../src/core/outbound-failure-disposition.ts';
import { makeChannelId } from '../../src/core/transport-refs.ts';
import { WhatSoupError } from '../../src/errors.ts';
import { OUTBOUND_GOVERNOR_SHED_LOG } from '../../src/core/outbound-governor-shed.ts';
import { OutboundIdentityError } from '../../src/core/outbound-identity/guard.ts';
import { Database } from '../../src/core/database.ts';
import {
  drainPendingOutbound,
  DurabilityEngine,
  persistOutboundFailureDisposition,
  sendTracked,
} from '../../src/core/durability.ts';
import type { Messenger } from '../../src/core/types.ts';

const base = {
  channelId: makeChannelId('signal', 'primary'),
  operation: 'sendText',
  correlationId: 'synthetic-correlation',
  scope: 'request' as const,
  message: 'synthetic provider prose that must not persist',
};

describe('outbound failure disposition', () => {
  it('defers a typed local producer cooldown without inventing a provider submission', () => {
    const evidence = classifyOutboundFailure(
      new RateLimitedError({
        ...base,
        phase: 'not_started',
        retryAfterMs: 60_000,
      }),
      {
        nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
        retryOwner: 'agent_queue',
        attemptsRemaining: 2,
      },
    );

    expect(evidence).toMatchObject({
      failure_code: 'transport.rate_limited',
      stage: 'admission',
      mutation_state: 'not_started',
      retry_decision: 'retry_not_before',
      retry_not_before: '2026-07-28T00:01:00.000Z',
      retry_owner: 'pending_drainer',
      attempt_budget_disposition: 'preserve',
      logical_attempt_count: 1,
      provider_submission_count: 0,
      evidence_coverage: 'complete',
    });
  });

  it('preserves representable producer floors above one year', () => {
    const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1_000;
    const evidence = classifyOutboundFailure(
      new RateLimitedError({
        ...base,
        phase: 'not_started',
        retryAfterMs: twoYearsMs,
      }),
      {
        nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
        retryOwner: 'agent_queue',
        attemptsRemaining: 2,
      },
    );

    expect(evidence.retry_decision).toBe('retry_not_before');
    expect(evidence.retry_not_before).toBe('2028-07-27T00:00:00.000Z');
  });

  it('treats a retryAfterMs near the old Date-range ceiling as no hint instead of throwing', () => {
    // A deadline beyond year 9999 serializes to an extended-year ISO string
    // (e.g. "+275760-09-13T00:00:00.000Z", 27 chars) which isIsoTimestamp's
    // 24-char check always rejects. The old ceiling (Date's own max range,
    // 8_640_000_000_000_000 ms) let such deadlines through validPositiveDelay,
    // so assertValidEvidence threw from inside classifyOutboundFailure —
    // exactly the uncaught-throw defect class this PR eliminates. A huge
    // retryAfterMs must degrade to "no deferral hint", not throw.
    const nowMs = Date.parse('2026-07-28T00:00:00.000Z');
    const retryAfterMs = 8_640_000_000_000_000 - nowMs; // lands exactly at the old ceiling

    const evidence = classifyOutboundFailure(
      new RateLimitedError({
        ...base,
        phase: 'not_started',
        retryAfterMs,
      }),
      {
        nowMs,
        retryOwner: 'agent_queue',
        attemptsRemaining: 2,
      },
    );

    expect(evidence).toMatchObject({
      retry_decision: 'retry_now',
      retry_not_before: null,
      retry_owner: 'agent_queue',
      attempt_budget_disposition: 'consume',
      retryable: true,
    });
  });

  it('stops a typed non-retryable provider rejection after one logical attempt', () => {
    const evidence = classifyOutboundFailure(
      new AuthRequiredError({
        ...base,
        phase: 'provider_call_started',
      }),
      {
        nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
        retryOwner: 'chat_runtime',
        attemptsRemaining: 2,
      },
    );

    expect(evidence).toMatchObject({
      failure_code: 'transport.auth_required',
      stage: 'provider_response',
      mutation_state: 'rejected',
      retry_decision: 'stop',
      retry_owner: 'none',
      attempt_budget_disposition: 'stop',
      logical_attempt_count: 1,
      provider_submission_count: 1,
      evidence_coverage: 'complete',
    });
  });

  it('preserves typed ambiguity independently from retryability', () => {
    const evidence = classifyOutboundFailure(
      new SendAmbiguousError({
        ...base,
        phase: 'provider_call_started',
      }),
      {
        nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
        retryOwner: 'send_tracked',
        attemptsRemaining: 0,
      },
    );

    expect(evidence).toMatchObject({
      failure_code: 'transport.send_ambiguous',
      stage: 'provider_request',
      mutation_state: 'ambiguous',
      retry_decision: 'stop',
      logical_attempt_count: 1,
      provider_submission_count: 1,
      evidence_coverage: 'complete',
    });
  });

  it('classifies a local governor shed as a deterministic zero-submission stop', () => {
    const evidence = classifyOutboundFailure(
      new WhatSoupError(OUTBOUND_GOVERNOR_SHED_LOG, 'OUTBOUND_GOVERNOR_SHED'),
      {
        nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
        retryOwner: 'agent_queue',
        attemptsRemaining: 2,
      },
    );

    expect(evidence).toMatchObject({
      failure_code: 'outbound.governor_shed',
      stage: 'admission',
      mutation_state: 'not_started',
      retryable: false,
      retry_decision: 'stop',
      retry_owner: 'none',
      attempt_budget_disposition: 'stop',
      logical_attempt_count: 1,
      provider_submission_count: 0,
      evidence_coverage: 'partial',
    });
  });

  it('classifies an identity guard block as a bounded zero-submission stop', () => {
    const marker = 'identity-guard-marker-must-not-persist';
    const evidence = classifyOutboundFailure(
      new OutboundIdentityError('COLD_TARGET', marker),
      {
        nowMs: Date.parse('2026-07-29T00:00:00.000Z'),
        retryOwner: 'send_tracked',
        attemptsRemaining: 0,
      },
    );

    expect(evidence).toMatchObject({
      failure_code: 'outbound.identity_blocked',
      stage: 'admission',
      mutation_state: 'not_started',
      retryable: false,
      retry_decision: 'stop',
      retry_owner: 'none',
      attempt_budget_disposition: 'stop',
      logical_attempt_count: 1,
      provider_submission_count: 0,
      evidence_coverage: 'partial',
    });
    expect(encodeOutboundFailureEvidence(evidence)).not.toContain(marker);
  });

  it('classifies an untyped throw conservatively without persisting its prose', () => {
    const marker = 'recipient-and-provider-marker-must-not-persist';
    const evidence = classifyOutboundFailure(
      new Error(marker),
      {
        nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
        retryOwner: 'agent_queue',
        attemptsRemaining: 0,
      },
    );
    const encoded = encodeOutboundFailureEvidence(evidence);

    expect(evidence).toMatchObject({
      failure_code: 'outbound.unknown_failure',
      stage: 'provider_request',
      mutation_state: 'ambiguous',
      retry_decision: 'stop',
      logical_attempt_count: 1,
      provider_submission_count: 1,
      evidence_coverage: 'partial',
    });
    expect(encoded).not.toContain(marker);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(
      OUTBOUND_FAILURE_EVIDENCE_MAX_BYTES,
    );
  });

  it('keeps counts monotonic across a prior durable deferral', () => {
    const first = classifyOutboundFailure(
      new RateLimitedError({
        ...base,
        phase: 'not_started',
        retryAfterMs: 60_000,
      }),
      {
        nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
        retryOwner: 'agent_queue',
        attemptsRemaining: 2,
      },
    );
    const second = classifyOutboundFailure(
      new AuthRequiredError({
        ...base,
        phase: 'provider_call_started',
      }),
      {
        nowMs: Date.parse('2026-07-28T00:02:00.000Z'),
        retryOwner: 'pending_drainer',
        attemptsRemaining: 0,
        previousEvidence: first,
      },
    );

    expect(second).toMatchObject({
      logical_attempt_count: 2,
      provider_submission_count: 1,
      first_failure_at: '2026-07-28T00:00:00.000Z',
      last_failure_at: '2026-07-28T00:02:00.000Z',
    });
  });

  it('keeps failure timestamps monotonic across wall-clock rollback', () => {
    const first = classifyOutboundFailure(new Error('first'), {
      nowMs: Date.parse('2026-07-28T00:02:00.000Z'),
      retryOwner: 'agent_queue',
      attemptsRemaining: 1,
    });
    const second = classifyOutboundFailure(new Error('second'), {
      nowMs: Date.parse('2026-07-28T00:01:00.000Z'),
      retryOwner: 'agent_queue',
      attemptsRemaining: 0,
      previousEvidence: first,
    });

    expect(second.first_failure_at).toBe('2026-07-28T00:02:00.000Z');
    expect(second.last_failure_at).toBe('2026-07-28T00:02:00.000Z');
  });

  it('does not execute throwing optional transport-payload getters', () => {
    const payload: Record<string, unknown> = {
      code: 'transport.rate_limited',
      retryable: true,
    };
    Object.defineProperty(payload, 'phase', {
      get() {
        throw new Error('phase getter must not escape');
      },
    });
    Object.defineProperty(payload, 'retryAfterMs', {
      get() {
        throw new Error('retry getter must not escape');
      },
    });

    expect(() => classifyOutboundFailure(
      { payload },
      {
        nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
        retryOwner: 'agent_queue',
        attemptsRemaining: 0,
      },
    )).not.toThrow();
  });

  it.each([
    ['legacy prose', 'legacy raw provider text'],
    ['malformed JSON', '{"schema":'],
    ['unknown version', '{"schema":"whatsoup-outbound-failure-v99"}'],
  ])('decodes %s as legacy_unclassified without parsing meaning', (_name, stored) => {
    expect(decodeOutboundFailureEvidence(stored)).toEqual({
      schema: 'legacy_unclassified',
      failure_code: 'outbound.legacy_unclassified',
      evidence_coverage: 'legacy_unclassified',
    });
  });

  it('rejects count contradictions and unknown fields at the codec boundary', () => {
    const evidence = classifyOutboundFailure(
      new Error('synthetic'),
      {
        nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
        retryOwner: 'pending_drainer',
        attemptsRemaining: 0,
      },
    );

    expect(() => encodeOutboundFailureEvidence({
      ...evidence,
      provider_submission_count: evidence.logical_attempt_count + 1,
    })).toThrow(/provider submission/i);
    expect(decodeOutboundFailureEvidence(JSON.stringify({
      ...evidence,
      unexpected: true,
    }))).toEqual({
      schema: 'legacy_unclassified',
      failure_code: 'outbound.legacy_unclassified',
      evidence_coverage: 'legacy_unclassified',
    });
    expect(() => encodeOutboundFailureEvidence({
      ...evidence,
      retryable: true,
      retry_decision: 'retry_not_before',
      retry_not_before: '2026-07-28T00:01:00.000Z',
      retry_owner: 'pending_drainer',
      attempt_budget_disposition: 'preserve',
    })).toThrow(/deferred retry evidence/i);
    expect(decodeOutboundFailureEvidence(
      encodeOutboundFailureEvidence(evidence),
    )).toEqual(evidence);
  });
});

// GAP 2(a): unit coverage for outboundFailureWarrantsUserNotice directly.
// The predicate already exists and is exercised end-to-end via the runtime
// tests — these are PINNING tests (the underlying logic is already correct;
// there is no RED state to reproduce), added to close the missing unit-test
// gap the delta review flagged, especially the riskiest silence case: a
// RETRYABLE class that still reaches retry_decision 'stop' once attempts are
// exhausted must not be mistaken for a notice-worthy rejection just because
// its retry_decision matches the allowlist's gate value.
describe('outboundFailureWarrantsUserNotice', () => {
  it('is true for payload_too_large at stop (message-specific, channel-healthy)', () => {
    expect(outboundFailureWarrantsUserNotice({
      retry_decision: 'stop',
      failure_code: 'transport.payload_too_large',
    })).toBe(true);
  });

  it('is true for unsupported_capability at stop (message-specific, channel-healthy)', () => {
    expect(outboundFailureWarrantsUserNotice({
      retry_decision: 'stop',
      failure_code: 'transport.unsupported_capability',
    })).toBe(true);
  });

  it('is false for a retryable transient_provider failure that reaches stop only because attempts are exhausted', () => {
    // The riskiest silence case: retry_decision alone is NOT a safe gate —
    // classifyOutboundFailure produces 'stop' for this class too once
    // attemptsRemaining hits 0, even though retryable stays true. Build the
    // evidence via the real classifier (not a hand-typed object) so this
    // test proves the actual integration, not an assumption about its shape.
    const evidence = classifyOutboundFailure(
      new TransientProviderError({ ...base, phase: 'provider_call_started' }),
      {
        nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
        retryOwner: 'agent_queue',
        attemptsRemaining: 0,
      },
    );

    expect(evidence).toMatchObject({ retry_decision: 'stop', retryable: true });
    expect(outboundFailureWarrantsUserNotice(evidence)).toBe(false);
  });

  it('is false for a deferred retry (retry_not_before set) regardless of failure class', () => {
    const evidence = classifyOutboundFailure(
      new RateLimitedError({ ...base, phase: 'not_started', retryAfterMs: 60_000 }),
      {
        nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
        retryOwner: 'agent_queue',
        attemptsRemaining: 2,
      },
    );

    expect(evidence.retry_decision).toBe('retry_not_before');
    expect(outboundFailureWarrantsUserNotice(evidence)).toBe(false);
  });

  it('is false for excluded classes even at stop: auth, ambiguous, and permanent-provider fallback', () => {
    const auth = classifyOutboundFailure(
      new AuthRequiredError({ ...base, phase: 'provider_call_started' }),
      { nowMs: Date.parse('2026-07-28T00:00:00.000Z'), retryOwner: 'agent_queue', attemptsRemaining: 2 },
    );
    const ambiguous = classifyOutboundFailure(
      new SendAmbiguousError({ ...base, phase: 'ack_received' }),
      { nowMs: Date.parse('2026-07-28T00:00:00.000Z'), retryOwner: 'agent_queue', attemptsRemaining: 2 },
    );
    const unknown = classifyOutboundFailure(
      new Error('unclassified synthetic failure'),
      { nowMs: Date.parse('2026-07-28T00:00:00.000Z'), retryOwner: 'agent_queue', attemptsRemaining: 0 },
    );

    for (const evidence of [auth, ambiguous, unknown]) {
      expect(evidence.retry_decision).toBe('stop');
      expect(outboundFailureWarrantsUserNotice(evidence)).toBe(false);
    }
  });

  it('confirms PayloadTooLargeError and UnsupportedCapabilityError classify to stop end-to-end (not just the predicate)', () => {
    const tooLarge = classifyOutboundFailure(
      new PayloadTooLargeError({ ...base, phase: 'not_started' }),
      { nowMs: Date.parse('2026-07-28T00:00:00.000Z'), retryOwner: 'agent_queue', attemptsRemaining: 2 },
    );
    const unsupported = classifyOutboundFailure(
      new UnsupportedCapabilityError({ ...base, phase: 'not_started' }),
      { nowMs: Date.parse('2026-07-28T00:00:00.000Z'), retryOwner: 'agent_queue', attemptsRemaining: 2 },
    );

    for (const evidence of [tooLarge, unsupported]) {
      expect(evidence).toMatchObject({ retry_decision: 'stop', mutation_state: 'not_started' });
      expect(outboundFailureWarrantsUserNotice(evidence)).toBe(true);
    }
  });
});

describe('outbound failure durability contract', () => {
  function makeEngine(): { db: Database; engine: DurabilityEngine; opId: number } {
    const db = new Database(':memory:');
    db.open();
    const engine = new DurabilityEngine(db);
    const opId = engine.createOutboundOp({
      conversationKey: 'synthetic-conversation',
      chatJid: 'synthetic@s.whatsapp.net',
      opType: 'text',
      payload: JSON.stringify({ text: 'synthetic text' }),
      replayPolicy: 'safe',
    });
    return { db, engine, opId };
  }

  it('writes typed evidence and attempt count atomically without raw prose', () => {
    const { db, engine, opId } = makeEngine();
    const marker = 'private-provider-prose-marker';
    const evidence = classifyOutboundFailure(new Error(marker), {
      nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
      retryOwner: 'send_tracked',
      attemptsRemaining: 0,
    });

    engine.markMaybeSent(opId, evidence);

    const stored = db.raw.prepare(
      'SELECT status, error, retry_count FROM outbound_ops WHERE id = ?',
    ).get(opId) as { status: string; error: string; retry_count: number };
    expect(stored.status).toBe('maybe_sent');
    expect(stored.retry_count).toBe(1);
    expect(stored.error).not.toContain(marker);
    expect(JSON.parse(stored.error)).toMatchObject({
      schema: 'whatsoup-outbound-failure-v1',
      failure_code: 'outbound.unknown_failure',
    });
    db.close();
  });

  it('rejects contradictory status and evidence transitions', () => {
    const { db, engine, opId } = makeEngine();
    const rejected = classifyOutboundFailure(
      new AuthRequiredError({
        ...base,
        phase: 'provider_call_started',
      }),
      {
        nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
        retryOwner: 'send_tracked',
        attemptsRemaining: 0,
      },
    );

    expect(() => engine.markMaybeSent(opId, rejected)).toThrow(/ambiguous mutation/i);
    expect(db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(opId))
      .toMatchObject({ status: 'pending' });
    db.close();
  });

  it('refuses to terminalize evidence still owned by an active retry loop', () => {
    const { db, engine, opId } = makeEngine();
    const retryNow = classifyOutboundFailure(
      new RateLimitedError({
        ...base,
        phase: 'provider_call_started',
      }),
      {
        nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
        retryOwner: 'agent_queue',
        attemptsRemaining: 2,
      },
    );

    expect(retryNow).toMatchObject({
      failure_code: 'transport.rate_limited',
      stage: 'provider_response',
      mutation_state: 'rejected',
      retryable: true,
      retry_decision: 'retry_now',
      retry_owner: 'agent_queue',
      attempt_budget_disposition: 'consume',
      logical_attempt_count: 1,
      provider_submission_count: 1,
      evidence_coverage: 'complete',
    });
    expect(() => persistOutboundFailureDisposition(engine, opId, retryNow))
      .toThrow(/active retry owner/i);
    expect(db.raw.prepare('SELECT status FROM outbound_ops WHERE id = ?').get(opId))
      .toMatchObject({ status: 'pending' });
    db.close();
  });

  it('preserves typed evidence across restart and recovery reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-outbound-evidence-'));
    const dbPath = join(dir, 'durability.db');
    try {
      const firstDb = new Database(dbPath);
      firstDb.open();
      const firstEngine = new DurabilityEngine(firstDb);
      const opId = firstEngine.createOutboundOp({
        conversationKey: 'synthetic-conversation',
        chatJid: 'synthetic@s.whatsapp.net',
        opType: 'text',
        payload: JSON.stringify({ text: 'synthetic text' }),
        replayPolicy: 'unsafe',
      });
      firstEngine.markFailedPermanent(opId, classifyOutboundFailure(
        new AuthRequiredError({
          ...base,
          phase: 'provider_call_started',
        }),
        {
          nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
          retryOwner: 'send_tracked',
          attemptsRemaining: 0,
        },
      ));
      firstDb.close();

      const reopenedDb = new Database(dbPath);
      reopenedDb.open();
      const reopenedEngine = new DurabilityEngine(reopenedDb);
      expect(reopenedEngine.getOutboundByStatus('failed_permanent')).toContainEqual(
        expect.objectContaining({
          id: opId,
          status: 'failed_permanent',
          retry_count: 1,
          failure_evidence: expect.objectContaining({
            failure_code: 'transport.auth_required',
            stage: 'provider_response',
            mutation_state: 'rejected',
            provider_submission_count: 1,
          }),
        }),
      );
      reopenedDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves an absolute producer deadline and single retry owner across restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsoup-outbound-defer-'));
    const dbPath = join(dir, 'durability.db');
    try {
      const firstDb = new Database(dbPath);
      firstDb.open();
      const firstEngine = new DurabilityEngine(firstDb);
      const opId = firstEngine.createOutboundOp({
        conversationKey: 'synthetic-conversation',
        chatJid: 'synthetic@s.whatsapp.net',
        opType: 'text',
        payload: JSON.stringify({ text: 'synthetic text' }),
        replayPolicy: 'safe',
      });
      const evidence = classifyOutboundFailure(
        new RateLimitedError({
          ...base,
          phase: 'not_started',
          retryAfterMs: 60_000,
        }),
        {
          retryOwner: 'agent_queue',
          attemptsRemaining: 2,
        },
      );
      firstEngine.markDeferred(opId, evidence);
      firstDb.close();

      const reopenedDb = new Database(dbPath);
      reopenedDb.open();
      const reopenedEngine = new DurabilityEngine(reopenedDb);
      const reopened = reopenedEngine.getOutboundByStatus('pending')
        .find((row) => row.id === opId);
      expect(reopened?.failure_evidence).toMatchObject({
        retry_decision: 'retry_not_before',
        retry_not_before: evidence.retry_not_before,
        retry_owner: 'pending_drainer',
        logical_attempt_count: 1,
        provider_submission_count: 0,
      });
      reopenedDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sendTracked stops typed terminal rejection and persists definitive evidence', async () => {
    const { db, engine, opId } = makeEngine();
    db.raw.prepare('DELETE FROM outbound_ops WHERE id = ?').run(opId);
    let sends = 0;
    const messenger: Messenger = {
      async sendMessage() {
        sends += 1;
        throw new AuthRequiredError({
          ...base,
          phase: 'provider_call_started',
        });
      },
      async sendMedia() {
        return { waMessageId: null };
      },
    };

    await expect(sendTracked(
      messenger,
      'synthetic@s.whatsapp.net',
      'synthetic',
      engine,
      { replayPolicy: 'safe' },
    )).rejects.toBeInstanceOf(AuthRequiredError);

    expect(sends).toBe(1);
    expect(engine.getOutboundByStatus('failed_permanent')).toContainEqual(
      expect.objectContaining({
        retry_count: 1,
        failure_evidence: expect.objectContaining({
          failure_code: 'transport.auth_required',
          mutation_state: 'rejected',
          provider_submission_count: 1,
        }),
      }),
    );
    db.close();
  });

  it('sendTracked terminalizes an identity guard block without persisting guard prose', async () => {
    const { db, engine, opId } = makeEngine();
    db.raw.prepare('DELETE FROM outbound_ops WHERE id = ?').run(opId);
    const marker = 'identity-guard-send-tracked-marker';
    const error = new OutboundIdentityError('COLD_TARGET', marker);
    let sends = 0;
    const messenger: Messenger = {
      async sendMessage() {
        sends += 1;
        throw error;
      },
      async sendMedia() {
        return { waMessageId: null };
      },
    };

    await expect(sendTracked(
      messenger,
      'synthetic@s.whatsapp.net',
      'synthetic',
      engine,
      { replayPolicy: 'safe' },
    )).rejects.toBe(error);

    expect(sends).toBe(1);
    const stored = db.raw.prepare(
      'SELECT status, error FROM outbound_ops ORDER BY id DESC LIMIT 1',
    ).get() as { status: string; error: string };
    expect(stored.status).toBe('failed_permanent');
    expect(stored.error).not.toContain(marker);
    expect(JSON.parse(stored.error)).toMatchObject({
      failure_code: 'outbound.identity_blocked',
      mutation_state: 'not_started',
      provider_submission_count: 0,
    });
    db.close();
  });

  it('sendTracked durably defers a local producer floor and the drainer skips it', async () => {
    const { db, engine, opId } = makeEngine();
    db.raw.prepare('DELETE FROM outbound_ops WHERE id = ?').run(opId);
    let sends = 0;
    const messenger: Messenger = {
      async sendMessage() {
        sends += 1;
        throw new RateLimitedError({
          ...base,
          phase: 'not_started',
          retryAfterMs: 60_000,
        });
      },
      async sendMedia() {
        return { waMessageId: null };
      },
    };

    await expect(sendTracked(
      messenger,
      'synthetic@s.whatsapp.net',
      'synthetic',
      engine,
      { replayPolicy: 'safe' },
    )).rejects.toBeInstanceOf(RateLimitedError);
    expect(sends).toBe(1);

    const deferred = engine.getOutboundByStatus('pending').find(
      (row) => row.failure_evidence.schema === 'whatsoup-outbound-failure-v1'
        && row.failure_evidence.failure_code === 'transport.rate_limited',
    );
    expect(deferred).toMatchObject({
      retry_count: 1,
      failure_evidence: {
        retry_decision: 'retry_not_before',
        retry_owner: 'pending_drainer',
        provider_submission_count: 0,
      },
    });
    expect(engine.getHealthStats().outboundFailureEvidence.groups).toContainEqual(
      expect.objectContaining({
        failureCode: 'transport.rate_limited',
        mutationState: 'not_started',
        terminalState: 'pending',
        retryDecision: 'retry_not_before',
        retryOwner: 'pending_drainer',
        remainingDelayBucket: expect.stringMatching(/^(under_1m|1m_to_5m)$/),
        nextEligibleAt: expect.any(String),
        providerSubmissionCount: 0,
      }),
    );

    await expect(drainPendingOutbound(messenger, engine)).resolves.toEqual({
      resent: 0,
      expired: 0,
    });
    expect(sends).toBe(1);
    db.close();
  });

  it('the pending drainer sends a deferred op once its absolute floor is due', async () => {
    const { db, engine, opId } = makeEngine();
    const evidence = classifyOutboundFailure(
      new RateLimitedError({
        ...base,
        phase: 'not_started',
        retryAfterMs: 1_000,
      }),
      {
        nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
        retryOwner: 'agent_queue',
        attemptsRemaining: 2,
      },
    );
    engine.markDeferred(opId, evidence);
    const messenger: Messenger = {
      async sendMessage() {
        return { waMessageId: 'synthetic-due-receipt' };
      },
      async sendMedia() {
        return { waMessageId: null };
      },
    };

    await expect(drainPendingOutbound(messenger, engine)).resolves.toEqual({
      resent: 1,
      expired: 0,
    });
    expect(db.raw.prepare(
      'SELECT status, retry_count, error FROM outbound_ops WHERE id = ?',
    ).get(opId)).toMatchObject({
      status: 'submitted',
      retry_count: 2,
      error: null,
    });
    db.close();
  });

  it('sendTracked strips prose from an untyped thrown error end to end', async () => {
    const { db, engine, opId } = makeEngine();
    db.raw.prepare('DELETE FROM outbound_ops WHERE id = ?').run(opId);
    const marker = 'private-send-tracked-provider-marker';
    const messenger: Messenger = {
      async sendMessage() {
        throw new Error(marker);
      },
      async sendMedia() {
        return { waMessageId: null };
      },
    };

    await expect(sendTracked(
      messenger,
      'synthetic@s.whatsapp.net',
      'synthetic',
      engine,
      { replayPolicy: 'unsafe' },
    )).rejects.toThrow(marker);

    const stored = db.raw.prepare(
      'SELECT status, error FROM outbound_ops ORDER BY id DESC LIMIT 1',
    ).get() as { status: string; error: string };
    expect(stored.status).toBe('maybe_sent');
    expect(stored.error).not.toContain(marker);
    expect(JSON.parse(stored.error)).toMatchObject({
      failure_code: 'outbound.unknown_failure',
      evidence_coverage: 'partial',
    });
    db.close();
  });

  it('returns status, retry count, and decoded evidence from recovery reads', () => {
    const { db, engine, opId } = makeEngine();
    const evidence = classifyOutboundFailure(
      new RateLimitedError({
        ...base,
        phase: 'not_started',
        retryAfterMs: 60_000,
      }),
      {
        nowMs: Date.parse('2026-07-28T00:00:00.000Z'),
        retryOwner: 'agent_queue',
        attemptsRemaining: 2,
      },
    );

    engine.markDeferred(opId, evidence);

    expect(engine.getOutboundByStatus('pending')).toContainEqual(
      expect.objectContaining({
        id: opId,
        status: 'pending',
        retry_count: 1,
        failure_evidence: expect.objectContaining({
          retry_not_before: '2026-07-28T00:01:00.000Z',
          retry_owner: 'pending_drainer',
        }),
      }),
    );
    db.close();
  });

  it('decodes historical prose as legacy without rewriting or parsing it', () => {
    const { db, engine, opId } = makeEngine();
    db.raw.prepare(
      "UPDATE outbound_ops SET status = 'maybe_sent', error = ? WHERE id = ?",
    ).run('legacy auth retry after 60000 marker', opId);

    expect(engine.getOutboundByStatus('maybe_sent')).toContainEqual(
      expect.objectContaining({
        id: opId,
        failure_evidence: {
          schema: 'legacy_unclassified',
          failure_code: 'outbound.legacy_unclassified',
          evidence_coverage: 'legacy_unclassified',
        },
      }),
    );
    db.close();
  });

  it('records successful logical attempt completion on the submitted transition', () => {
    const { db, engine, opId } = makeEngine();
    engine.markSending(opId);
    engine.markSubmitted(opId, 'synthetic-wa-id', 2);

    expect(db.raw.prepare(
      'SELECT status, retry_count, error FROM outbound_ops WHERE id = ?',
    ).get(opId)).toMatchObject({
      status: 'submitted',
      retry_count: 2,
      error: null,
    });
    db.close();
  });
});
