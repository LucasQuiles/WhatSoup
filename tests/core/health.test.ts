import { httpReq, TEST_HEALTH_TOKEN, healthReq, buildTestServer, makeDb, makeDeps, makeAuthBond, STARTUP_NOTIFICATION_KEYS, startupNotificationHealth } from './_helpers/health.ts';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CURRENT_SCHEMA_MIGRATION, Database } from '../../src/core/database.ts';
import { recordContinuityGaps } from '../../src/core/continuity-gap-ledger.ts';
import { gapObservation, insertClosureRow, recordGaps, signedClosure } from './_helpers/continuity-gap-closure.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import { createInternalOutboundFailureEvidence } from '../../src/core/outbound-failure-disposition.ts';
import { config } from '../../src/config.ts';
import { emitHealReport, resetDeliveryUnavailableLatch } from '../../src/core/heal.ts';
import type { Messenger } from '../../src/core/types.ts';
import type { HealthDeps } from '../../src/core/health.ts';
import { HEALTH_DEGRADATION_CAUSE_REASON_TWINS, NO_REASON_TWIN } from '../../src/core/health.ts';
import { ConnectionManager } from '../../src/transport/connection.ts';
import { emptyConnectionStateSnapshot } from '../../src/transport/twilio/connection-snapshot.ts';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;
  let prevGitSha: string | undefined;
  let prevGitBranch: string | undefined;

  beforeEach(async () => {
    prevGitSha = process.env.WHATSOUP_GIT_SHA;
    prevGitBranch = process.env.WHATSOUP_GIT_BRANCH;
    delete process.env.WHATSOUP_GIT_SHA;
    delete process.env.WHATSOUP_GIT_BRANCH;
    db = makeDb();
    // #2515: the diagnostic projection is now bearer-gated; set a test token so
    // existing diagnostic tests can reach it via healthReq(). Unauthenticated
    // callers get only the public liveness envelope (canaries below).
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
    ({ server, port } = await buildTestServer(makeDeps(db)));
  });

  afterEach(async () => {
    db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    if (prevGitSha === undefined) delete process.env.WHATSOUP_GIT_SHA;
    else process.env.WHATSOUP_GIT_SHA = prevGitSha;
    if (prevGitBranch === undefined) delete process.env.WHATSOUP_GIT_BRANCH;
    else process.env.WHATSOUP_GIT_BRANCH = prevGitBranch;
  });

  it('always emits the exact privacy-safe startup notification health shape when not applicable', async () => {
    const { status, body } = await healthReq(port);

    expect(status).toBe(200);
    expect(JSON.parse(body).startupNotification).toEqual({
      state: 'not_applicable',
      policy: 'none',
      stabilitySeconds: null,
      bootCountSinceNotification: null,
      lastBootAt: null,
      lastNotifiedAt: null,
      nextEligibleAt: null,
      lastSendAt: null,
    });
  });

  it.each([
    ['not_applicable', 'none'],
    ['disabled', 'disabled'],
    ['waiting_stability', 'generic'],
    ['waiting_transport', 'resume'],
    ['dispatching', 'restart_loop_guard_alert'],
    ['sent', 'expired_session_notice'],
    ['send_failed', 'intentional_restart'],
    ['journal_unreadable', 'generic'],
  ] as const)('retains the exact startup notification state and policy %s/%s without exposing private data', async (state, policy) => {
    db.close();
    const db2 = makeDb();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(makeDeps(db2, {
      getStartupNotificationHealth: () => startupNotificationHealth({ state, policy }),
    })));

    const { status, body } = await healthReq(port);
    const startupNotification = JSON.parse(body).startupNotification as Record<string, unknown>;

    expect(status).toBe(200);
    expect(Object.keys(startupNotification).sort()).toEqual([...STARTUP_NOTIFICATION_KEYS].sort());
    expect(startupNotification).toMatchObject({ state, policy });
    expect(JSON.stringify(startupNotification)).not.toMatch(
      /jid|identity|message|text|path|error|bot\.db/i,
    );
    db2.close();
  });

  it.each(['waiting_stability', 'waiting_transport', 'send_failed'] as const)(
    'does not degrade normal service health solely for startup notification %s',
    async (state) => {
      db.close();
      const db2 = makeDb();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      ({ server, port } = await buildTestServer(makeDeps(db2, {
        getStartupNotificationHealth: () => startupNotificationHealth({ state }),
      })));

      const { status, body } = await healthReq(port);
      expect(status).toBe(200);
      expect(JSON.parse(body)).toMatchObject({
        status: 'healthy',
        startupNotification: { state },
      });
      db2.close();
    },
  );

  it('returns 200 with healthy status when connected', async () => {
    const requestedAt = Date.now();
    const { status, body } = await healthReq(port);
    const receivedAt = Date.now();
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('healthy');
    expect(json.whatsapp.connected).toBe(true);
    expect(typeof json.uptime_seconds).toBe('number');
    expect(typeof json.generated_at).toBe('string');
    const generatedAt = Date.parse(json.generated_at);
    expect(Number.isNaN(generatedAt)).toBe(false);
    expect(generatedAt).toBeGreaterThanOrEqual(requestedAt);
    expect(generatedAt).toBeLessThanOrEqual(receivedAt);
  });

  it('projects content-free consolidation failure health only to authenticated diagnostics', async () => {
    const consolidationHealth = {
      schema_version: 1 as const,
      readable: true,
      state: 'failed' as const,
      mode: 'live' as const,
      latest_status: 'failed' as const,
      latest_stage: 'write' as const,
      failure_code: 'network_error' as const,
      retryable: true,
      evidence_coverage: 'provider_error' as const,
      latest_attempt_at: 1_785_240_000_000,
      latest_success_at: null,
      active_age_ms: null,
      skipped_ticks: 2,
      counters: {
        recordsObserved: 3,
        clustersAttempted: 1,
        clustersCompleted: 0,
        wouldPromote: 0,
        writeAttempted: 1,
        writeConfirmed: 0,
        discarded: 0,
        failed: 1,
        skipped: 2,
      },
    };
    const { server: server2, port: port2 } = await buildTestServer(makeDeps(db, {
      getMemoryConsolidationHealth: () => consolidationHealth,
    }));
    try {
      const diagnostic = await healthReq(port2);
      expect(diagnostic.status).toBe(200);
      const json = JSON.parse(diagnostic.body);
      expect(json.status).toBe('degraded');
      expect(json.degradation_causes).toContain('memory_consolidation_degraded');
      expect(json.memory.consolidation).toEqual(consolidationHealth);

      for (const forbidden of [
        'private-memory-text',
        'private-claim',
        'private-source-id',
        'private-chat-id',
        'private-sender-id',
        'private-model-output',
        'private-raw-exception',
        'private-content-hash',
        'private-credential',
      ]) {
        expect(diagnostic.body).not.toContain(forbidden);
      }

      const publicResponse = await httpReq(port2, '/health', 'GET');
      expect(JSON.parse(publicResponse.body)).not.toHaveProperty('memory');
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('degrades authenticated health when consolidation is enabled but has not started', async () => {
    const consolidationHealth = {
      schema_version: 1 as const,
      readable: true,
      state: 'not_started' as const,
      mode: null,
      latest_status: null,
      latest_stage: null,
      failure_code: 'none' as const,
      retryable: false,
      evidence_coverage: 'not_observed' as const,
      latest_attempt_at: null,
      latest_success_at: null,
      active_age_ms: null,
      skipped_ticks: 0,
      counters: {
        recordsObserved: 0,
        clustersAttempted: 0,
        clustersCompleted: 0,
        wouldPromote: 0,
        writeAttempted: 0,
        writeConfirmed: 0,
        discarded: 0,
        failed: 0,
        skipped: 0,
      },
    };
    const { server: server2, port: port2 } = await buildTestServer(makeDeps(db, {
      getMemoryConsolidationHealth: () => consolidationHealth,
    }));
    try {
      const diagnostic = await healthReq(port2);
      const json = JSON.parse(diagnostic.body);
      expect(diagnostic.status).toBe(200);
      expect(json.status).toBe('degraded');
      expect(json.degradation_causes).toContain('memory_consolidation_degraded');
      expect(json.memory.consolidation).toEqual(consolidationHealth);
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('projects redacted readiness and context failures only to authenticated diagnostics', async () => {
    const readiness = {
      state: 'unknown' as const,
      observedAt: '2026-07-29T20:00:00.000Z',
      failureCode: 'unknown' as const,
      retryable: true,
      evidenceCoverage: 'provider_error' as const,
      index: 'SYNTHETIC_PRIVATE_MEMORY_TARGET',
      rawError: 'SYNTHETIC_PRIVATE_PROVIDER_ERROR',
    };
    let readinessReads = 0;
    const memoryContext = {
      status: 'partial' as const,
      scopes: [
        {
          scope: 'chat' as const,
          status: 'failed' as const,
          failureCode: 'network_error' as const,
          retryable: true,
        },
        {
          scope: 'sender' as const,
          status: 'ok' as const,
          failureCode: null,
          retryable: false,
        },
      ],
    };
    const { server: server2, port: port2 } = await buildTestServer(makeDeps(db, {
      getMemoryReadinessHealth: () => {
        readinessReads += 1;
        return readiness;
      },
      getMemoryContextHealth: () => memoryContext,
    }));
    try {
      const diagnostic = await healthReq(port2);
      const json = JSON.parse(diagnostic.body);
      expect(diagnostic.status).toBe(200);
      expect(json.status).toBe('degraded');
      expect(json.degradation_causes).toContain('memory_readiness_degraded');
      expect(json.degradation_causes).toContain('memory_context_degraded');
      expect(json.memory.readiness).toEqual({
        state: 'unknown',
        observed_at: '2026-07-29T20:00:00.000Z',
        failure_code: 'unknown',
        retryable: true,
        evidence_coverage: 'provider_error',
      });
      expect(json.memory.context).toEqual({
        status: 'partial',
        scopes: [
          { scope: 'chat', status: 'failed', failure_code: 'network_error', retryable: true },
          { scope: 'sender', status: 'ok', failure_code: null, retryable: false },
        ],
      });
      expect(diagnostic.body).not.toContain('SYNTHETIC_PRIVATE_MEMORY_TARGET');
      expect(diagnostic.body).not.toContain('SYNTHETIC_PRIVATE_PROVIDER_ERROR');

      const publicResponse = await httpReq(port2, '/health', 'GET');
      expect(JSON.parse(publicResponse.body)).not.toHaveProperty('memory');
      expect(readinessReads).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('does not degrade health for an explicitly disabled memory readiness probe', async () => {
    const { server: server2, port: port2 } = await buildTestServer(makeDeps(db, {
      getMemoryReadinessHealth: () => ({
        state: 'disabled',
        observedAt: '2026-07-29T20:00:00.000Z',
        failureCode: 'none',
        retryable: false,
        evidenceCoverage: 'local_guard',
      }),
    }));
    try {
      const diagnostic = await healthReq(port2);
      const json = JSON.parse(diagnostic.body);
      expect(diagnostic.status).toBe(200);
      expect(json.status).toBe('healthy');
      expect(json.degradation_causes).not.toContain('memory_readiness_degraded');
      expect(json.memory.readiness).toEqual({
        state: 'disabled',
        observed_at: '2026-07-29T20:00:00.000Z',
        failure_code: 'none',
        retryable: false,
        evidence_coverage: 'local_guard',
      });
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('degrades and surfaces durability debt when an outbound delivery is stuck in maybe_sent past the stale window (#1865)', async () => {
    const db2 = makeDb();
    const durability = new DurabilityEngine(db2);
    const id = durability.createOutboundOp({ conversationKey: 'k', chatJid: 'j', opType: 'text', payload: '{}', replayPolicy: 'unsafe' });
    durability.markSending(id);
    durability.markSubmitted(id, 'WA_MSG_1865');
    durability.markMaybeSent(id, 'echo_timeout');
    // One hour unresolved — well past the stale window.
    db2.raw
      .prepare(`UPDATE outbound_ops SET ambiguity_at = datetime('now', '-3600 seconds') WHERE id = ?`)
      .run(id);

    const { server: server2, port: port2 } = await buildTestServer(makeDeps(db2, { durability }));
    try {
      const { status, body } = await healthReq(port2);
      const json = JSON.parse(body);
      // A connected instance is otherwise healthy; the stale maybe_sent must degrade it
      // rather than read green (#1865). Degraded still returns 200.
      expect(status).toBe(200);
      expect(json.status).toBe('degraded');
      expect(json.durability.maybeSentOutbound).toBe(1);
      expect(json.durability.oldestMaybeSentAt).not.toBeNull();
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
      db2.close();
    }
  });

  it('keeps a stale corroborated maybe_sent delivery as retained debt without degrading service', async () => {
    const db2 = makeDb();
    const durability = new DurabilityEngine(db2);
    const conversationKey = 'health-corroborated-conversation';
    const deliveryJid = 'health-corroborated@g.us';
    const inboundSeq = durability.journalInbound(
      'health-corroborated-message',
      conversationKey,
      deliveryJid,
      'agent',
    );
    const selectedOpId = durability.createOutboundOp({
      conversationKey,
      chatJid: deliveryJid,
      opType: 'text',
      payload: '{}',
      replayPolicy: 'unsafe',
      sourceInboundSeq: inboundSeq,
      isTerminal: true,
    });
    durability.markSending(selectedOpId);
    durability.markMaybeSent(selectedOpId, 'transport result unknown');
    db2.raw.prepare(
      "UPDATE outbound_ops SET ambiguity_at = datetime('now', '-3600 seconds') WHERE id = ?",
    ).run(selectedOpId);
    db2.raw.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation, attempt_kind,
        inbound_disposition, delivery_kind, delivery_op_id,
        reply_guarantee_disarmed
      ) VALUES ('per_chat', ?, ?, ?, ?, 'health-corroborated-turn',
                'health-corroborated-manager', 1, 'failed', 'failed_terminal',
                'delivery_unknown', ?, 0)
    `).run(conversationKey, deliveryJid, inboundSeq, inboundSeq, selectedOpId);
    const corroboratingOpId = durability.createOutboundOp({
      conversationKey,
      chatJid: deliveryJid,
      opType: 'text',
      payload: '{}',
      replayPolicy: 'unsafe',
      sourceInboundSeq: inboundSeq,
    });
    durability.markSending(corroboratingOpId);
    durability.markSubmitted(corroboratingOpId, 'WA_HEALTH_CORROBORATED');
    durability.markEchoed(corroboratingOpId);
    durability.postConnectRecovery();

    const { server: server2, port: port2 } = await buildTestServer(makeDeps(db2, { durability }));
    try {
      const { status, body } = await healthReq(port2);
      const json = JSON.parse(body);
      expect(status).toBe(200);
      expect(json.status).toBe('healthy');
      expect(json.status_reasons).toEqual([]);
      expect(json.recovery_debt).toMatchObject({
        open: true,
        service_blocking: false,
        attention: 'routine',
        reasons: ['corroborated_delivery_retained'],
        delivery: {
          blocking_ambiguous: 0,
          uncorroborated_ambiguous: 0,
          corroborated_retained: 1,
          oldest_uncorroborated_at: null,
        },
      });
      expect(json.durability.oldestMaybeSentAt).not.toBeNull();
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
      db2.close();
    }
  });

  it('projects only the redacted quarantine aggregate to authenticated health diagnostics', async () => {
    const db2 = makeDb();
    const durability = new DurabilityEngine(db2);
    const id = durability.createOutboundOp({
      conversationKey: 'private-health-conversation',
      chatJid: 'private-health-destination',
      opType: 'media',
      payload: '{"private":"health payload"}',
      replayPolicy: 'unsafe',
    });
    durability.markQuarantined(id, createInternalOutboundFailureEvidence({
      failureCode: 'outbound.pending_replay_unreconstructable',
      stage: 'admission',
      mutationState: 'not_started',
      providerSubmissionCount: 0,
    }));

    const { server: server2, port: port2 } = await buildTestServer(makeDeps(db2, { durability }));
    try {
      const diagnostic = await healthReq(port2);
      expect(diagnostic.status).toBe(200);
      expect(JSON.parse(diagnostic.body).durability.outboundQuarantineDispositions).toEqual({
        total: 1,
        groups: [{
          disposition: 'record_unreconstructable',
          evidenceCoverage: 'complete',
          count: 1,
        }],
      });
      expect(diagnostic.body).not.toContain('private-health');

      const publicResponse = await httpReq(port2, '/health', 'GET');
      expect(publicResponse.status).toBe(200);
      expect(JSON.parse(publicResponse.body)).not.toHaveProperty('durability');
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
      db2.close();
    }
  });

  it('keeps the quarantine aggregate total equal to its groups across a concurrent transition', () => {
    const db2 = makeDb();
    const durability = new DurabilityEngine(db2);
    const statements = (durability as unknown as {
      statements: { getQuarantinedOutboundCount: { get: () => { count: number } } };
    }).statements;
    const originalCount = statements.getQuarantinedOutboundCount;
    let transitioned = false;
    statements.getQuarantinedOutboundCount = {
      get: () => {
        const count = originalCount.get();
        if (!transitioned) {
          transitioned = true;
          const id = durability.createOutboundOp({
            conversationKey: 'interleaved', chatJid: 'interleaved@g.us', opType: 'text',
            payload: '{}', replayPolicy: 'unsafe',
          });
          durability.markQuarantined(id, createInternalOutboundFailureEvidence({
            failureCode: 'outbound.deferral_limit_exceeded',
            stage: 'admission',
            mutationState: 'not_started',
            providerSubmissionCount: 0,
          }));
        }
        return count;
      },
    };

    const aggregate = durability.getHealthStats().outboundQuarantineDispositions;

    expect(aggregate.total).toBe(aggregate.groups.reduce((total, group) => total + group.count, 0));
    db2.close();
  });

  it('degrades instead of treating malformed ambiguity chronology as fresh (#2343)', async () => {
    const db2 = makeDb();
    const durability = new DurabilityEngine(db2);
    const id = durability.createOutboundOp({ conversationKey: 'k', chatJid: 'j', opType: 'text', payload: '{}', replayPolicy: 'unsafe' });
    durability.markSending(id);
    durability.markMaybeSent(id, 'malformed chronology');
    db2.raw.prepare("UPDATE outbound_ops SET ambiguity_at = 'not-a-timestamp' WHERE id = ?").run(id);

    const { server: server2, port: port2 } = await buildTestServer(makeDeps(db2, { durability }));
    try {
      const { status, body } = await healthReq(port2);
      const json = JSON.parse(body);
      expect(status).toBe(200);
      expect(json.status).toBe('degraded');
      expect(json.durability).toMatchObject({ maybeSentOutbound: 1 });
      expect(json.durability.oldestMaybeSentAt).not.toBeNull();
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
      db2.close();
    }
  });

  it('degrades instead of treating a future ambiguity episode as fresh (#2343)', async () => {
    const db2 = makeDb();
    const durability = new DurabilityEngine(db2);
    const id = durability.createOutboundOp({ conversationKey: 'k', chatJid: 'j', opType: 'text', payload: '{}', replayPolicy: 'unsafe' });
    durability.markSending(id);
    durability.markMaybeSent(id, 'future chronology');
    db2.raw.prepare("UPDATE outbound_ops SET ambiguity_at = '2099-01-01T00:00:00Z' WHERE id = ?").run(id);

    const { server: server2, port: port2 } = await buildTestServer(makeDeps(db2, { durability }));
    try {
      const { status, body } = await healthReq(port2);
      const json = JSON.parse(body);
      expect(status).toBe(200);
      expect(json.status).toBe('degraded');
      expect(json.durability).toMatchObject({ maybeSentOutbound: 1 });
      expect(json.durability.oldestMaybeSentAt).not.toBe('2099-01-01 00:00:00');
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
      db2.close();
    }
  });

  it('normalizes a parseable ISO ambiguity episode before evaluating health debt (#2343)', async () => {
    const db2 = makeDb();
    const durability = new DurabilityEngine(db2);
    const id = durability.createOutboundOp({ conversationKey: 'k', chatJid: 'j', opType: 'text', payload: '{}', replayPolicy: 'unsafe' });
    durability.markSending(id);
    durability.markMaybeSent(id, 'ISO chronology');
    db2.raw.prepare("UPDATE outbound_ops SET ambiguity_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(id);

    const { server: server2, port: port2 } = await buildTestServer(makeDeps(db2, { durability }));
    try {
      const { status, body } = await healthReq(port2);
      const json = JSON.parse(body);
      expect(status).toBe(200);
      expect(json.status).toBe('degraded');
      expect(json.durability.oldestMaybeSentAt).toBe('2000-01-01 00:00:00');
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
      db2.close();
    }
  });

  it('surfaces control-peer wiring under control_peer when the Q peer is configured', async () => {
    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.control_peer).toEqual({
      configured: true,
      suppressed_unavailable_alerts: 0,
    });
  });

  it('reflects a missing Q peer and the suppressed-alert count after latched heal reports', async () => {
    resetDeliveryUnavailableLatch();
    config.controlPeers.delete('q');
    try {
      const messenger: Messenger = {
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      };
      // Two distinct-class reports: the first fires the (mocked) critical and
      // arms the latch, the second is suppressed and counted.
      emitHealReport(db, messenger, null, { type: 'crash', crashClass: 'provider_unknown' });
      emitHealReport(db, messenger, null, { type: 'crash', crashClass: 'provider_timeout' });

      const { status, body } = await healthReq(port);
      expect(status).toBe(200);
      const json = JSON.parse(body);
      expect(json.control_peer).toEqual({
        configured: false,
        suppressed_unavailable_alerts: 1,
      });
    } finally {
      config.controlPeers.set('q', '15559998888');
      resetDeliveryUnavailableLatch();
    }
  });

  it('binds ARC health to the source checkout and rejects a different explicit root', async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-health-arc.'));
    const prev = process.env.WHATSOUP_REPO_ROOT;
    process.env.WHATSOUP_REPO_ROOT = repoRoot;
    try {
      const mismatch = await healthReq(port);
      expect(JSON.parse(mismatch.body).arc).toEqual({
        loaded: false,
        reason: 'repository root invalid',
      });

      delete process.env.WHATSOUP_REPO_ROOT;
      const sourceAnchored = await healthReq(port);
      expect(sourceAnchored.status).toBe(200);
      expect(JSON.parse(sourceAnchored.body).arc).toMatchObject({
        loaded: true,
        consumer: 'whatsoup',
        payloadSha: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
    } finally {
      if (prev === undefined) {
        delete process.env.WHATSOUP_REPO_ROOT;
      } else {
        process.env.WHATSOUP_REPO_ROOT = prev;
      }
    }
  });

  it('suppresses stale disconnect metadata when the current connection is connected', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(makeDeps(db, {
      connectionManager: {
        botJid: '15555550123@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'connected',
          connected: true,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-04-05T12:00:00.000Z',
          firstFailureAt: null,
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: 'loggedOut',
          lastStatusCode: 401,
          // Required by the snapshot type; a missing window reads as churn.
          recentDisconnects: { windowMs: 600_000, count: 0, lastAt: null, lastReason: null, lastStatusCode: null, byReason: {} },
        }),
      } as unknown as ConnectionManager,
    })));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('healthy');
    expect(json.whatsapp.connection).toMatchObject({
      state: 'connected',
      last_disconnect_reason: null,
      last_status_code: null,
      disconnect_class: 'none',
      auth_failure_class: 'none',
    });
  });

  it('marks a connected instance degraded when recent disconnect churn crosses the threshold', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(makeDeps(db, {
      connectionManager: {
        botJid: '15555550123@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'connected',
          connected: true,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-04-05T12:00:00.000Z',
          firstFailureAt: null,
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          recentDisconnects: {
            windowMs: 600_000,
            count: 3,
            lastAt: '2026-04-05T12:09:00.000Z',
            lastReason: 'connectionReplaced',
            lastStatusCode: 440,
            byReason: { connectionReplaced: 3 },
          },
        }),
      } as unknown as ConnectionManager,
    })));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.whatsapp.connection).toMatchObject({
      state: 'connected',
      last_disconnect_reason: null,
      last_status_code: null,
      recent_disconnects: {
        window_ms: 600_000,
        degraded_threshold: 3,
        count: 3,
        last_at: '2026-04-05T12:09:00.000Z',
        last_reason: 'connectionReplaced',
        last_status_code: 440,
        by_reason: { connectionReplaced: 3 },
      },
    });
  });

  it('marks a connected instance degraded and surfaces outbound_flood when a flood is active (T3.3)', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(makeDeps(db, {
      connectionManager: {
        botJid: '15555550123@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'connected',
          connected: true,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-04-05T12:00:00.000Z',
          firstFailureAt: null,
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          recentDisconnects: {
            windowMs: 600_000,
            count: 0, // no churn — only the flood should drive 'degraded'
            lastAt: null,
            lastReason: null,
            lastStatusCode: null,
            byReason: {},
          },
          outboundFlood: {
            windowMs: 300_000,
            threshold: 20,
            flooding: true,
            destCount: 1,
            worstDestHash: 'abc123def456',
            worstCount: 42,
          },
        }),
      } as unknown as ConnectionManager,
    })));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded'); // the active flood degrades health
    expect(json.whatsapp.connection.outbound_flood).toEqual({
      window_ms: 300_000,
      threshold: 20,
      flooding: true,
      dest_count: 1,
      worst_dest_hash: 'abc123def456', // redacted hash, never a raw number
      worst_count: 42,
    });
  });

  it('reports pending_polls_total reflecting live rows in the pending_polls table', async () => {
    // Empty table → 0
    const empty = await healthReq(port);
    expect(JSON.parse(empty.body).sqlite.pending_polls_total).toBe(0);

    // Insert two live polls
    const insert = db.raw.prepare(
      `INSERT INTO pending_polls (map_key, chat_jid, tool_id, source, resolution, payload, created_at, closes_at, hard_closes_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    insert.run('send_poll:p1', 'chatA@g.us', 'send_poll:p1', 'send_poll', 'first-vote-wins', '{}', now, now + 60_000, now + 120_000);
    insert.run('send_poll:p2', 'chatB@g.us', 'send_poll:p2', 'send_poll', 'admin-only', '{}', now, now + 60_000, now + 120_000);

    const after = await healthReq(port);
    expect(after.status).toBe(200);
    expect(JSON.parse(after.body).sqlite.pending_polls_total).toBe(2);

    // Deleting one decrements the reported count
    db.raw.prepare('DELETE FROM pending_polls WHERE map_key = ?').run('send_poll:p1');
    const afterDelete = await healthReq(port);
    expect(JSON.parse(afterDelete.body).sqlite.pending_polls_total).toBe(1);
  });

  it('returns 503 with unhealthy status when disconnected', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: null, // not connected
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn(() => emptyConnectionStateSnapshot({
          connected: false,
          stateChangedAt: '2026-07-29T00:00:00.000Z',
          lastDisconnectReason: null,
        })),
      } as unknown as ConnectionManager,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(503);
    const json = JSON.parse(body);
    expect(json.status).toBe('unhealthy');
    db2.close();
  });

  it('returns 200 with degraded status and connection state while reconnecting', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: null,
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'reconnecting',
          connected: false,
          reconnectAttempts: 3,
          reconnectPhase: 'retry',
          lastPingAt: '2026-04-05T12:00:00.000Z',
          lastPongAt: '2026-04-05T11:59:30.000Z',
        }),
      },
    } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.whatsapp.connected).toBe(false);
    expect(json.whatsapp.connection).toMatchObject({
      state: 'reconnecting',
      reconnect_attempts: 3,
      reconnect_phase: 'retry',
      last_ping_at: '2026-04-05T12:00:00.000Z',
      last_pong_at: '2026-04-05T11:59:30.000Z',
    });
    db2.close();
  });

  it('returns 503 when QR pairing is required even while lifecycle state is connecting', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: null,
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'connecting',
          connected: false,
          reconnectAttempts: 0,
          reconnectPhase: 'backoff',
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: '2026-06-09T12:00:00.000Z',
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          credentialLifecycle: {
            lastQrAt: '2026-06-09T12:05:00.000Z',
            lastOpenAt: null,
          },
        }),
      },
    } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(503);
    const json = JSON.parse(body);
    expect(json.status).toBe('unhealthy');
    expect(json.whatsapp.connected).toBe(false);
    expect(json.whatsapp.connection.auth_failure_class).toBe('pairing_required');
    db2.close();
  });

  it('returns 503 when QR pairing is required after a prior successful open', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: null,
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'connecting',
          connected: false,
          reconnectAttempts: 0,
          reconnectPhase: 'backoff',
          stateChangedAt: '2026-06-09T12:10:00.000Z',
          firstFailureAt: '2026-06-09T12:10:00.000Z',
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          authBond: makeAuthBond(),
          credentialLifecycle: {
            lastOpenAt: '2026-06-09T12:00:00.000Z',
            lastCloseAt: '2026-06-09T12:09:00.000Z',
            lastQrAt: '2026-06-09T12:10:00.000Z',
            recentEvents: [
              { event: 'connection_open', at: '2026-06-09T12:00:00.000Z' },
              { event: 'qr_required', at: '2026-06-09T12:10:00.000Z' },
            ],
          },
        }),
      },
    } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(503);
    const json = JSON.parse(body);
    expect(json.status).toBe('unhealthy');
    expect(json.whatsapp.connection.auth_failure_class).toBe('pairing_required');
    db2.close();
  });

  it('keeps normal restart-required reconnects degraded without pairing_required', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: null,
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'reconnecting',
          connected: false,
          reconnectAttempts: 1,
          reconnectPhase: 'retry',
          stateChangedAt: '2026-06-09T12:10:00.000Z',
          firstFailureAt: '2026-06-09T12:10:00.000Z',
          lastPingAt: '2026-06-09T12:09:30.000Z',
          lastPongAt: '2026-06-09T12:09:31.000Z',
          lastDisconnectReason: 'restartRequired',
          lastStatusCode: 515,
          authBond: makeAuthBond(),
          credentialLifecycle: {
            lastOpenAt: '2026-06-09T12:00:00.000Z',
            lastCloseAt: '2026-06-09T12:10:00.000Z',
            lastQrAt: null,
            recentEvents: [
              { event: 'connection_open', at: '2026-06-09T12:00:00.000Z' },
              { event: 'connection_close', at: '2026-06-09T12:10:00.000Z', statusCode: 515, reason: 'restartRequired' },
            ],
          },
        }),
      },
    } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.whatsapp.connected).toBe(false);
    expect(json.whatsapp.connection.disconnect_class).toBe('restart_required');
    expect(json.whatsapp.connection.auth_failure_class).toBe('none');
    db2.close();
  });

  it('classifies duplicate-session replacement separately from server-side logout', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: null,
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'reconnecting',
          connected: false,
          reconnectAttempts: 1,
          reconnectPhase: 'backoff',
          stateChangedAt: '2026-06-09T12:10:00.000Z',
          firstFailureAt: '2026-06-09T12:10:00.000Z',
          lastPingAt: '2026-06-09T12:09:30.000Z',
          lastPongAt: '2026-06-09T12:09:31.000Z',
          lastDisconnectReason: 'connectionReplaced',
          lastStatusCode: 440,
          authBond: makeAuthBond(),
          credentialLifecycle: {
            lastOpenAt: '2026-06-09T12:00:00.000Z',
            lastCloseAt: '2026-06-09T12:10:00.000Z',
            lastQrAt: null,
            recentEvents: [
              { event: 'connection_open', at: '2026-06-09T12:00:00.000Z' },
              { event: 'connection_close', at: '2026-06-09T12:10:00.000Z', statusCode: 440, reason: 'connectionReplaced' },
            ],
          },
        }),
      },
    } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.whatsapp.connection.disconnect_class).toBe('duplicate_session_replaced');
    expect(json.whatsapp.connection.auth_failure_class).toBe('none');
    db2.close();
  });

  it('fails closed when connection state and connected boolean disagree', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: '15550199000@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'disconnected',
          connected: true,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: null,
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          authBond: makeAuthBond(),
          credentialLifecycle: {
            lastQrAt: null,
            lastOpenAt: '2026-06-09T12:00:00.000Z',
          },
        }),
      },
    } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(503);
    const json = JSON.parse(body);
    expect(json.status).toBe('unhealthy');
    expect(json.whatsapp.connected).toBe(false);
    expect(json.whatsapp.connection.state).toBe('disconnected');
    db2.close();
  });

  it('includes protocol-level auth bond health when the connection manager exposes it', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: '15550199000@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'connected',
          connected: true,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: null,
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          credentialLifecycle: {
            version: 1,
            redaction: {
              version: 1,
              policy: 'credential material, tokens, pairing codes, full JIDs, and full phone numbers are blocked; identity fields use short hashes only',
            },
            environment: {
              instance: 'WhatSoup',
              host: 'nucles',
              pid: 1234,
              nodeVersion: 'v24.0.0',
              platform: 'linux',
              arch: 'arm64',
              release: 'test',
              processUptimeSeconds: 60,
              osUptimeSeconds: 600,
              loadavg: [0.1, 0.2, 0.3],
              memory: { freeBytes: 100, totalBytes: 200 },
              authDir: '/auth',
              stateRoot: '/state',
              dataRoot: '/data',
              lockPath: '/run/lock',
              healthPort: 9999,
              provider: 'claude',
            },
            currentAuthBond: {
              status: 'present',
              issues: [],
              authDir: { path: '/auth', exists: true, mode: '700', size: 128, mtime: '2026-06-09T12:00:00.000Z' },
              creds: {
                path: '/auth/creds.json',
                exists: true,
                mode: '600',
                size: 512,
                mtime: '2026-06-09T12:00:00.000Z',
                hash: 'a'.repeat(20),
                identityHash: 'b'.repeat(20),
              },
              treeHash: 'c'.repeat(20),
              fileCount: 14,
              totalBytes: 1234,
              backup: {
                root: '/state/auth-bond-backups/test',
                latest: '/state/auth-bond-backups/test/history/latest',
                latestAt: '2026-06-09T12:00:00.000Z',
                latestReason: 'connection-open',
                latestTreeHash: 'c'.repeat(20),
                lastCaptureAt: '2026-06-09T12:00:00.000Z',
                lastCaptureReason: 'connection-open',
                lastCaptureError: null,
                lastRestoreAt: null,
                lastRestoreSource: null,
                lastRestoreError: null,
              },
            },
            latestBaileysVersion: '2.2413.1',
            connectStartedAt: '2026-06-09T11:59:00.000Z',
            lastOpenAt: '2026-06-09T12:00:00.000Z',
            lastCloseAt: null,
            lastQrAt: null,
            lastCredsUpdateAt: '2026-06-09T12:00:01.000Z',
            lastCredsUpdateFailedAt: null,
            lastAuthSnapshotAt: '2026-06-09T12:00:02.000Z',
            lastAuthSnapshotFailedAt: null,
            credsUpdateCount: 3,
            authSnapshotCaptureCount: 2,
            authSnapshotFailureCount: 0,
            lastDisconnectDiagnostic: null,
            recentEvents: [
              {
                at: '2026-06-09T12:00:00.000Z',
                event: 'connection_open',
                state: 'connected',
                reconnectAttempts: 0,
                reconnectPhase: 'backoff',
              },
            ],
          },
          authBond: {
            status: 'present',
            issues: [],
            authDir: { path: '/auth', exists: true, mode: '700', size: 128, mtime: '2026-06-09T12:00:00.000Z', sha256: null },
            creds: { path: '/auth/creds.json', exists: true, mode: '600', size: 512, mtime: '2026-06-09T12:00:00.000Z', sha256: 'a'.repeat(64) },
            meHash: 'b'.repeat(20),
            treeHash: 'c'.repeat(64),
            fileCount: 14,
            totalBytes: 1234,
            backup: {
              root: '/state/auth-bond-backups/test',
              latest: '/state/auth-bond-backups/test/history/latest',
              latestAt: '2026-06-09T12:00:00.000Z',
              latestReason: 'connection-open',
              latestTreeHash: 'c'.repeat(64),
              lastCaptureAt: '2026-06-09T12:00:00.000Z',
              lastCaptureReason: 'connection-open',
              lastCaptureError: null,
              lastRestoreAt: null,
              lastRestoreSource: null,
              lastRestoreError: null,
            },
          },
        }),
      },
    } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.whatsapp.auth_bond).toMatchObject({
      status: 'present',
      creds: { hash: 'a'.repeat(20), mode: '600', empty_hash: false },
      me_hash: 'b'.repeat(20),
      tree_hash: 'c'.repeat(20),
      file_count: 14,
      total_bytes: 1234,
      backup: {
        latest: '/state/auth-bond-backups/test/history/latest',
        latest_reason: 'connection-open',
      },
    });
    expect(json.whatsapp.connection.auth_failure_class).toBe('none');
    expect(json.whatsapp.credential_lifecycle).toMatchObject({
      version: 1,
      latestBaileysVersion: '2.2413.1',
      credsUpdateCount: 3,
      environment: {
        host: 'nucles',
        authDir: '/auth',
      },
      currentAuthBond: {
        status: 'present',
        creds: { hash: 'a'.repeat(20), identityHash: 'b'.repeat(20) },
        fileCount: 14,
        totalBytes: 1234,
      },
    });
    db2.close();
  });

  it('classifies server-side WhatsApp logout as irreversible even when local auth is present', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: null,
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'disconnected',
          connected: false,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: '2026-06-09T12:00:00.000Z',
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: 'loggedOut',
          lastStatusCode: 401,
          authBond: makeAuthBond(),
          credentialLifecycle: {
            version: 1,
            latestBaileysVersion: '2.3000.1021',
            connectStartedAt: '2026-06-09T11:59:00.000Z',
            lastOpenAt: '2026-06-09T12:00:00.000Z',
            lastCloseAt: '2026-06-09T12:10:00.000Z',
            lastQrAt: null,
            lastCredsUpdateAt: '2026-06-09T12:05:00.000Z',
            lastCredsUpdateFailedAt: null,
            lastAuthSnapshotAt: '2026-06-09T12:05:01.000Z',
            lastAuthSnapshotFailedAt: null,
            credsUpdateCount: 3,
            authSnapshotCaptureCount: 2,
            authSnapshotFailureCount: 0,
            recentEvents: [
              { at: '2026-06-09T12:05:00.000Z', event: 'creds_update_saved', state: 'connected', reconnectAttempts: 0, reconnectPhase: 'backoff' },
              { at: '2026-06-09T12:10:00.000Z', event: 'device_bond_lost', state: 'disconnected', reconnectAttempts: 0, reconnectPhase: 'backoff', statusCode: 401, reason: 'loggedOut' },
            ],
          },
        }),
      },
    } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(503);
    const json = JSON.parse(body);
    expect(json.whatsapp.connection.disconnect_class).toBe('serverside_logout_irreversible');
    expect(json.whatsapp.connection.auth_failure_class).toBe('serverside_logout_irreversible');
    expect(json.whatsapp.auth_bond.status).toBe('present');
    expect(json.whatsapp.credential_lifecycle).toMatchObject({
      latestBaileysVersion: '2.3000.1021',
      credsUpdateCount: 3,
      recentEvents: [
        expect.objectContaining({ event: 'creds_update_saved' }),
        expect.objectContaining({ event: 'device_bond_lost', statusCode: 401 }),
      ],
    });
    db2.close();
  });

  it('classifies local auth corruption by whether a protected backup is available', async () => {
    db.close();
    const db2 = makeDb();
    const connectionManager = {
      botJid: '15550199000@s.whatsapp.net',
      botLid: null,
      sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
      sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getConnectionState: vi.fn(),
    };
    const baseSnapshot = {
      state: 'connected',
      connected: true,
      reconnectAttempts: 0,
      reconnectPhase: null,
      stateChangedAt: '2026-06-09T12:00:00.000Z',
      firstFailureAt: null,
      lastPingAt: null,
      lastPongAt: null,
      lastDisconnectReason: null,
      lastStatusCode: null,
    };
    connectionManager.getConnectionState.mockReturnValue({
      ...baseSnapshot,
      authBond: makeAuthBond({
        status: 'invalid',
        issues: ['creds_json_invalid_json'],
      }),
    });
    const deps = makeDeps(db2, { connectionManager } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    let response = await healthReq(port);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      status: 'degraded',
      whatsapp: {
        connection: { auth_failure_class: 'local_corruption_restorable' },
      },
    });

    connectionManager.getConnectionState.mockReturnValue({
      ...baseSnapshot,
      authBond: makeAuthBond({
        status: 'missing',
        issues: ['auth_dir_missing', 'creds_json_missing'],
        backup: { latest: null, latestAt: null, latestTreeHash: null },
      }),
    });

    response = await healthReq(port);
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({
      status: 'unhealthy',
      whatsapp: {
        connection: { auth_failure_class: 'local_corruption_unrestorable' },
      },
    });
    db2.close();
  });

  it('does not classify a connected fresh credential rewrite window as auth corruption', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-09T12:00:05Z'));
    try {
      db.close();
      const db2 = makeDb();
      const connectionManager = {
        botJid: '15550199000@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'connected',
          connected: true,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: null,
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          // Required by the snapshot type; a missing window reads as churn.
          recentDisconnects: { windowMs: 600_000, count: 0, lastAt: null, lastReason: null, lastStatusCode: null, byReason: {} },
          authBond: makeAuthBond({
            status: 'invalid',
            issues: ['creds_json_empty'],
            creds: {
              path: '/auth/creds.json',
              exists: true,
              mode: '600',
              size: 0,
              mtime: '2026-06-09T12:00:04.000Z',
              sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            },
            treeHash: null,
            backup: {
              lastCaptureDeferredAt: '2026-06-09T12:00:05.000Z',
              lastCaptureDeferredReason: 'creds-update',
              lastCaptureDeferredAgeMs: 1000,
            },
          }),
        }),
      };
      const deps = makeDeps(db2, { connectionManager } as any);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      ({ server, port } = await buildTestServer(deps));

      const response = await healthReq(port);
      const json = JSON.parse(response.body);

      expect(response.status).toBe(200);
      expect(json.status).toBe('healthy');
      expect(json.whatsapp.connection.auth_failure_class).toBe('none');
      expect(json.whatsapp.auth_bond).toMatchObject({
        status: 'invalid',
        backup: {
          last_capture_deferred_reason: 'creds-update',
          last_capture_deferred_age_ms: 1000,
        },
      });
      db2.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies present-but-risky auth bonds as degraded instead of healthy', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      connectionManager: {
        botJid: '15550199000@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn().mockReturnValue({
          state: 'connected',
          connected: true,
          reconnectAttempts: 0,
          reconnectPhase: null,
          stateChangedAt: '2026-06-09T12:00:00.000Z',
          firstFailureAt: null,
          lastPingAt: null,
          lastPongAt: null,
          lastDisconnectReason: null,
          lastStatusCode: null,
          authBond: makeAuthBond({
            issues: ['auth_mode_chmod_failed:creds.json:EPERM'],
            backup: { lastCaptureError: 'capture failed: disk full' },
          }),
          credentialLifecycle: {
            lastQrAt: null,
            lastOpenAt: '2026-06-09T12:00:00.000Z',
          },
        }),
      },
    } as any);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.whatsapp.connection.auth_failure_class).toBe('auth_bond_at_risk');
    expect(json.whatsapp.auth_bond.issues).toEqual(['auth_mode_chmod_failed:creds.json:EPERM']);
    db2.close();
  });

  it('classifies transient and unknown disconnect status codes separately', async () => {
    db.close();
    const db2 = makeDb();
    const connectionManager = {
      botJid: null,
      botLid: null,
      sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
      sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getConnectionState: vi.fn(),
    };
    const baseSnapshot = {
      state: 'reconnecting',
      connected: false,
      reconnectAttempts: 2,
      reconnectPhase: 'retry',
      stateChangedAt: '2026-06-09T12:00:00.000Z',
      firstFailureAt: '2026-06-09T12:00:00.000Z',
      lastPingAt: null,
      lastPongAt: null,
      authBond: makeAuthBond(),
      credentialLifecycle: {
        lastQrAt: null,
        lastOpenAt: '2026-06-09T11:00:00.000Z',
      },
    };
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(makeDeps(db2, { connectionManager } as any)));

    connectionManager.getConnectionState.mockReturnValue({
      ...baseSnapshot,
      lastDisconnectReason: 'connectionClosed',
      lastStatusCode: 428,
    });
    let response = await healthReq(port);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).whatsapp.connection.disconnect_class).toBe('transient_reconnect');

    connectionManager.getConnectionState.mockReturnValue({
      ...baseSnapshot,
      lastDisconnectReason: 'unexpected',
      lastStatusCode: 999,
    });
    response = await healthReq(port);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).whatsapp.connection.disconnect_class).toBe('unknown_reconnect');
    db2.close();
  });

  it('returns 404 for unknown routes', async () => {
    const { status } = await httpReq(port, '/unknown', 'GET');
    expect(status).toBe(404);
  });

  it('surfaces effectiveProvider and fallbackActiveUntil from the agent runtime fallback state', async () => {
    db.close();
    const db2 = makeDb();
    const activeUntil = Date.now() + 600_000;
    const resetAt = Date.now() + 1_200_000;
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({ status: 'healthy', details: { active: true } }),
      getFallbackState: () => ({
        effectiveProvider: 'openai-api',
        fallbackActiveUntil: activeUntil,
        fallbackReason: 'usage-limit',
        fallbackModel: 'gpt-5.5',
        fallbackResetAt: resetAt,
        fallbackRecoveryProbeRequired: true,
        fallbackTurnsServed: 3,
        fallbackTurnsEmpty: 1,
        lastFallbackTurnAt: 1_000_000,
      }),
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.instance.effectiveProvider).toBe('openai-api');
    expect(json.instance.fallbackActiveUntil).toBe(activeUntil);
    expect(json.instance.fallbackReason).toBe('usage-limit');
    expect(json.instance.fallbackModel).toBe('gpt-5.5');
    expect(json.instance.fallbackResetAt).toBe(resetAt);
    expect(json.instance.fallbackRecoveryProbeRequired).toBe(true);
    expect(json.instance.fallbackTurnsServed).toBe(3);
    expect(json.instance.fallbackTurnsEmpty).toBe(1);
    expect(json.instance.lastFallbackTurnAt).toBe(1_000_000);
    db2.close();
  });

  it('publishes exact degradation causes for an otherwise-operational fallback', async () => {
    db.close();
    const db2 = makeDb();
    const activeUntil = Date.now() + 600_000;
    let retainedRetries = 0;
    let active: boolean | undefined;
    let fallbackChainExhausted = false;
    let failedEntryCount = 0;
    let modelUsable: boolean | null = false;
    let modelUsableStale = false;
    let autoCompactActiveBackoffScopes = 0;
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'degraded',
        details: {
          recentCrashes: 0,
          autoCompactActiveBackoffScopes,
          ...(active === undefined ? {} : { active }),
          turnFinalizationRetainedRetries: retainedRetries,
          turnFinalizationDegradedScopes: 0,
          turnRecoveryOutstanding: 0,
          turnRecoveryExhausted: 0,
          turnRecoveryOpenRecoveries: 0,
          turnRecoveryCorruptLinks: 0,
          turnRecoveryEchoConflicts: 0,
          providerExecution: { pressureActive: false },
          turnCapability: {
            modelUsable,
            modelUsableStale,
            modelUsabilityStatus: 'provider-unavailable',
            lastSuccessfulTurnAt: Date.now() - 1_000,
            lastTurnErrorClass: null,
            lastTurnErrorAt: null,
          },
        },
      }),
      getFallbackState: () => ({
        effectiveProvider: 'opencode-cli',
        fallbackActiveUntil: activeUntil,
        fallbackReason: 'usage-limit',
        fallbackModel: 'configured/fallback',
        fallbackChainExhausted,
        failedEntryCount,
      }),
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.degradation_causes).toEqual([
      'provider_fallback_active',
      'primary_model_unusable',
    ]);

    retainedRetries = 1;
    const withRetryDebt = JSON.parse((await healthReq(port)).body);
    expect(withRetryDebt.degradation_causes).toEqual([
      'provider_fallback_active',
      'primary_model_unusable',
      'turn_finalization_degraded',
    ]);

    retainedRetries = 0;
    active = false;
    const withInactiveSession = JSON.parse((await healthReq(port)).body);
    expect(withInactiveSession.degradation_causes).toEqual([
      'provider_fallback_active',
      'primary_model_unusable',
      'agent_session_inactive',
    ]);

    active = undefined;
    fallbackChainExhausted = true;
    failedEntryCount = 1;
    const withFallbackFailures = JSON.parse((await healthReq(port)).body);
    expect(withFallbackFailures.degradation_causes).toEqual([
      'provider_fallback_active',
      'fallback_chain_exhausted',
      'fallback_entry_failures',
      'primary_model_unusable',
    ]);

    fallbackChainExhausted = false;
    failedEntryCount = 0;
    modelUsable = null;
    modelUsableStale = true;
    const withStalePrimaryEvidence = JSON.parse((await healthReq(port)).body);
    expect(withStalePrimaryEvidence.degradation_causes).toEqual([
      'provider_fallback_active',
      'primary_model_evidence_stale',
    ]);

    modelUsable = true;
    modelUsableStale = false;
    autoCompactActiveBackoffScopes = 1;
    const withAutoCompactBackoff = JSON.parse((await healthReq(port)).body);
    expect(withAutoCompactBackoff.degradation_causes).toEqual([
      'provider_fallback_active',
      'agent_auto_compact_backoff',
    ]);
    db2.close();
  });

  it('names frozen completed-delivery identity debt instead of agent_runtime_degraded_unclassified', async () => {
    // ml-bot/mini8 (2026-08-16): five bots sat permanently degraded with the
    // REAL reason (completed_delivery_identity_debt) visible only in
    // status_reasons while degradation_causes — the field alerts and flap
    // detection key on — fell through to agent_runtime_degraded_unclassified.
    // The signal existed and was dropped from the field that matters. This
    // pins the mapping rule so the debt is a NAMED cause.
    db.close();
    const db2 = makeDb();
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'degraded',
        details: {
          recentCrashes: 0,
          autoCompactActiveBackoffScopes: 0,
          turnFinalizationRetainedRetries: 0,
          turnFinalizationDegradedScopes: 0,
          turnRecoveryOutstanding: 0,
          turnRecoveryExhausted: 0,
          turnRecoveryOpenRecoveries: 0,
          turnRecoveryCorruptLinks: 0,
          turnRecoveryEchoConflicts: 0,
          providerExecution: { pressureActive: false },
          // frozen debt with no classified next action: service-blocking
          degradedReasons: ['completed_delivery_identity_debt'],
          recoveryBlockingReasons: ['completed_delivery_identity_unclassified'],
          completedDeliveryIdentityBlocking: 11,
          completedDeliveryIdentityAdmissions: {
            unresolvedCount: 11,
            oldestTransitionAt: '2026-08-12T05:34:35.000Z',
            maximumAttempts: 1,
            nextAction: null,
          },
        },
      }),
      getFallbackState: () => null,
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.degradation_causes).toContain('delivery_identity_debt');
    // the named cause replaces the unclassified fall-through — never both
    expect(json.degradation_causes).not.toContain('agent_runtime_degraded_unclassified');
    db2.close();
  });

  it('keeps retained completed-delivery identity debt out of degradation causes', async () => {
    // The live ml-bot shape (2026-08-16): frozen debt whose next action is a
    // fresh inbound is retained recovery debt. It stays visible in
    // recovery_debt but neither degrades status nor names a cause.
    db.close();
    const db2 = makeDb();
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'healthy',
        details: {
          recentCrashes: 0,
          providerExecution: { pressureActive: false },
          recoveryDebtReasons: ['completed_delivery_identity_fresh_inbound'],
          completedDeliveryIdentityRetained: 11,
          completedDeliveryIdentityAdmissions: {
            unresolvedCount: 11,
            oldestTransitionAt: '2026-08-12T05:34:35.000Z',
            maximumAttempts: 1,
            nextAction: 'fresh_inbound',
          },
        },
      }),
      getFallbackState: () => null,
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const json = JSON.parse((await healthReq(port)).body);
    expect(json.degradation_causes).not.toContain('delivery_identity_debt');
    expect(json.recovery_debt).toMatchObject({
      open: true,
      service_blocking: false,
      completed_delivery_identity: { retained: 11, next_action: 'fresh_inbound' },
    });
    db2.close();
  });

  it('threads periodic-probe scheduler inputs (backoff multiple, freshness window) into turn_capability', async () => {
    // The runtime now derives model_usable_stale from the probe scheduler's
    // expected deadline instead of a flat 30 minutes. The inputs to that
    // decision must be visible on the wire so an operator reading a stale flag
    // can see WHICH window it was judged against.
    db.close();
    const db2 = makeDb();
    const checkedAt = 1_782_349_406_162;
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'healthy',
        details: {
          active: true,
          turnCapability: {
            modelUsable: true,
            modelUsableStale: false,
            modelUsableCheckedAt: checkedAt,
            modelUsabilityStatus: 'usable',
            lastSuccessfulTurnAt: null,
            lastTurnErrorClass: null,
            lastTurnErrorAt: null,
            periodicProbeExpected: true,
            periodicProbeBackoffMultiple: 2,
            modelUsableFreshnessMs: 68 * 60_000,
            nextProbeDueAt: 1_782_353_006_162,
          },
        },
      }),
      getFallbackState: () => null,
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.turn_capability.periodic_probe_expected).toBe(true);
    expect(json.turn_capability.periodic_probe_backoff_multiple).toBe(2);
    expect(json.turn_capability.model_usable_freshness_ms).toBe(68 * 60_000);
    expect(json.turn_capability.next_probe_due_at).toBe(1_782_353_006_162);
    expect(json.runtime.agent.turnCapability.nextProbeDueAt).toBe(1_782_353_006_162);
    expect(json.runtime.agent.turnCapability.periodicProbeBackoffMultiple).toBe(2);
    expect(json.runtime.agent.turnCapability.modelUsableFreshnessMs).toBe(68 * 60_000);
    db2.close();
  });

  it('emits turn_recovery_degraded and its registered reason twin runtime.turn_finalization_debt for the same condition', async () => {
    // One condition (runtimeTurnRecoveryIsDegraded) reaches the wire under two
    // names. The cause->reason registry makes that cross-reference explicit;
    // this pins that the live emission still matches the registry.
    db.close();
    const db2 = makeDb();
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'degraded',
        details: {
          degradedReasons: ['turn_finalization_debt'],
          recoveryBlockingReasons: ['turn_recovery_actionable'],
          turnRecoveryBlockingOutstanding: 1,
          recentCrashes: 0,
          autoCompactActiveBackoffScopes: 0,
          turnFinalizationRetainedRetries: 0,
          turnFinalizationDegradedScopes: 0,
          turnRecoveryOutstanding: 1,
          turnRecoveryExhausted: 0,
          turnRecoveryOpenRecoveries: 0,
          turnRecoveryCorruptLinks: 0,
          turnRecoveryEchoConflicts: 0,
          providerExecution: { pressureActive: false },
        },
      }),
      getFallbackState: () => null,
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.degradation_causes).toContain('turn_recovery_degraded');
    expect(json.status_reasons).toContain('runtime.turn_finalization_debt');
    const twins = HEALTH_DEGRADATION_CAUSE_REASON_TWINS.turn_recovery_degraded;
    expect(twins).not.toBe(NO_REASON_TWIN);
    expect((twins as readonly string[]).some((reason) => json.status_reasons.includes(reason))).toBe(true);
    db2.close();
  });

  it('threads #1392 modelUsableStale/modelUsableCheckedAt into runtime.agent and top-level turn_capability (F1)', async () => {
    // Regression for the half-deployed #1392: the freshness fields were exposed on
    // instance.turnCapability (via getFallbackState) but dropped from the core/health.ts
    // serializers feeding runtime.agent.turnCapability and the top-level snake-case
    // turn_capability — which is exactly what whatsoup-keychain-heal.sh reads, leaving a
    // stale-green blind spot. See FLEET-MATRIX F1.
    db.close();
    const db2 = makeDb();
    const checkedAt = 1_782_349_406_162;
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'healthy',
        details: {
          active: true,
          turnCapability: {
            modelUsable: null,
            modelUsableStale: true,
            modelUsableCheckedAt: checkedAt,
            modelUsabilityStatus: 'usable',
            lastSuccessfulTurnAt: null,
            lastTurnErrorClass: null,
            lastTurnErrorAt: null,
          },
        },
      }),
      getFallbackState: () => null,
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    // runtime.agent.turnCapability (camelCase) must carry the freshness fields
    expect(json.runtime.agent.turnCapability.modelUsableStale).toBe(true);
    expect(json.runtime.agent.turnCapability.modelUsableCheckedAt).toBe(checkedAt);
    // top-level snake-case turn_capability (read by whatsoup-keychain-heal.sh) too
    expect(json.turn_capability.model_usable_stale).toBe(true);
    expect(json.turn_capability.model_usable_checked_at).toBe(checkedAt);
    // existing fields preserved
    expect(json.turn_capability.model_usable).toBe(null);
    db2.close();
  });

  it('degrades top-level status when model evidence is stale AND a turn was recently attempted (S-04a)', async () => {
    // Stale usability evidence WHILE the model was recently relied upon is a
    // genuine probe-refresh failure — it must not read as a healthy green. (A
    // never-turned idle bot with stale evidence stays healthy; that case is the
    // #1392 test above, which asserts field threading without a degrade.)
    db.close();
    const db2 = makeDb();
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'healthy',
        details: {
          active: true,
          turnCapability: {
            modelUsable: null,
            modelUsableStale: true,
            modelUsableCheckedAt: Date.now() - 60 * 60 * 1000,
            modelUsabilityStatus: 'usable',
            lastSuccessfulTurnAt: Date.now() - 60_000, // relied upon 1 min ago
            lastTurnErrorClass: null,
            lastTurnErrorAt: null,
          },
        },
      }),
      getFallbackState: () => null,
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.turn_capability.model_usable_stale).toBe(true);
    db2.close();
  });

  it('does not double-classify stale primary evidence while a proven fallback is serving', async () => {
    db.close();
    const db2 = makeDb();
    const activeUntil = Date.now() + 600_000;
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'degraded',
        details: {
          activeSessions: 1,
          degradedReasons: ['provider_fallback_active'],
          turnCapability: {
            modelUsable: null,
            modelUsableStale: true,
            modelUsableCheckedAt: Date.now() - 60 * 60 * 1000,
            modelUsabilityStatus: 'usable',
            lastSuccessfulTurnAt: Date.now() - 60_000,
            lastTurnErrorClass: null,
            lastTurnErrorAt: null,
          },
        },
      }),
      getFallbackState: () => ({
        effectiveProvider: 'opencode-cli',
        fallbackActiveUntil: activeUntil,
        fallbackReason: 'usage-limit',
        fallbackTurnsServed: 12,
        fallbackTurnsEmpty: 0,
        lastFallbackTurnAt: Date.now() - 60_000,
        fallbackChainExhausted: false,
        failedEntryCount: 0,
      }),
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    // #2515 landed mid-lane: the diagnostic projection is bearer-gated, so this
    // classification proof must request it through the authed helper.
    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.status_reasons).toEqual(['runtime.provider_fallback_active']);
    db2.close();
  });

  it('propagates degraded runtime snapshots to the top-level health status', async () => {
    db.close();
    const db2 = makeDb();
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'degraded',
        details: {
          activeSessions: 1,
          effectiveProvider: 'openai-api',
          fallbackActiveUntil: Date.now() + 600_000,
          fallbackReason: 'usage-limit',
          turnQueueHalted: true,
          turnQueueHaltedScopes: 2,
          degradedReasons: ['provider_fallback_active'],
        },
      }),
      getFallbackState: () => null,
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.status_reasons).toEqual(['runtime.provider_fallback_active']);
    expect(json.runtime.agent.effectiveProvider).toBe('openai-api');
    expect(json.runtime.agent.turnQueueHalted).toBe(true);
    expect(json.runtime.agent.turnQueueHaltedScopes).toBe(2);
    db2.close();
  });

  it('projects active outbound poison independently of historical recovery debt', async () => {
    db.close();
    const db2 = makeDb();
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'degraded',
        details: {
          degradedReasons: ['outbound_queue_poisoned'],
          outboundQueuePoisoned: true,
          outboundQueuePoisonedScopes: 1,
          turnRecoveryOutstanding: 0,
          turnRecoveryOpenRecoveries: 0,
        },
      }),
      getFallbackState: () => null,
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.status_reasons).toContain('runtime.outbound_queue_poisoned');
    expect(json.degradation_causes).toContain('agent_outbound_queue_poisoned');
    expect(json.runtime.agent).toMatchObject({
      outboundQueuePoisoned: true,
      outboundQueuePoisonedScopes: 1,
    });
    db2.close();
  });

  it('does not infer active outbound poison from historical recovery debt', async () => {
    db.close();
    const db2 = makeDb();
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'degraded',
        details: {
          degradedReasons: ['turn_finalization_debt'],
          outboundQueuePoisoned: false,
          outboundQueuePoisonedScopes: 0,
          turnRecoveryOutstanding: 2,
        },
      }),
      getFallbackState: () => null,
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(json.status_reasons).not.toContain('runtime.outbound_queue_poisoned');
    expect(json.degradation_causes).not.toContain('agent_outbound_queue_poisoned');
    db2.close();
  });

  it('publishes turn-finalization recovery counters and degraded status', async () => {
    db.close();
    const db2 = makeDb();
    const recoveryHealth = {
      proactiveResumeIdentityRejects: 3,
      turnFinalizationRetainedRetries: 2,
      turnFinalizationDegradedScopes: 1,
      turnFinalizationRetryAttempts: 7,
      turnFinalizationRetryRecoveries: 4,
      turnFinalizationRetryExhaustions: 1,
    };
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'degraded',
        details: { activeSessions: 1, ...recoveryHealth },
      }),
      getFallbackState: () => null,
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.runtime.agent).toMatchObject(recoveryHealth);
    db2.close();
  });

  it('projects durable completed-delivery identity debt without identity data', async () => {
    db.close();
    const db2 = makeDb();
    const admissionHealth = {
      unresolvedCount: 2,
      oldestTransitionAt: '2026-06-10 09:55:00',
      maximumAttempts: 1,
      nextAction: 'fresh_inbound',
    };
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'degraded',
        details: {
          degradedReasons: ['completed_delivery_identity_debt'],
          completedDeliveryIdentityAdmissions: admissionHealth,
        },
      }),
      getFallbackState: () => null,
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.status_reasons).toContain('runtime.completed_delivery_identity_debt');
    expect(json.runtime.agent.completedDeliveryIdentityAdmissions).toEqual(admissionHealth);
    const serialized = JSON.stringify(json.runtime.agent.completedDeliveryIdentityAdmissions);
    expect(serialized).not.toContain('conversation');
    expect(serialized).not.toContain('session_id');
    expect(serialized).not.toContain('delivery_jid');
    db2.close();
  });

  it('propagates unhealthy runtime snapshots to the top-level health status', async () => {
    db.close();
    const db2 = makeDb();
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'unhealthy',
        details: {
          activeSessions: 0,
          lastTurnErrorClass: 'auth-required',
          turnQueueHalted: true,
          turnQueueHaltedScopes: 1,
        },
      }),
      getFallbackState: () => null,
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(503);
    const json = JSON.parse(body);
    expect(json.status).toBe('unhealthy');
    expect(json.runtime.agent.turnQueueHalted).toBe(true);
    expect(json.runtime.agent.turnQueueHaltedScopes).toBe(1);
    expect(json.runtime.agent.lastTurnErrorClass).toBe('auth-required');
    db2.close();
  });

  it('retains the outbound poison reason when agent runtime health is unhealthy', async () => {
    db.close();
    const db2 = makeDb();
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'unhealthy',
        details: {
          degradedReasons: ['outbound_queue_poisoned'],
          outboundQueuePoisoned: true,
          outboundQueuePoisonedScopes: 1,
        },
      }),
      getFallbackState: () => null,
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(503);
    const json = JSON.parse(body);
    expect(json.status_reasons).toEqual([
      'agent_runtime_unhealthy',
      'runtime.outbound_queue_poisoned',
    ]);
    expect(json.degradation_causes).toEqual(expect.arrayContaining([
      'agent_runtime_unhealthy',
      'agent_outbound_queue_poisoned',
    ]));
    db2.close();
  });

  it('includes instance block with expected fields', async () => {
    process.env.WHATSOUP_GIT_SHA = 'a'.repeat(40);
    process.env.WHATSOUP_GIT_BRANCH = 'main';

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.instance).toBeDefined();
    expect(json.instance.name).toBe('WhatSoup');
    expect(json.instance.mode).toBe('chat');
    expect(json.instance.accessMode).toBe('allowlist');
    expect(json.instance.pid).toBe(process.pid);
    expect(json.instance.commit).toBe('a'.repeat(40));
    expect(json.instance.branch).toBe('main');
  });

  it('returns instance.socketPath as null when not provided', async () => {
    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    expect(JSON.parse(body).instance).toEqual({
      name: 'WhatSoup',
      mode: 'chat',
      accessMode: 'allowlist',
      socketPath: null,
      commit: null,
      branch: null,
      pid: process.pid,
    });
  });

  it('returns instance.socketPath when provided in deps', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, { socketPath: '/run/whatsoup/test.sock' });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(json.instance.socketPath).toBe('/run/whatsoup/test.sock');
    db2.close();
  });

  it('returns sqlite.schema_version as a number >= 0', async () => {
    const { body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(typeof json.sqlite.schema_version).toBe('number');
    expect(json.sqlite.schema_version).toBeGreaterThanOrEqual(0);
    expect(json.sqlite.schema_migration_required).toBe(CURRENT_SCHEMA_MIGRATION);
    expect(json.sqlite.schema_migration_latest).toBe(CURRENT_SCHEMA_MIGRATION);
    expect(json.sqlite.schema_ready).toBe(true);
    expect(json.sqlite.pending_polls_readable).toBe(true);
  });

  it('reports recovery_debt (healthy status) while external-history continuity gaps remain open', async () => {
    recordContinuityGaps(db.raw, [
      {
        ordinal: 1,
        classification: 'absent',
        receiptFingerprint: 'a'.repeat(64),
        destinationFingerprint: 'b'.repeat(64),
        manifestFingerprint: 'c'.repeat(64),
        evidenceFingerprint: 'd'.repeat(64),
      },
      {
        ordinal: 2,
        classification: 'ambiguous',
        receiptFingerprint: 'e'.repeat(64),
        destinationFingerprint: 'b'.repeat(64),
        manifestFingerprint: 'c'.repeat(64),
        evidenceFingerprint: 'd'.repeat(64),
      },
    ]);

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    // Continuity gaps alone no longer flip status to degraded (#2973 Option A)
    expect(json.status).toBe('healthy');
    expect(json.degradation_causes).toContain('continuity_gap_open');
    expect(json.recovery_debt).toEqual({
      open: true,
      service_blocking: false,
      attention: 'routine',
      reason: 'continuity_gap_open',
      reasons: ['continuity_gap_open'],
      continuity: {
        readable: true,
        open: 2,
        unresolved: 1,
        ambiguous: 1,
      },
      turn_recovery: {
        readable: true,
        blocking_outstanding: 0,
        retained_terminal: 0,
        open_catchups: 0,
        corroborated_retained: 0,
        scheduled_turns_lost: 0,
      },
      completed_delivery_identity: {
        readable: true,
        blocking: 0,
        retained: 0,
        next_action: null,
      },
      delivery: {
        readable: true,
        blocking_ambiguous: 0,
        uncorroborated_ambiguous: 0,
        corroborated_retained: 0,
        oldest_uncorroborated_at: null,
      },
    });
    expect(json.continuity).toEqual({
      readable: true,
      closure_ledger: 'present',
      total: 2,
      open: 2,
      unresolved: 1,
      ambiguous: 1,
      ambiguous_total: 1,
      closed: 0,
      addressed: 0,
      declined: 0,
    });
    expect(body).not.toContain('continuity-gap:v1:');
    expect(body).not.toContain('a'.repeat(64));
  });

  it('reports recovery_debt (continuity_gap_unreadable) when reserved continuity state has a foreign owner', async () => {
    db.raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary)
      VALUES ('foreign-continuity-state', 'operator', 'other_recovery_owner',
              'Unrelated recovery work')
    `).run();
    db.raw.prepare(`
      INSERT INTO recovery_runs (trigger, recovery_plan_id, status)
      VALUES ('continuity_gap_absent', 'foreign-continuity-state', 'started')
    `).run();

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    // Unreadable safety evidence fails closed even though readable open gaps are retained debt.
    expect(json.status).toBe('degraded');
    expect(json.degradation_causes).toContain('continuity_gap_unreadable');
    expect(json.recovery_debt).toMatchObject({
      open: true,
      reason: 'continuity_gap_unreadable',
    });
    // Unreadable claims no count at all — never a fabricated zero.
    expect(json.continuity).toEqual({
      readable: false,
      closure_ledger: null,
      total: null,
      open: null,
      unresolved: null,
      ambiguous: null,
      ambiguous_total: null,
      closed: null,
      addressed: null,
      declined: null,
    });
    expect(body).not.toContain('foreign-continuity-state');
    expect(body).not.toContain('other_recovery_owner');
  });

  // #2973 Option A — discriminating recovery_debt cases
  it('(a) reports healthy status with recovery_debt for continuity-gap-only degraded scenario', async () => {
    recordContinuityGaps(db.raw, [
      {
        ordinal: 1,
        classification: 'absent',
        receiptFingerprint: 'a'.repeat(64),
        destinationFingerprint: 'b'.repeat(64),
        manifestFingerprint: 'c'.repeat(64),
        evidenceFingerprint: 'd'.repeat(64),
      },
    ]);

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    // Authenticated + connected + model usable + continuity gap open only
    expect(json.status).toBe('healthy');
    expect(json.recovery_debt.open).toBe(true);
    expect(json.recovery_debt.reason).toBe('continuity_gap_open');
    // degradation_causes still includes continuity strings (variant a)
    expect(json.degradation_causes).toContain('continuity_gap_open');
  });

  it('(b) reports degraded status without recovery_debt for provider-unusable scenario', async () => {
    // Real provider-unusable injection: restorable local auth corruption
    // (degraded-class auth failure) with zero continuity gaps recorded.
    const db2 = makeDb();
    const connectionManager = {
      botJid: '15550199000@s.whatsapp.net',
      botLid: null,
      sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
      sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getConnectionState: vi.fn().mockReturnValue({
        state: 'connected',
        connected: true,
        reconnectAttempts: 0,
        reconnectPhase: null,
        stateChangedAt: '2026-06-09T12:00:00.000Z',
        firstFailureAt: null,
        lastPingAt: null,
        lastPongAt: null,
        lastDisconnectReason: null,
        lastStatusCode: null,
        authBond: makeAuthBond({ status: 'invalid', issues: ['creds_json_invalid_json'] }),
      }),
    };
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(makeDeps(db2, { connectionManager } as any)));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json).toMatchObject({
      status: 'degraded',
      whatsapp: { connection: { auth_failure_class: 'local_corruption_restorable' } },
    });
    // Provider-unusable alone carries NO recovery debt
    expect(json.recovery_debt).toMatchObject({ open: false, reason: null });
    db2.close();
  });

  it('(c) reports degraded status AND recovery_debt when both provider-unusable and continuity gaps exist', async () => {
    // Both signals injected for real: degraded-class auth corruption AND an
    // open continuity gap — the provider cause drives status, the gap rides
    // in recovery_debt (and stays visible in degradation_causes, variant a).
    const db2 = makeDb();
    recordContinuityGaps(db2.raw, [
      {
        ordinal: 1,
        classification: 'absent',
        receiptFingerprint: 'a'.repeat(64),
        destinationFingerprint: 'b'.repeat(64),
        manifestFingerprint: 'c'.repeat(64),
        evidenceFingerprint: 'd'.repeat(64),
      },
    ]);
    const connectionManager = {
      botJid: '15550199000@s.whatsapp.net',
      botLid: null,
      sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
      sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getConnectionState: vi.fn().mockReturnValue({
        state: 'connected',
        connected: true,
        reconnectAttempts: 0,
        reconnectPhase: null,
        stateChangedAt: '2026-06-09T12:00:00.000Z',
        firstFailureAt: null,
        lastPingAt: null,
        lastPongAt: null,
        lastDisconnectReason: null,
        lastStatusCode: null,
        authBond: makeAuthBond({ status: 'invalid', issues: ['creds_json_invalid_json'] }),
      }),
    };
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(makeDeps(db2, { connectionManager } as any)));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json).toMatchObject({
      status: 'degraded',
      whatsapp: { connection: { auth_failure_class: 'local_corruption_restorable' } },
    });
    expect(json.recovery_debt).toMatchObject({ open: true, reason: 'continuity_gap_open' });
    expect(json.degradation_causes).toContain('continuity_gap_open');
    db2.close();
  });

  it('a closed continuity gap clears continuity_gap_open but never turn_recovery_degraded', async () => {
    const db2 = makeDb();
    const gap = gapObservation(1, 'absent');
    recordGaps(db2.raw, [gap]);
    insertClosureRow(db2.raw, signedClosure(gap));
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'degraded',
        details: {
          recentCrashes: 0,
          autoCompactActiveBackoffScopes: 0,
          turnFinalizationRetainedRetries: 0,
          turnFinalizationDegradedScopes: 0,
          turnRecoveryOutstanding: 1,
          turnRecoveryBlockingOutstanding: 1,
          turnRecoveryExhausted: 0,
          turnRecoveryRetainedTerminal: 0,
          turnRecoveryOpenRecoveries: 0,
          turnRecoveryCorroboratedRetained: 0,
          turnRecoveryCorruptLinks: 0,
          turnRecoveryEchoConflicts: 0,
          completedDeliveryIdentityBlocking: 0,
          completedDeliveryIdentityRetained: 0,
          completedDeliveryIdentityAdmissions: { nextAction: null },
          // The runtime's own classification: blocking turn recovery.
          recoveryBlockingReasons: ['turn_recovery_actionable'],
          recoveryDebtReasons: [],
          providerExecution: { pressureActive: false },
          turnCapability: {
            modelUsable: true,
            modelUsableStale: false,
            modelUsabilityStatus: 'ok',
            lastSuccessfulTurnAt: Date.now() - 1_000,
            lastTurnErrorClass: null,
            lastTurnErrorAt: null,
          },
        },
      }),
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const json = JSON.parse((await healthReq(port)).body);
    expect(json.continuity).toMatchObject({
      readable: true, total: 1, open: 0, closed: 1, addressed: 1, declined: 0,
    });
    // The closed gap leaves normalized continuity debt empty; the runtime's
    // own recovery evidence is judged separately by normalizeRecoveryDebt.
    expect(json.recovery_debt.continuity).toEqual({
      readable: true, open: 0, unresolved: 0, ambiguous: 0,
    });
    expect(json.recovery_debt.reason).toBeNull();
    expect(json.recovery_debt.reasons).not.toContain('continuity_gap_open');
    expect(json.degradation_causes).not.toContain('continuity_gap_open');
    expect(json.degradation_causes).toContain('turn_recovery_degraded');
    db2.close();
  });

  it('returns healthy on the next poll after a blocking recovery episode clears, without restart', async () => {
    // runtime.turn_finalization_debt and recovery_debt_blocking are recomputed
    // from durable state on every poll (DIRECTLY_REPROBED_STATUS_REASONS), so
    // they never arm the #2280 latch: once the evidence reads non-blocking the
    // same server process reports healthy, with retained debt still visible.
    db.close();
    const db2 = makeDb();
    const turnCapability = {
      modelUsable: true,
      modelUsableStale: false,
      modelUsabilityStatus: 'usable',
      lastSuccessfulTurnAt: Date.now(),
      lastTurnErrorClass: null,
      lastTurnErrorAt: null,
    };
    const completeRecoveryDetails = (overrides: Record<string, unknown>) => ({
      degradedReasons: [],
      recoveryBlockingReasons: [],
      recoveryDebtReasons: [],
      turnRecoveryBlockingOutstanding: 0,
      turnRecoveryRetainedTerminal: 0,
      turnRecoveryOpenRecoveries: 0,
      turnRecoveryCorroboratedRetained: 0,
      completedDeliveryIdentityBlocking: 0,
      completedDeliveryIdentityRetained: 0,
      completedDeliveryIdentityAdmissions: { nextAction: null },
      ...overrides,
    });
    const getHealthSnapshot = vi.fn()
      .mockReturnValueOnce({
        status: 'degraded',
        details: completeRecoveryDetails({
          degradedReasons: ['turn_finalization_debt'],
          recoveryBlockingReasons: ['turn_recovery_actionable'],
          turnRecoveryBlockingOutstanding: 1,
          turnCapability,
        }),
      })
      .mockReturnValueOnce({
        status: 'healthy',
        details: completeRecoveryDetails({
          recoveryDebtReasons: ['historical_turn_catchup'],
          turnRecoveryOpenRecoveries: 1,
          turnCapability,
        }),
      })
      .mockReturnValue({
        status: 'healthy',
        details: completeRecoveryDetails({ turnCapability }),
      });
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: { getHealthSnapshot } as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const first = JSON.parse((await healthReq(port)).body);
    const retained = JSON.parse((await healthReq(port)).body);
    const clear = JSON.parse((await healthReq(port)).body);

    expect(first).toMatchObject({
      status: 'degraded',
      recovery_debt: { open: true, service_blocking: true },
    });
    expect(first.status_reasons).toEqual(
      expect.arrayContaining(['runtime.turn_finalization_debt', 'recovery_debt_blocking']),
    );
    expect(retained).toMatchObject({
      status: 'healthy',
      status_reasons: [],
      recovery_debt: {
        open: true,
        service_blocking: false,
        reasons: ['historical_turn_catchup'],
      },
    });
    expect(retained.degradation_causes).not.toContain('turn_recovery_degraded');
    expect(retained.degradation_causes).not.toContain('recovery_debt_blocking');
    expect(retained.degradation_causes).not.toContain('degradation_silence_unproven');
    expect(clear).toMatchObject({
      status: 'healthy',
      status_reasons: [],
      recovery_debt: { open: false, service_blocking: false },
    });
    expect(getHealthSnapshot).toHaveBeenCalledTimes(3);
    db2.close();
  });

  describe('recovery-debt reasons are directly re-probed, never latched (#2280)', () => {
    const cleanTurnCapability = {
      modelUsable: true,
      modelUsableStale: false,
      modelUsabilityStatus: 'usable',
      lastSuccessfulTurnAt: Date.now(),
      lastTurnErrorClass: null,
      lastTurnErrorAt: null,
    };

    /** One long-lived server whose runtime snapshot and delivery evidence can
     * change between polls: the latch is scoped to the server instance, so a
     * fresh server per poll would reset exactly the state under test. */
    async function openMutableAgent(): Promise<{
      poll: () => Promise<Record<string, any>>;
      setRuntime: (snapshot: { status: string; details: Record<string, unknown> }) => void;
      setDeliveryReadable: (readable: boolean) => void;
      close: () => void;
    }> {
      db.close();
      const db2 = makeDb();
      let runtimeSnapshot: { status: string; details: Record<string, unknown> } = {
        status: 'healthy',
        details: { turnCapability: cleanTurnCapability },
      };
      let deliveryReadable = true;
      const deps = makeDeps(db2, {
        instanceType: 'agent',
        runtime: { getHealthSnapshot: () => runtimeSnapshot } as unknown as HealthDeps['runtime'],
        durability: {
          getHealthStats: () => ({
            oldestMaybeSentAt: null,
            deliveryAmbiguity: deliveryReadable
              ? { readable: true, uncorroboratedAmbiguous: 0, corroboratedRetained: 0, oldestUncorroboratedAt: null }
              : { readable: false },
          }),
        } as unknown as NonNullable<HealthDeps['durability']>,
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      ({ server, port } = await buildTestServer(deps));
      return {
        poll: async () => JSON.parse((await healthReq(port)).body),
        setRuntime: (snapshot) => { runtimeSnapshot = snapshot; },
        setDeliveryReadable: (readable) => { deliveryReadable = readable; },
        close: () => db2.close(),
      };
    }

    it('returns healthy after a blocking completed-delivery identity episode clears', async () => {
      const agent = await openMutableAgent();
      agent.setRuntime({
        status: 'degraded',
        details: {
          turnCapability: cleanTurnCapability,
          degradedReasons: ['completed_delivery_identity_debt'],
          recoveryBlockingReasons: ['completed_delivery_identity_unclassified'],
          completedDeliveryIdentityBlocking: 2,
          completedDeliveryIdentityAdmissions: { unresolvedCount: 2, nextAction: null },
        },
      });
      const blocked = await agent.poll();
      expect(blocked.status).toBe('degraded');
      expect(blocked.status_reasons).toEqual(expect.arrayContaining([
        'runtime.completed_delivery_identity_debt',
        'recovery_debt_blocking',
      ]));

      agent.setRuntime({ status: 'healthy', details: { turnCapability: cleanTurnCapability } });
      const repaired = await agent.poll();
      expect(repaired.status, 'a repaired instance must not stay latched degraded').toBe('healthy');
      expect(repaired.status_reasons).toEqual([]);
      agent.close();
    });

    it('keeps unreadable recovery evidence degraded with its own reason on every poll, then clears on repair', async () => {
      const agent = await openMutableAgent();
      agent.setRuntime({
        status: 'healthy',
        // A malformed gauge makes the runtime recovery evidence unreadable.
        details: { turnCapability: cleanTurnCapability, recoveryBlockingReasons: null },
      });
      for (let pollIndex = 0; pollIndex < 3; pollIndex += 1) {
        const unreadable = await agent.poll();
        expect(unreadable.status).toBe('degraded');
        expect(unreadable.status_reasons).toContain('recovery_debt_blocking');
        expect(unreadable.status_reasons).not.toContain('degradation_silence_unproven');
        expect(unreadable.recovery_debt.reasons).toContain('recovery_evidence_unreadable');
      }
      agent.setRuntime({ status: 'healthy', details: { turnCapability: cleanTurnCapability } });
      expect((await agent.poll()).status).toBe('healthy');
      agent.close();
    });

    it('keeps unreadable delivery evidence degraded with its own reason on every poll, then clears on repair', async () => {
      const agent = await openMutableAgent();
      agent.setDeliveryReadable(false);
      for (let pollIndex = 0; pollIndex < 3; pollIndex += 1) {
        const unreadable = await agent.poll();
        expect(unreadable.status).toBe('degraded');
        expect(unreadable.status_reasons).toContain('recovery_debt_blocking');
        expect(unreadable.status_reasons).not.toContain('degradation_silence_unproven');
        expect(unreadable.recovery_debt.reasons).toContain('delivery_evidence_unreadable');
      }
      agent.setDeliveryReadable(true);
      expect((await agent.poll()).status).toBe('healthy');
      agent.close();
    });

    it('keeps unreadable continuity evidence degraded with its own reason on every poll, then clears on repair', async () => {
      db.raw.prepare(`
        INSERT INTO recovery_plans (plan_id, origin, actor, summary)
        VALUES ('foreign-continuity-reprobe', 'operator', 'other_recovery_owner', 'Unrelated recovery work')
      `).run();
      db.raw.prepare(`
        INSERT INTO recovery_runs (trigger, recovery_plan_id, status)
        VALUES ('continuity_gap_absent', 'foreign-continuity-reprobe', 'started')
      `).run();
      for (let pollIndex = 0; pollIndex < 3; pollIndex += 1) {
        const unreadable = JSON.parse((await healthReq(port)).body);
        expect(unreadable.status).toBe('degraded');
        expect(unreadable.status_reasons).toContain('recovery_debt_blocking');
        expect(unreadable.status_reasons).not.toContain('degradation_silence_unproven');
        expect(unreadable.recovery_debt.reason).toBe('continuity_gap_unreadable');
      }
      // recovery_plans is append-only; removing the foreign continuity run is
      // what ends the foreign reservation the ledger reader refuses.
      db.raw.prepare(`DELETE FROM recovery_runs WHERE recovery_plan_id = 'foreign-continuity-reprobe'`).run();
      const repaired = JSON.parse((await healthReq(port)).body);
      expect(repaired.status, 'a repaired ledger must not stay latched degraded').toBe('healthy');
      expect(repaired.status_reasons).toEqual([]);
    });

    it('a silence-prone reason alongside the recovery reasons still arms, so the change removes no protection', async () => {
      const agent = await openMutableAgent();
      agent.setRuntime({
        status: 'degraded',
        details: {
          turnCapability: cleanTurnCapability,
          degradedReasons: ['turn_finalization_debt', 'turn_queue_halted'],
          recoveryBlockingReasons: ['turn_recovery_actionable'],
          turnRecoveryBlockingOutstanding: 1,
        },
      });
      const degraded = await agent.poll();
      expect(degraded.status_reasons).toEqual(expect.arrayContaining([
        'runtime.turn_finalization_debt',
        'runtime.turn_queue_halted',
        'recovery_debt_blocking',
      ]));

      agent.setRuntime({ status: 'healthy', details: { turnCapability: cleanTurnCapability } });
      const afterRepair = await agent.poll();
      expect(afterRepair.status, 'turn_queue_halted must still latch').toBe('degraded');
      expect(afterRepair.status_reasons).toEqual(['degradation_silence_unproven']);
      agent.close();
    });
  });

  it.each([
    ['an exhausted retained job', { turnRecoveryExhausted: 1, turnRecoveryRetainedTerminal: 1, recoveryDebtReasons: ['turn_recovery_terminal'] }],
    ['a corroborated pending job', { turnRecoveryOutstanding: 1, turnRecoveryPending: 1, turnRecoveryCorroboratedRetained: 1, recoveryDebtReasons: ['corroborated_delivery_retained'] }],
    ['an open historical catch-up', { turnRecoveryOpenRecoveries: 1, recoveryDebtReasons: ['historical_turn_catchup'] }],
  ])('does not name turn_recovery_degraded for retained-only debt (%s) on a runtime degraded for another reason', async (_label, retained) => {
    db.close();
    const db2 = makeDb();
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'degraded',
        details: {
          degradedReasons: ['recent_crashes'],
          recentCrashes: 1,
          autoCompactActiveBackoffScopes: 0,
          turnFinalizationRetainedRetries: 0,
          turnFinalizationDegradedScopes: 0,
          turnRecoveryOutstanding: 0,
          turnRecoveryPending: 0,
          turnRecoveryExhausted: 0,
          turnRecoveryOpenRecoveries: 0,
          turnRecoveryCorruptLinks: 0,
          turnRecoveryEchoConflicts: 0,
          turnRecoveryOrphanTransfers: 0,
          turnRecoveryBlockingOutstanding: 0,
          turnRecoveryRetainedTerminal: 0,
          turnRecoveryCorroboratedRetained: 0,
          recoveryBlockingReasons: [],
          completedDeliveryIdentityBlocking: 0,
          completedDeliveryIdentityRetained: 0,
          completedDeliveryIdentityAdmissions: { nextAction: null },
          providerExecution: { pressureActive: false },
          ...retained,
        },
      }),
      getFallbackState: () => null,
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const json = JSON.parse((await healthReq(port)).body);
    expect(json.status).toBe('degraded');
    expect(json.recovery_debt).toMatchObject({ open: true, service_blocking: false });
    expect(json.status_reasons).not.toContain('runtime.turn_finalization_debt');
    expect(json.degradation_causes).toContain('agent_recent_crashes');
    expect(json.degradation_causes).not.toContain('turn_recovery_degraded');
    // Every emitted cause with a registered reason twin carries that twin.
    for (const cause of json.degradation_causes as string[]) {
      const twins = HEALTH_DEGRADATION_CAUSE_REASON_TWINS[
        cause as keyof typeof HEALTH_DEGRADATION_CAUSE_REASON_TWINS
      ];
      if (twins === undefined || twins === NO_REASON_TWIN) continue;
      expect((twins as readonly string[]).some((reason) => json.status_reasons.includes(reason))).toBe(true);
    }
    db2.close();
  });

  it('surfaces turn_recovery_degraded and provider_execution_pressure causes from runtime counters', async () => {
    const db2 = makeDb();
    let outstanding = 1;
    let exhausted = 0;
    let corruptLinks = 0;
    let pressureActive = false;
    const fakeAgentRuntime = {
      getHealthSnapshot: () => ({
        status: 'degraded',
        details: {
          recentCrashes: 0,
          autoCompactActiveBackoffScopes: 0,
          turnFinalizationRetainedRetries: 0,
          turnFinalizationDegradedScopes: 0,
          turnRecoveryOutstanding: outstanding,
          turnRecoveryBlockingOutstanding: outstanding,
          turnRecoveryExhausted: exhausted,
          turnRecoveryRetainedTerminal: exhausted,
          turnRecoveryOpenRecoveries: 0,
          turnRecoveryCorruptLinks: corruptLinks,
          turnRecoveryEchoConflicts: 0,
          // The runtime's own classification of the counters above.
          recoveryBlockingReasons: [
            ...(outstanding > 0 ? ['turn_recovery_actionable'] : []),
            ...(corruptLinks > 0 ? ['turn_recovery_integrity'] : []),
          ],
          recoveryDebtReasons: exhausted > 0 ? ['turn_recovery_terminal'] : [],
          providerExecution: { pressureActive },
          turnCapability: {
            modelUsable: false,
            modelUsableStale: false,
            modelUsabilityStatus: 'provider-unavailable',
            lastSuccessfulTurnAt: Date.now() - 1_000,
            lastTurnErrorClass: null,
            lastTurnErrorAt: null,
          },
        },
      }),
    };
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: fakeAgentRuntime as unknown as HealthDeps['runtime'],
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    // Leg 1: outstanding recoveries flag the recovery cause.
    let json = JSON.parse((await healthReq(port)).body);
    expect(json.degradation_causes).toContain('turn_recovery_degraded');
    expect(json.degradation_causes).not.toContain('provider_execution_pressure');

    // Leg 2: a different blocking counter (corrupt links) flags the same cause.
    outstanding = 0;
    corruptLinks = 1;
    json = JSON.parse((await healthReq(port)).body);
    expect(json.degradation_causes).toContain('turn_recovery_degraded');

    // Leg 2b: exhausted jobs are retained terminal debt and never name it.
    corruptLinks = 0;
    exhausted = 1;
    json = JSON.parse((await healthReq(port)).body);
    expect(json.degradation_causes).not.toContain('turn_recovery_degraded');

    // Leg 3: counters clear, provider execution pressure flags its own cause.
    exhausted = 0;
    pressureActive = true;
    json = JSON.parse((await healthReq(port)).body);
    expect(json.degradation_causes).not.toContain('turn_recovery_degraded');
    expect(json.degradation_causes).toContain('provider_execution_pressure');
    db2.close();
  });

  it('degrades health when the applied migration version is behind the code-required schema', async () => {
    db.raw.prepare('DELETE FROM schema_migrations WHERE version = ?').run(CURRENT_SCHEMA_MIGRATION);

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.sqlite.schema_migration_latest).toBeLessThan(CURRENT_SCHEMA_MIGRATION);
    expect(json.sqlite.schema_migration_required).toBe(CURRENT_SCHEMA_MIGRATION);
    expect(json.sqlite.schema_ready).toBe(false);
    expect(json.sqlite.pending_polls_readable).toBe(true);
  });

  it('reports unhealthy when the database schema is newer than this binary', async () => {
    db.raw.prepare('INSERT INTO schema_migrations(version) VALUES (?)')
      .run(CURRENT_SCHEMA_MIGRATION + 1);

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(503);
    expect(json.status).toBe('unhealthy');
    expect(json.sqlite.schema_migration_latest).toBe(CURRENT_SCHEMA_MIGRATION + 1);
    expect(json.sqlite.schema_migration_required).toBe(CURRENT_SCHEMA_MIGRATION);
    expect(json.sqlite.schema_ready).toBe(false);
  });

  it('surfaces a queued Chat compatibility rejection in the health body', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'unhealthy',
          details: {
            queue: { activeChats: 0, queuedChats: 0 },
            databaseCompatibility: {
              reason: 'invalid_schema',
              observedMigration: 44,
              requiredMigration: 44,
              dbPath: '/private/runtime/bot.db',
              chatJid: '15551230008@s.whatsapp.net',
              message: 'private prompt text',
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(503);
    expect(json.status).toBe('unhealthy');
    expect(json.runtime.chat.database_compatibility).toEqual({
      reason: 'invalid_schema',
      observed_migration: 44,
      required_migration: 44,
    });
    expect(body).not.toContain('/private/runtime/bot.db');
    expect(body).not.toContain('15551230008@s.whatsapp.net');
    expect(body).not.toContain('private prompt text');
    db2.close();
  });

  it('degrades health when pending_polls is unreadable instead of masking schema drift', async () => {
    db.raw.exec('DROP TABLE pending_polls');

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.sqlite.schema_migration_latest).toBe(CURRENT_SCHEMA_MIGRATION);
    expect(json.sqlite.schema_ready).toBe(true);
    expect(json.sqlite.pending_polls_readable).toBe(false);
    expect(json.sqlite.pending_polls_total).toBe(0);
  });

  it('returns degraded JSON with chat runtime queue details when enrichment is stale', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      getEnrichmentStats: vi.fn().mockReturnValue({
        lastRun: '2000-01-01T00:00:00.000Z',
        unprocessed: 7,
        runtimeDegraded: true,
      }),
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'degraded',
          details: { queue: { activeChats: 2, queuedChats: 3 } },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.enrichment.last_run).toBe('2000-01-01T00:00:00.000Z');
    expect(json.runtime.chat).toEqual({ queueDepth: 5, enrichmentUnprocessed: 7 });
    db2.close();
  });

  // #2545: the handler must sample getHealthSnapshot() exactly once per
  // request and thread that single snapshot into both the enrichment stats
  // and the runtime block. getEnrichmentStats() here stands in for
  // src/main.ts's real implementation: when called with the (new) snapshot
  // argument it uses that snapshot directly; when called with none — the
  // pre-fix calling convention — it falls back to self-sampling, exactly
  // like the unfixed production code did. A state transition between the
  // two snapshot generations must not leak into a mixed-generation response.
  it('samples the runtime snapshot exactly once per request, keeping enrichment and runtime blocks on the same generation', async () => {
    db.close();
    const db2 = makeDb();
    const getHealthSnapshot = vi.fn()
      .mockReturnValueOnce({
        status: 'healthy',
        details: { enrichmentLastRunAt: 'GEN-A', queue: { activeChats: 1, queuedChats: 0 } },
      })
      .mockReturnValueOnce({
        status: 'healthy',
        details: { enrichmentLastRunAt: 'GEN-B', queue: { activeChats: 9, queuedChats: 9 } },
      });
    const deps = makeDeps(db2, {
      getEnrichmentStats: ((snapshotArg?: { details: Record<string, unknown> } | null) => {
        const snap = snapshotArg ?? getHealthSnapshot();
        return {
          lastRun: (snap.details.enrichmentLastRunAt as string | null) ?? null,
          unprocessed: 0,
          runtimeDegraded: false,
        };
      }) as HealthDeps['getEnrichmentStats'],
      runtime: { getHealthSnapshot } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);

    // One request must sample the runtime snapshot exactly once — not once
    // for enrichment stats and again for the runtime block.
    expect(getHealthSnapshot).toHaveBeenCalledTimes(1);
    // Both the enrichment block and the runtime block must derive from the
    // SAME (first, generation-A) snapshot. Pre-fix, enrichment reads
    // generation A while the runtime block reads generation B (queueDepth
    // 18 instead of 1) — a mixed-generation response.
    expect(json.enrichment.last_run).toBe('GEN-A');
    expect(json.runtime.chat.queueDepth).toBe(1);

    db2.close();
  });

  it('projects a bounded failed enrichment-cycle receipt without copying arbitrary runtime detail', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      getEnrichmentStats: vi.fn().mockReturnValue({
        lastRun: '2026-07-30T00:00:01.000Z',
        unprocessed: 0,
        runtimeDegraded: true,
      }),
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'degraded',
          details: {
            queue: { activeChats: 0, queuedChats: 0 },
            enrichmentCycle: {
              state: 'failed',
              lastAttemptAt: '2026-07-30T00:00:03.000Z',
              lastSuccessAt: '2026-07-30T00:00:01.000Z',
              status: 'failed',
              failureCode: 'selection_failed',
              stage: 'selection',
              retryable: true,
              evidenceCoverage: 'typed',
              privateMarker: 'PRIVATE-ENRICHMENT-DETAIL',
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);

    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.enrichment).toEqual({
      last_run: '2026-07-30T00:00:01.000Z',
      cycle: {
        state: 'failed',
        last_attempt_at: '2026-07-30T00:00:03.000Z',
        last_success_at: '2026-07-30T00:00:01.000Z',
        status: 'failed',
        failure_code: 'selection_failed',
        stage: 'selection',
        retryable: true,
        evidence_coverage: 'typed',
      },
    });
    expect(body).not.toContain('PRIVATE-ENRICHMENT-DETAIL');
    db2.close();
  });

  it('projects bounded Chat queue-admission counters without copying runtime detail', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            queue: { activeChats: 0, queuedChats: 0, droppedCount: 4 },
            queueAdmission: {
              rejectedTotal: 4,
              unownedTotal: 1,
              chatJid: 'private-chat@s.whatsapp.net',
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(json.runtime.chat).toEqual({
      queueDepth: 0,
      enrichmentUnprocessed: 0,
      queue_admission: {
        rejected_total: 4,
        unowned_total: 1,
      },
    });
    expect(body).not.toContain('private-chat@s.whatsapp.net');
    db2.close();
  });

  it.each([
    ['fractional', { rejectedTotal: 1.5, unownedTotal: 0 }],
    ['unsafe integer', { rejectedTotal: Number.MAX_SAFE_INTEGER + 1, unownedTotal: 0 }],
    ['wrong type', { rejectedTotal: '4', unownedTotal: 0 }],
    ['missing field', { rejectedTotal: 4 }],
    ['incoherent totals', { rejectedTotal: 1, unownedTotal: 2 }],
  ])('omits %s Chat queue-admission counters', async (_caseName, queueAdmission) => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            queue: { activeChats: 0, queuedChats: 0 },
            queueAdmission,
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(json.runtime.chat).toEqual({
      queueDepth: 0,
      enrichmentUnprocessed: 0,
    });
    db2.close();
  });

  it('returns passive runtime details verbatim in the health JSON shape', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'passive',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: { socket: 'ready', tools: 160 },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    expect(JSON.parse(body).runtime).toEqual({
      passive: { socket: 'ready', tools: 160 },
    });
    db2.close();
  });

  it('returns agent runtime details verbatim in the health JSON shape', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'degraded',
          details: { sessions: 2, compact: { lastError: 'timeout' } },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.runtime).toEqual({
      agent: {
        sessions: 2,
        compact: { lastError: 'timeout' },
        degradedReasons: [],
        recoveryBlockingReasons: [],
        recoveryDebtReasons: [],
        turnRecoveryBlockingOutstanding: 0,
        turnRecoveryRetainedTerminal: 0,
        turnRecoveryOpenRecoveries: 0,
        turnRecoveryCorroboratedRetained: 0,
        completedDeliveryIdentityBlocking: 0,
        completedDeliveryIdentityRetained: 0,
        completedDeliveryIdentityAdmissions: { nextAction: null },
      },
    });
    db2.close();
  });

  it('degrades agent health when turn capability reports a broken primary model', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: false,
              modelUsabilityStatus: 'model-unavailable',
              lastSuccessfulTurnAt: null,
              lastTurnErrorClass: 'model-unavailable',
              lastTurnErrorAt: 1_781_316_000_000,
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.turn_capability).toEqual({
      model_usable: false,
      model_usable_stale: null,
      model_usable_checked_at: null,
      model_usability_status: 'model-unavailable',
      periodic_probe_expected: null,
      periodic_probe_backoff_multiple: null,
      model_usable_freshness_ms: null,
      next_probe_due_at: null,
      last_successful_turn_at: null,
      last_successful_turn_provider: null,
      last_successful_turn_model: null,
      last_successful_turn_session_current: null,
      primary_model: null,
      last_turn_error_class: 'model-unavailable',
      last_turn_error_at: 1_781_316_000_000,
    });
    db2.close();
  });

  it('keeps agent health healthy when turn capability has recovered', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: true,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: 1_781_316_030_000,
              lastTurnErrorClass: null,
              lastTurnErrorAt: null,
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    expect(json.turn_capability).toEqual({
      model_usable: true,
      model_usable_stale: null,
      model_usable_checked_at: null,
      model_usability_status: 'usable',
      periodic_probe_expected: null,
      periodic_probe_backoff_multiple: null,
      model_usable_freshness_ms: null,
      next_probe_due_at: null,
      last_successful_turn_at: 1_781_316_030_000,
      last_successful_turn_provider: null,
      last_successful_turn_model: null,
      last_successful_turn_session_current: null,
      primary_model: null,
      last_turn_error_class: null,
      last_turn_error_at: null,
    });
    db2.close();
  });

  it('keeps agent health healthy on a boot empty-output artifact before the first successful turn', async () => {
    // Regression: the boot/recovery sequence stamps lastTurnErrorClass='empty-output'
    // ~1s after restart while the bot is idle. Because lastSuccessfulTurnAt stays null
    // (no real turn yet) the sticky flag never clears, falsely degrading the instance
    // forever. A genuinely-broken model is still caught independently via
    // model_usable===false (the usability probe), so empty-output before the first
    // proven turn must NOT degrade health.
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,            // probe not (yet) flagging the model
              modelUsabilityStatus: 'unknown',
              lastSuccessfulTurnAt: null,   // never proven a turn → boot artifact
              lastTurnErrorClass: 'empty-output',
              lastTurnErrorAt: 1_781_316_000_000,
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    expect(json.turn_capability).toEqual({
      model_usable: null,
      model_usable_stale: null,
      model_usable_checked_at: null,
      model_usability_status: 'unknown',
      periodic_probe_expected: null,
      periodic_probe_backoff_multiple: null,
      model_usable_freshness_ms: null,
      next_probe_due_at: null,
      last_successful_turn_at: null,
      last_successful_turn_provider: null,
      last_successful_turn_model: null,
      last_successful_turn_session_current: null,
      primary_model: null,
      last_turn_error_class: 'empty-output',
      last_turn_error_at: 1_781_316_000_000,
    });
    db2.close();
  });

  it('degrades agent health on a CURRENT, SUSTAINED empty-output stall after a successful turn (#1433)', async () => {
    // A real regression: a turn proved out, then empty-output came after it and has
    // persisted past the debounce but is still recent (within the staleness bound).
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: now - 5 * 60 * 1000,
              lastTurnErrorClass: 'empty-output',
              lastTurnErrorAt: now - 3 * 60 * 1000, // 3m old: past 1m debounce, under 15m stale
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    db2.close();
  });

  it('keeps agent health healthy on a STALE idle empty-output after a successful turn (#1433 idle-stuck self-clear)', async () => {
    // rb-bot/mini7: one empty-output turn after a success, then the bot went idle.
    // With no further turns the trailing error never clears; previously this pinned
    // the instance to degraded forever. A stale (idle, >15m old) empty-output is a
    // benign artifact and must self-clear; a genuinely-broken model is still caught
    // independently via model_usable===false.
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: now - 92 * 60 * 1000,
              lastTurnErrorClass: 'empty-output',
              lastTurnErrorAt: now - 90 * 60 * 1000, // 90m idle → stale → benign
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    db2.close();
  });

  it('keeps agent health healthy when an empty-output is superseded by a later success (#1433 flap kill)', async () => {
    // ar-bot/mini2: empty/success turns alternate. Once a success lands AFTER the
    // empty-output, the model has recovered — health must not flap to degraded.
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: true,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: now - 30 * 1000, // success came AFTER the error
              lastTurnErrorClass: 'empty-output',
              lastTurnErrorAt: now - 90 * 1000,
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    db2.close();
  });

  it('keeps agent health healthy on a fresh empty-output within the debounce window (#1433 transient damp)', async () => {
    // A single just-now empty-output that has not yet persisted past the debounce
    // must not trip degraded — the next turn is given a chance to succeed.
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: now - 2 * 60 * 1000,
              lastTurnErrorClass: 'empty-output',
              lastTurnErrorAt: now - 10 * 1000, // 10s old: still inside the 1m debounce
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    db2.close();
  });

  it('keeps agent health healthy on a STALE transient-network blip with no successful turn since (B21-D)', async () => {
    // W1-T6 regression: adding 'transient-network' to HEALTH_TURN_ERROR_CLASSES
    // made a single self-resolved network blip degrade /health immediately and
    // indefinitely — an idle bot has no later turn to clear the trailing error.
    // failure-taxonomy documents transient-network as needing no provider-level
    // action; it must get the same staleness self-clear empty-output has.
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: now - 92 * 60 * 1000,
              lastTurnErrorClass: 'transient-network',
              lastTurnErrorAt: now - 90 * 60 * 1000, // 90m idle → stale → benign
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    // Visibility (the W1-T6 intent) is preserved: the class still surfaces.
    expect(json.turn_capability.last_turn_error_class).toBe('transient-network');
    db2.close();
  });

  it('keeps agent health healthy on a STALE server-error with no successful turn since (B21-D)', async () => {
    // Same W1-T6 regression for the second backfilled class: one 5xx blip must
    // not pin an idle instance degraded for hours.
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: now - 92 * 60 * 1000,
              lastTurnErrorClass: 'server-error',
              lastTurnErrorAt: now - 90 * 60 * 1000, // 90m idle → stale → benign
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    expect(json.turn_capability.last_turn_error_class).toBe('server-error');
    db2.close();
  });

  it('degrades agent health on a CURRENT, SUSTAINED transient-network failure after a successful turn (B21-D parity)', async () => {
    // Parity with empty-output (#1433): a transient-network error that came after
    // a proven turn and persisted past the debounce but is still recent (inside
    // the staleness bound) is a live stall and must degrade.
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: now - 5 * 60 * 1000,
              lastTurnErrorClass: 'transient-network',
              lastTurnErrorAt: now - 3 * 60 * 1000, // 3m old: past 1m debounce, under 15m stale
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    db2.close();
  });

  it('keeps agent health healthy on a fresh transient-network error within the debounce window (B21-D damp)', async () => {
    // A single just-now network blip that has not yet persisted past the debounce
    // must not trip degraded — the next turn is given a chance to succeed.
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,
              modelUsabilityStatus: 'usable',
              lastSuccessfulTurnAt: now - 2 * 60 * 1000,
              lastTurnErrorClass: 'transient-network',
              lastTurnErrorAt: now - 10 * 1000, // 10s old: still inside the 1m debounce
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    db2.close();
  });

  it('degrades agent health on a non-transient error class even before the first successful turn', async () => {
    // The boot-grace relaxation is scoped to the transient self-clearing classes
    // (empty-output, transient-network, server-error) ONLY. A real provider
    // failure at boot (e.g. auth-required) must still degrade.
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: null,
              modelUsabilityStatus: 'unknown',
              lastSuccessfulTurnAt: null,
              lastTurnErrorClass: 'auth-required',
              lastTurnErrorAt: 1_781_316_000_000,
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    db2.close();
  });

  it('RED 1: auth-required + FRESH usable probe (newer than error) → healthy (probe supersedes stale class)', async () => {
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: true,
              modelUsabilityStatus: 'usable',
              modelUsableCheckedAt: now,                                // probe AFTER error
              modelUsableStale: false,
              lastSuccessfulTurnAt: null,                               // idle: no user turn
              lastTurnErrorClass: 'auth-required',
              lastTurnErrorAt: now - 60_000,                            // error 1 min ago
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('healthy');
    expect(json.turn_capability.last_turn_error_class).toBe('auth-required');
    db2.close();
  });

  it('RED 2: auth-required + STALE probe (OLDER than error) → degraded (no supersession)', async () => {
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: true,
              modelUsabilityStatus: 'usable',
              modelUsableCheckedAt: now - 120_000,                      // probe BEFORE error
              modelUsableStale: false,
              lastSuccessfulTurnAt: null,
              lastTurnErrorClass: 'auth-required',
              lastTurnErrorAt: now - 60_000,                            // error after probe
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    db2.close();
  });

  it('RED 3: auth-required + STALE probe flag (model_usable_stale=true) → degraded', async () => {
    db.close();
    const db2 = makeDb();
    const now = Date.now();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: true,
              modelUsabilityStatus: 'usable',
              modelUsableCheckedAt: now,                                // nominally fresh
              modelUsableStale: true,                                   // but flagged stale
              lastSuccessfulTurnAt: null,
              lastTurnErrorClass: 'auth-required',
              lastTurnErrorAt: now - 60_000,
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    db2.close();
  });

  it('sanitizes agent turn capability strings before exposing them in health', async () => {
    db.close();
    const db2 = makeDb();
    const rawProviderText = 'unrecognized-provider';
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn().mockReturnValue({
          status: 'healthy',
          details: {
            turnCapability: {
              modelUsable: false,
              modelUsabilityStatus: rawProviderText,
              lastSuccessfulTurnAt: null,
              lastSuccessfulTurnProvider: rawProviderText,
              lastTurnErrorClass: rawProviderText,
              lastTurnErrorAt: 1_781_316_000_000,
            },
          },
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.turn_capability).toEqual({
      model_usable: false,
      model_usable_stale: null,
      model_usable_checked_at: null,
      model_usability_status: null,
      periodic_probe_expected: null,
      periodic_probe_backoff_multiple: null,
      model_usable_freshness_ms: null,
      next_probe_due_at: null,
      last_successful_turn_at: null,
      last_successful_turn_provider: null,
      last_successful_turn_model: null,
      last_successful_turn_session_current: null,
      primary_model: null,
      last_turn_error_class: null,
      last_turn_error_at: 1_781_316_000_000,
    });
    expect(json.runtime.agent.turnCapability).toEqual({
      modelUsable: false,
      modelUsableStale: null,
      modelUsableCheckedAt: null,
      modelUsabilityStatus: null,
      lastSuccessfulTurnAt: null,
      lastSuccessfulTurnProvider: null,
      lastSuccessfulTurnModel: null,
      lastSuccessfulTurnSessionCurrent: null,
      primaryModel: null,
      lastTurnErrorClass: null,
      lastTurnErrorAt: 1_781_316_000_000,
      periodicProbeExpected: null,
      periodicProbeBackoffMultiple: null,
      modelUsableFreshnessMs: null,
      nextProbeDueAt: null,
    });
    expect(body).not.toContain(rawProviderText);
    db2.close();
  });

  it('returns an error JSON shape when runtime health snapshot collection fails', async () => {
    db.close();
    const db2 = makeDb();
    const deps = makeDeps(db2, {
      instanceType: 'agent',
      runtime: {
        getHealthSnapshot: vi.fn(() => {
          throw new Error('snapshot unavailable');
        }),
      } as any,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ({ server, port } = await buildTestServer(deps));

    const { status, body } = await healthReq(port);
    expect(status).toBe(500);
    expect(JSON.parse(body)).toEqual({ status: 'error' });
    db2.close();
  });
});
