import { lookupCredentialMock, httpReq, TEST_HEALTH_TOKEN, healthReq, buildTestServer, makeDb, makeDeps } from './_helpers/health.ts';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { Database } from '../../src/core/database.ts';
import { seedChatAliases } from '../../src/core/chats-resolver.ts';
import { createProfileRegistry } from '../../src/core/profiles.ts';
import { createOutboundSendsWriter } from '../../src/core/outbound-sends.ts';
import type { HealthDeps } from '../../src/core/health.ts';

describe('POST /send — Authorization header check', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;
  let deps: HealthDeps;

  beforeEach(async () => {
    db = makeDb();
    lookupCredentialMock.mockClear();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    deps = makeDeps(db, {
      profiles: createProfileRegistry({
        satellite: { prefix: '[SAT] ', tag: ' #satellite' },
      }),
      auditWriter: createOutboundSendsWriter({ db: db.raw, line: 'test-line' }),
    });
    ({ server, port } = await buildTestServer(deps));
  });

  afterEach(async () => {
    db.close();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 401 when WHATSOUP_HEALTH_TOKEN is set and Authorization header is missing', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net', text: 'hi' });
    const { status, body } = await httpReq(port, '/send', 'POST', payload);
    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when Bearer token does not match', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net', text: 'hi' });
    const { status } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer wrong-token',
    });
    expect(status).toBe(401);
  });

  it('returns 401 for multibyte malformed Bearer tokens without crashing', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'a'.repeat(10);
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net', text: 'hi' });
    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: `Bearer ${'é'.repeat(10)}`,
    });
    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
  });

  it('proceeds (200) when correct Bearer token is provided', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net', text: 'hello' });
    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer test-health-token-2515',
    });
    expect(status).toBe(200);
    expect(JSON.parse(body).ok).toBe(true);
    // Launcher-provenanced env token is the canonical source (tokens.env
    // chain): when it is present the scoped keychain must NOT be consulted —
    // a stale keychain entry diverging from a rotated tokens.env would
    // otherwise strand the fleet on 401s.
    expect(lookupCredentialMock).not.toHaveBeenCalledWith('whatsoup-health-token', {
      user: 'WhatSoup',
      skipMigrationFallbacks: true,
    });
  });

  it('audits a successful health send exactly once', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net', text: 'hello audit' });

    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(status).toBe(200);
    expect(JSON.parse(body).ok).toBe(true);
    const rows = db.raw
      .prepare(`
        SELECT caller, target_kind, outcome_code, failure_code, failure_stage,
               mutation_state, evidence_coverage, logical_attempt_count,
               provider_submission_count
        FROM outbound_sends
      `)
      .all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([{
      caller: 'health',
      target_kind: 'chatJid',
      outcome_code: 'submitted',
      failure_code: null,
      failure_stage: 'ack_received',
      mutation_state: 'acknowledged',
      evidence_coverage: 'typed',
      logical_attempt_count: 1,
      provider_submission_count: 1,
    }]);
  });

  it('canonicalizes a phone-JID recipient onto the existing @lid conversation and echoes the resolved JID (3150)', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
    // The instance knows this phone identity maps to a LID whose DM thread
    // already exists — an admin /send addressed by phone JID must land in
    // that thread, not open a second one, and the response must echo the
    // resolved JID so callers can verify routing (issue 3150).
    db.raw
      .prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111110222', '15550100001@s.whatsapp.net');
    db.raw
      .prepare('INSERT INTO chats (jid, conversation_key) VALUES (?, ?)')
      .run('11111110222@lid', '15550100001');

    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net', text: 'canonical hello' });
    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.ok).toBe(true);
    expect(json.chatJid).toBe('11111110222@lid');
    expect(deps.connectionManager.sendMessage).toHaveBeenCalledWith(
      '11111110222@lid',
      'canonical hello',
      { caller: 'health' },
    );
  });

  it('surfaces bounded aggregate outbound evidence without destination or provider identifiers', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net', text: 'hello health proof' });

    const send = await httpReq(port, '/send', 'POST', payload, {
      authorization: `Bearer ${TEST_HEALTH_TOKEN}`,
    });
    expect(send.status).toBe(200);

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.outbound_sends).toEqual({
      readable: true,
      total: 1,
      intent: 0,
      submitted: 1,
      confirmed: 0,
      failed_not_sent: 0,
      ambiguous: 0,
      legacy_unclassified: 0,
      latest_successful_send_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    });
    expect(body).not.toContain('15550100001@s.whatsapp.net');
    expect(body).not.toContain('latest_successful_transport_id');
  });

  it('audits a failed health send exactly once', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
    vi.mocked(deps.connectionManager.sendMessage).mockRejectedValueOnce(new Error('transport unavailable'));
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net', text: 'will fail' });

    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(status).toBe(500);
    expect(JSON.parse(body).error).toBe('transport unavailable');
    const rows = db.raw
      .prepare(`
        SELECT caller, target_kind, outcome_code, failure_code, failure_stage,
               mutation_state, retryable, evidence_coverage
        FROM outbound_sends
      `)
      .all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([{
      caller: 'health',
      target_kind: 'chatJid',
      outcome_code: 'ambiguous',
      failure_code: 'unknown',
      failure_stage: 'unknown',
      mutation_state: 'unknown',
      retryable: 0,
      evidence_coverage: 'untyped',
    }]);
  });

  it('reports unreadable outbound evidence as unknown rather than zero', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
    db.raw.exec('DROP TABLE outbound_sends');

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.status_reasons).toContain('durability_evidence_unreadable');
    expect(json.degradation_causes).toContain('durability_evidence_unreadable');
    expect(json.outbound_sends).toEqual({
      readable: false,
      total: null,
      intent: null,
      submitted: null,
      confirmed: null,
      failed_not_sent: null,
      ambiguous: null,
      legacy_unclassified: null,
      latest_successful_send_at: null,
    });
  });

  it('surfaces aggregate tool durability and process-local write-loss telemetry', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
    db.raw.prepare(`
      INSERT INTO tool_calls (
        conversation_key, tool_name, tool_group, tool_input, status, result,
        replay_policy, outcome_code, retry_disposition, operator_action,
        evidence_coverage
      ) VALUES (
        'conversation-health', 'search_messages', 'search', '[metadata-only]',
        'pending', NULL, 'read_only', 'not_terminal', 'not_applicable',
        'none', 'complete'
      )
    `).run();
    deps.runtime = {
      getHealthSnapshot: () => ({ status: 'healthy', details: {} }),
      getToolDurabilityTelemetrySnapshot: () => ({
        observed: true,
        totalWriteLosses: 2,
        byStage: { record: 1, execute: 0, complete: 1, deny: 0 },
        firstLossAt: 1_721_000_000_000,
        lastLossAt: 1_721_000_001_000,
      }),
    } as unknown as HealthDeps['runtime'];

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    expect(JSON.parse(body).tool_durability).toEqual({
      readable: true,
      total: 1,
      open: 1,
      terminal: 0,
      failures: 0,
      legacy_unclassified: 0,
      runtime_write_losses: {
        observed: true,
        totalWriteLosses: 2,
        byStage: { record: 1, execute: 0, complete: 1, deny: 0 },
        firstLossAt: 1_721_000_000_000,
        lastLossAt: 1_721_000_001_000,
      },
    });
  });

  it('reports unreadable tool durability as unknown and retains runtime observation', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
    db.raw.exec('DROP TABLE tool_calls');
    deps.runtime = {
      getHealthSnapshot: () => ({ status: 'healthy', details: {} }),
      getToolDurabilityTelemetrySnapshot: () => ({
        observed: true,
        totalWriteLosses: 0,
        byStage: { record: 0, execute: 0, complete: 0, deny: 0 },
        firstLossAt: null,
        lastLossAt: null,
      }),
    } as unknown as HealthDeps['runtime'];

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('degraded');
    expect(json.status_reasons).toContain('durability_evidence_unreadable');
    expect(json.degradation_causes).toContain('durability_evidence_unreadable');
    expect(json.tool_durability).toEqual({
      readable: false,
      total: null,
      open: null,
      terminal: null,
      failures: null,
      legacy_unclassified: null,
      runtime_write_losses: {
        observed: true,
        totalWriteLosses: 0,
        byStage: { record: 0, execute: 0, complete: 0, deny: 0 },
        firstLossAt: null,
        lastLossAt: null,
      },
    });
  });

  it('surfaces the database-retention timer health snapshot', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
    deps.getDatabaseRetentionHealth = () => ({
      running: true,
      state: 'succeeded',
      consecutiveFailures: 0,
      failureCode: null,
      lastRunAt: 1_721_000_000_000,
      lastSuccessAt: 1_721_000_000_100,
      lastFailureAt: null,
      lastResult: {
        turnRecoveryJobs: 0,
        turnTerminalRecords: 0,
        inboundEvents: 0,
        outboundOps: 0,
        toolCalls: 3,
        outboundSends: 4,
        factExportQueue: 0,
        factExportTerminal: 0,
        memoryConsolidationRuns: 0,
        metricsHourly: 0,
        decryptionFailures: 0,
        messages: 0,
        triggerRuns: 0,
        triggerOccurrences: 0,
        handoffArtifacts: 2,
        identityAdmissionsExpired: 0,
      },
    });

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    expect(JSON.parse(body).retention.database).toEqual(deps.getDatabaseRetentionHealth());
  });

  it('degrades health for a failed database-retention snapshot', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
    deps.getDatabaseRetentionHealth = () => ({
      running: true,
      state: 'failed',
      consecutiveFailures: 2,
      failureCode: 'retention_failed',
      lastRunAt: 1_721_000_000_000,
      lastSuccessAt: 1_720_000_000_000,
      lastFailureAt: 1_721_000_000_100,
      lastResult: null,
    });

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.status_reasons).toContain('database_retention_failed');
    expect(json.degradation_causes).toContain('database_retention_failed');
    expect(json.retention.database).toEqual(deps.getDatabaseRetentionHealth());
  });

  it('degrades with bounded retention evidence when the snapshot getter throws', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
    deps.getDatabaseRetentionHealth = () => {
      throw new Error('CANARY-RETENTION-GETTER-FAILURE');
    };

    const { status, body } = await healthReq(port);
    const json = JSON.parse(body);
    expect(status).toBe(200);
    expect(json.status).toBe('degraded');
    expect(json.status_reasons).toContain('database_retention_failed');
    expect(json.degradation_causes).toContain('database_retention_failed');
    expect(json.retention.database).toEqual({
      running: false,
      state: 'failed',
      consecutiveFailures: 1,
      failureCode: 'retention_failed',
      lastRunAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastResult: null,
    });
    expect(body).not.toContain('CANARY-RETENTION-GETTER-FAILURE');
  });

  // #2566 slice 4 — occurrence-lifecycle gauges: counts and ages ONLY, never
  // raw prompt/JID/SQL content (exact-byte projection discipline).
  it('surfaces recurring-overdue, active-occurrence, and delivery-unknown gauges', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
    const now = Math.floor(Date.now() / 1000);
    const bead = db.raw.prepare(
      `INSERT INTO beads (kind, title, owner_jid, status, created_at, updated_at)
       VALUES ('watch', 'SECRET-GAUGE-TITLE', 'gauge-owner@s.whatsapp.net', 'active', ?, ?)`,
    ).run(now, now);
    const beadId = Number(bead.lastInsertRowid);
    // Recurring-overdue: fired before, next_fire_at far past.
    db.raw.prepare(
      `INSERT INTO bead_triggers (bead_id, kind, spec_json, report_chat_jid, status, next_fire_at, last_fire_at, created_at, updated_at)
       VALUES (?, 'schedule.cron', '{"expr":"0 8 * * *"}', 'SECRET-GAUGE-CHAT@g.us', 'active', ?, ?, ?, ?)`,
    ).run(beadId, now - 90_000, now - 100_000, now, now);
    const trig = db.raw.prepare(`SELECT id FROM bead_triggers WHERE bead_id = ?`).get(beadId) as { id: number };
    // Active occurrence claimed 500s ago.
    db.raw.prepare(
      `INSERT INTO trigger_occurrences (trigger_id, bead_id, scheduled_for, attempt, state, lease_owner, lease_generation, lease_expires_at, claimed_at, started_at)
       VALUES (?, ?, ?, 1, 'running', 'pid:gauge:aaaa', 1, ?, ?, ?)`,
    ).run(trig.id, beadId, now - 500, now + 400, now - 500, now - 500);
    // A run whose notification outcome is unknown.
    db.raw.prepare(
      `INSERT INTO trigger_runs (trigger_id, bead_id, status, started_at, finished_at, attempt, error_kind, metadata_json)
       VALUES (?, ?, 'ok', ?, ?, 1, 'notify_outcome_unknown', '{}')`,
    ).run(trig.id, beadId, now - 600, now - 600);

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const gauges = JSON.parse(body).sqlite;
    expect(gauges.recurring_overdue_triggers).toBe(1);
    expect(gauges.active_trigger_occurrences).toBe(1);
    expect(gauges.oldest_active_occurrence_age_s).toBeGreaterThanOrEqual(500);
    expect(gauges.oldest_active_occurrence_age_s).toBeLessThan(600);
    expect(gauges.notify_outcome_unknown_runs).toBe(1);
    // Exact-byte discipline: no seeded content crosses the projection.
    expect(body).not.toContain('SECRET-GAUGE-TITLE');
    expect(body).not.toContain('SECRET-GAUGE-CHAT');
  });

  // #2567 slice 2 — fact-export queue gauges + honest consumer evidence.
  // Counts, ages, and a derived consumer_state ONLY — never fact text,
  // JIDs, payload JSON, or the legacy fact_id.
  it('surfaces fact-export gauges and degrades when pending work has no consumer evidence', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
    db.raw.prepare(
      `INSERT INTO fact_export_queue (fact_uid, fact_id, chat_jid, payload_json, state, created_at)
       VALUES ('fe_gaugepending0000000001', 'SECRET-FACT-ID:SECRET-CHAT@g.us:abc', 'SECRET-CHAT@g.us', '{"text":"SECRET-FACT-TEXT"}', 'pending', datetime('now', '-2 hours'))`,
    ).run();
    db.raw.prepare(
      `INSERT INTO fact_export_queue (fact_uid, fact_id, chat_jid, payload_json, state, failure_code, created_at)
       VALUES ('fe_gaugequarantine00000001', 'SECRET-QUAR-ID', 'SECRET-CHAT@g.us', '{"text":"SECRET-QUAR-TEXT"}', 'quarantined', 'payload_invalid', datetime('now', '-1 hours'))`,
    ).run();

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    const gauges = json.sqlite;
    expect(gauges.fact_export_pending).toBe(1);
    expect(gauges.fact_export_quarantined).toBe(1);
    expect(gauges.fact_export_oldest_pending_age_s).toBeGreaterThanOrEqual(7000);
    expect(gauges.fact_export_consumer_state).toBe('consumer_missing');
    // Honest health: pending export work with zero consumer evidence can
    // never report end-to-end healthy.
    expect(json.status).toBe('degraded');
    expect(json.status_reasons).toContain('fact_export_consumer_missing');
    // Exact-byte discipline.
    expect(body).not.toContain('SECRET-FACT-ID');
    expect(body).not.toContain('SECRET-FACT-TEXT');
    expect(body).not.toContain('SECRET-QUAR');
    expect(body).not.toContain('SECRET-CHAT');
  });

  it('reports current consumer evidence without degrading when acks are fresh', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = TEST_HEALTH_TOKEN;
    const now = Math.floor(Date.now() / 1000);
    db.raw.prepare(
      `INSERT INTO fact_export_queue (fact_uid, fact_id, chat_jid, payload_json, state, created_at)
       VALUES ('fe_gaugefreshpend00000001', 'fresh-pending', 'seed-chat@g.us', '{}', 'pending', datetime('now', '-30 seconds'))`,
    ).run();
    db.raw.prepare(
      `INSERT INTO fact_export_queue (fact_uid, fact_id, chat_jid, payload_json, state, exported_at, acked_at, created_at)
       VALUES ('fe_gaugefreshack000000001', 'fresh-acked', 'seed-chat@g.us', '{}', 'exported', datetime('now'), ?, datetime('now', '-10 minutes'))`,
    ).run(now - 60);

    const { status, body } = await healthReq(port);
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.sqlite.fact_export_consumer_state).toBe('current');
    expect(json.sqlite.fact_export_latest_ack_age_s).toBeGreaterThanOrEqual(60);
    expect(json.sqlite.fact_export_latest_ack_age_s).toBeLessThan(300);
    expect(json.status_reasons ?? []).not.toContain('fact_export_consumer_missing');
  });

  it('returns 401 when no WHATSOUP_HEALTH_TOKEN is set (fail-closed)', async () => {
    // WHATSOUP_HEALTH_TOKEN not set — endpoint must reject (fail-closed)
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net', text: 'hello' });
    const { status, body } = await httpReq(port, '/send', 'POST', payload);
    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 400 when chatJid or text is missing', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
    const payload = JSON.stringify({ chatJid: '15550100001@s.whatsapp.net' });
    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer test-health-token-2515',
    });
    expect(status).toBe(400);
    expect(JSON.parse(body).ok).toBe(false);
  });

  it('returns 400 for invalid JSON body', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
    const { status } = await httpReq(port, '/send', 'POST', 'not-json', {
      authorization: 'Bearer test-health-token-2515',
    });
    expect(status).toBe(400);
  });

  it('rejects oversized /send bodies before parsing or dispatching', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';

    const { status, body } = await httpReq(port, '/send', 'POST', JSON.stringify({
      chatJid: '15550100001@s.whatsapp.net',
      text: 'x'.repeat(70_000),
    }), {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(status).toBe(413);
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'request body too large' });
    expect(deps.connectionManager.sendMessage).not.toHaveBeenCalled();
  });

  it('resolves aliases through the send pipeline before sending', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
    seedChatAliases(db.raw, { ops: '15550100002@s.whatsapp.net' });
    const payload = JSON.stringify({ to: 'ops', text: 'hello alias' });

    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(status).toBe(200);
    expect(JSON.parse(body).ok).toBe(true);
    expect(deps.connectionManager.sendMessage).toHaveBeenCalledWith(
      '15550100002@s.whatsapp.net',
      'hello alias',
      { caller: 'health' }, // QR-086: admin /send tags itself a system caller
    );
  });

  it('applies a named profile before sending', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
    const payload = JSON.stringify({
      chatJid: '15550100001@s.whatsapp.net',
      text: 'hello',
      profile: 'satellite',
    });

    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(status).toBe(200);
    expect(JSON.parse(body).ok).toBe(true);
    expect(deps.connectionManager.sendMessage).toHaveBeenCalledWith(
      '15550100001@s.whatsapp.net',
      '[SAT] hello #satellite',
      { caller: 'health' }, // QR-086: admin /send tags itself a system caller
    );
  });

  it('returns unknown profile without sending', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
    const payload = JSON.stringify({
      chatJid: '15550100001@s.whatsapp.net',
      text: 'hello',
      profile: 'missing',
    });

    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(status).toBe(400);
    expect(JSON.parse(body).error).toBe('unknown profile: missing');
    expect(deps.connectionManager.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects both chatJid and to without sending', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
    seedChatAliases(db.raw, { ops: '15550100002@s.whatsapp.net' });
    const payload = JSON.stringify({
      chatJid: '15550100001@s.whatsapp.net',
      to: 'ops',
      text: 'hello',
    });

    const { status, body } = await httpReq(port, '/send', 'POST', payload, {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(status).toBe(400);
    expect(JSON.parse(body).error).toMatch(/mutually exclusive/);
    expect(deps.connectionManager.sendMessage).not.toHaveBeenCalled();
  });
});
