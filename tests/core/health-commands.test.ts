import { httpReq, buildTestServer, makeDb, makeDeps } from './_helpers/health.ts';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { request } from 'node:http';
import { Database } from '../../src/core/database.ts';
import { ConnectionManager } from '../../src/transport/connection.ts';
import { emptyConnectionStateSnapshot } from '../../src/transport/twilio/connection-snapshot.ts';

describe('POST /agent/compact', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
  });

  afterEach(async () => {
    db.close();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('requires the health bearer token', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand: vi.fn(),
      } as any,
    })));

    const { status, body } = await httpReq(port, '/agent/compact', 'POST', '{}');

    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
  });

  it('routes compact directly to the agent runtime and defaults to silent mode', async () => {
    const handleAgentCommand = vi.fn().mockResolvedValue({
      ok: true,
      command: 'compact',
      chatJid: 'test-group@g.us',
      silent: true,
    });
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand,
      } as any,
    })));

    const { status, body } = await httpReq(
      port,
      '/agent/compact',
      'POST',
      JSON.stringify({ chatJid: 'test-group@g.us' }),
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({
      ok: true,
      command: 'compact',
      chatJid: 'test-group@g.us',
      silent: true,
    });
    expect(handleAgentCommand).toHaveBeenCalledWith({
      command: 'compact',
      chatJid: 'test-group@g.us',
      silent: true,
    });
  });

  it('allows explicit non-silent compact for operator-triggered diagnostics', async () => {
    const handleAgentCommand = vi.fn().mockResolvedValue({
      ok: true,
      command: 'compact',
      chatJid: 'test-group@g.us',
      silent: false,
    });
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand,
      } as any,
    })));

    const { status } = await httpReq(
      port,
      '/agent/compact',
      'POST',
      JSON.stringify({ chatJid: 'test-group@g.us', silent: false }),
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(status).toBe(200);
    expect(handleAgentCommand).toHaveBeenCalledWith({
      command: 'compact',
      chatJid: 'test-group@g.us',
      silent: false,
    });
  });

  it('rejects non-agent instances', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(port, '/agent/compact', 'POST', '{}', {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(status).toBe(409);
    expect(JSON.parse(body)).toMatchObject({
      ok: false,
      error: 'agent commands are only available on agent instances',
    });
  });

  it('maps runtime command errors to HTTP status and code', async () => {
    const err = Object.assign(new Error('agent session is not active'), {
      code: 'session_inactive',
      statusCode: 409,
    });
    const handleAgentCommand = vi.fn().mockRejectedValue(err);
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand,
      } as any,
    })));

    const { status, body } = await httpReq(port, '/agent/compact', 'POST', '{}', {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(status).toBe(409);
    expect(JSON.parse(body)).toMatchObject({
      ok: false,
      error: 'agent session is not active',
      code: 'session_inactive',
    });
  });

  it('validates request body types before dispatching to the runtime', async () => {
    const handleAgentCommand = vi.fn();
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand,
      } as any,
    })));

    const { status, body } = await httpReq(
      port,
      '/agent/compact',
      'POST',
      JSON.stringify({ chatJid: 123 }),
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({ ok: false, error: 'chatJid must be a string when provided' });
    expect(handleAgentCommand).not.toHaveBeenCalled();
  });

  it('rejects non-object JSON bodies before dispatching to the runtime', async () => {
    const handleAgentCommand = vi.fn();
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand,
      } as any,
    })));

    const { status, body } = await httpReq(
      port,
      '/agent/compact',
      'POST',
      'null',
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({ ok: false, error: 'request body must be a JSON object' });
    expect(handleAgentCommand).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON before dispatching to the runtime', async () => {
    const handleAgentCommand = vi.fn();
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand,
      } as any,
    })));

    const { status, body } = await httpReq(port, '/agent/compact', 'POST', '{', {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(status).toBe(400);
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'invalid JSON' });
    expect(handleAgentCommand).not.toHaveBeenCalled();
  });

  it('rejects oversized compact requests before dispatching to the runtime', async () => {
    const handleAgentCommand = vi.fn();
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand,
      } as any,
    })));

    const { status, body } = await httpReq(port, '/agent/compact', 'POST', JSON.stringify({ pad: 'x'.repeat(70_000) }), {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(status).toBe(413);
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'request body too large' });
    expect(handleAgentCommand).not.toHaveBeenCalled();
  });

  it('rejects non-boolean silent before dispatching to the runtime', async () => {
    const handleAgentCommand = vi.fn();
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand,
      } as any,
    })));

    const { status, body } = await httpReq(
      port,
      '/agent/compact',
      'POST',
      JSON.stringify({ silent: 'false' }),
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(status).toBe(400);
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'silent must be a boolean when provided' });
    expect(handleAgentCommand).not.toHaveBeenCalled();
  });

  it('maps runtime errors without a valid statusCode to a 500 JSON response', async () => {
    const err = Object.assign(new Error('compact worker crashed'), {
      code: 123,
      statusCode: 302,
    });
    const handleAgentCommand = vi.fn().mockRejectedValue(err);
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: {
        handleAgentCommand,
      } as any,
    })));

    const { status, body } = await httpReq(port, '/agent/compact', 'POST', '{}', {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(status).toBe(500);
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'compact worker crashed' });
  });
});

describe('health command endpoints — malformed bodies and side effects', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
  });

  afterEach(async () => {
    db.close();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects non-object /heal bodies instead of treating them as server errors', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(port, '/heal', 'POST', 'null', {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(status).toBe(400);
    expect(JSON.parse(body)).toEqual({ error: 'request body must be a JSON object' });
  });

  it('rejects malformed, missing-type, and oversized /heal bodies', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const malformed = await httpReq(port, '/heal', 'POST', '{', {
      authorization: 'Bearer test-health-token-2515',
    });
    const missingType = await httpReq(port, '/heal', 'POST', '{}', {
      authorization: 'Bearer test-health-token-2515',
    });
    const oversized = await httpReq(port, '/heal', 'POST', JSON.stringify({ type: 'service_crash', pad: 'x'.repeat(70_000) }), {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toEqual({ error: 'invalid JSON' });
    expect(missingType.status).toBe(400);
    expect(JSON.parse(missingType.body)).toEqual({ error: 'missing type field' });
    expect(oversized.status).toBe(413);
    expect(JSON.parse(oversized.body)).toEqual({ error: 'request body too large' });
  });

  it('rejects non-string /heal type values', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(port, '/heal', 'POST', JSON.stringify({ type: 123 }), {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(status).toBe(400);
    expect(JSON.parse(body)).toEqual({ error: 'type must be a string' });
  });

  it('stores heal reports, dispatches the runtime turn, and rejects unresolved duplicates', async () => {
    const handleControlTurn = vi.fn().mockResolvedValue(undefined);
    ({ server, port } = await buildTestServer(makeDeps(db, {
      runtime: { handleControlTurn } as any,
    })));
    const payload = JSON.stringify({
      reportId: 'report-1',
      type: 'service_crash',
      errorHint: 'systemd unit exited',
    });

    const first = await httpReq(port, '/heal', 'POST', payload, {
      authorization: 'Bearer test-health-token-2515',
    });
    const second = await httpReq(port, '/heal', 'POST', payload, {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(first.status).toBe(202);
    const firstBody = JSON.parse(first.body);
    expect(firstBody.reportId).toBe('report-1');
    expect(typeof firstBody.errorClass).toBe('string');
    expect(handleControlTurn).toHaveBeenCalledWith(
      'report-1',
      expect.stringContaining('"reportId":"report-1"'),
    );
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body)).toEqual({
      error: 'duplicate',
      existingReportId: 'report-1',
    });
  });

  it('rejects heal when dispatch throws (#2549)', async () => {
    const handleControlTurn = vi.fn().mockRejectedValue(new Error('runtime unavailable'));
    ({ server, port } = await buildTestServer(makeDeps(db, {
      runtime: { handleControlTurn } as any,
    })));
    const payload = JSON.stringify({
      reportId: 'report-reject',
      type: 'service_crash',
    });

    const res = await httpReq(port, '/heal', 'POST', payload, {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error).toBe('dispatch_rejected');
    // Row must be rolled back — retry should work
    const retry = await httpReq(port, '/heal', 'POST', payload, {
      authorization: 'Bearer test-health-token-2515',
    });
    expect(retry.status).toBe(502); // still rejected; not 409 (no orphan)
  });

  it('rejects heal when no runtime exists (#2549)', async () => {
    // No runtime at all — no dispatch possible
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const res = await httpReq(port, '/heal', 'POST',
      JSON.stringify({ reportId: 'report-no-rt', type: 'service_crash' }),
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error).toBe('dispatch_rejected');
    // Row rolled back — same request can be retried
    const retry = await httpReq(port, '/heal', 'POST',
      JSON.stringify({ reportId: 'report-no-rt-2', type: 'service_crash' }),
      { authorization: 'Bearer test-health-token-2515' },
    );
    expect(retry.status).toBe(502);
  });

  it('returns a 500 JSON response when /heal persistence unexpectedly fails', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));
    db.raw.prepare('DROP TABLE pending_heal_reports').run();

    const { status, body } = await httpReq(
      port,
      '/heal',
      'POST',
      JSON.stringify({ reportId: 'report-db-failure', type: 'service_crash' }),
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: 'internal error' });
  });

  it('rejects non-object /access bodies and scalar subject ids', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const nonObject = await httpReq(port, '/access', 'POST', 'null', {
      authorization: 'Bearer test-health-token-2515',
    });
    const scalarSubject = await httpReq(
      port,
      '/access',
      'POST',
      JSON.stringify({ subjectType: 'phone', subjectId: 123, action: 'allow' }),
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(nonObject.status).toBe(400);
    expect(JSON.parse(nonObject.body)).toEqual({ error: 'request body must be a JSON object' });
    expect(scalarSubject.status).toBe(400);
    expect(JSON.parse(scalarSubject.body)).toEqual({ error: 'subjectType, subjectId, and action are required' });
  });

  it('rejects malformed and oversized /access bodies before changing access state', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const malformed = await httpReq(port, '/access', 'POST', '{', {
      authorization: 'Bearer test-health-token-2515',
    });
    const oversized = await httpReq(port, '/access', 'POST', JSON.stringify({
      subjectType: 'phone',
      subjectId: '15551234567',
      action: 'allow',
      pad: 'x'.repeat(70_000),
    }), {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(malformed.status).toBe(400);
    expect(JSON.parse(malformed.body)).toEqual({ error: 'invalid JSON' });
    expect(oversized.status).toBe(413);
    expect(JSON.parse(oversized.body)).toEqual({ error: 'request body too large' });
    expect(db.raw.prepare('SELECT COUNT(*) AS cnt FROM access_list').get()).toEqual({ cnt: 0 });
  });

  it('rejects invalid /access subject type and action values', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const invalidSubjectType = await httpReq(
      port,
      '/access',
      'POST',
      JSON.stringify({ subjectType: 'channel', subjectId: '15551234567', action: 'allow' }),
      { authorization: 'Bearer test-health-token-2515' },
    );
    const invalidAction = await httpReq(
      port,
      '/access',
      'POST',
      JSON.stringify({ subjectType: 'phone', subjectId: '15551234567', action: 'mute' }),
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(invalidSubjectType.status).toBe(400);
    expect(JSON.parse(invalidSubjectType.body)).toEqual({ error: 'subjectType must be "phone" or "group"' });
    expect(invalidAction.status).toBe(400);
    expect(JSON.parse(invalidAction.body)).toEqual({ error: 'action must be "allow" or "block"' });
  });

  it('updates access and keeps the 200 response when replay callback fails', async () => {
    const handleAccessDecision = vi.fn().mockRejectedValue(new Error('replay failed'));
    ({ server, port } = await buildTestServer(makeDeps(db, { handleAccessDecision })));

    const { status, body } = await httpReq(
      port,
      '/access',
      'POST',
      JSON.stringify({ subjectType: 'phone', subjectId: '15551234567', action: 'allow' }),
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      ok: true,
      action: 'allow',
      subjectType: 'phone',
      subjectId: '15551234567',
      result: 'inserted',
    });
    expect(handleAccessDecision).toHaveBeenCalledWith('phone', '15551234567', 'allow');
    const row = db.raw
      .prepare('SELECT subject_type, subject_id, status FROM access_list WHERE subject_id = ?')
      .get('15551234567');
    expect(row).toEqual({ subject_type: 'phone', subject_id: '15551234567', status: 'allowed' });
  });

  it('returns a 500 JSON response when /access persistence unexpectedly fails', async () => {
    const handleAccessDecision = vi.fn();
    ({ server, port } = await buildTestServer(makeDeps(db, { handleAccessDecision })));
    db.raw.prepare('DROP TABLE access_list').run();

    const { status, body } = await httpReq(
      port,
      '/access',
      'POST',
      JSON.stringify({ subjectType: 'phone', subjectId: '15551234567', action: 'allow' }),
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: 'internal error' });
    expect(handleAccessDecision).not.toHaveBeenCalled();
  });

  it('rejects non-object and missing /mark-read bodies before touching chat state', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const nonObject = await httpReq(port, '/mark-read', 'POST', 'null', {
      authorization: 'Bearer test-health-token-2515',
    });
    const missingKey = await httpReq(port, '/mark-read', 'POST', '{}', {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(nonObject.status).toBe(400);
    expect(JSON.parse(nonObject.body)).toEqual({ error: 'request body must be a JSON object' });
    expect(missingKey.status).toBe(400);
    expect(JSON.parse(missingKey.body)).toEqual({ error: 'conversation_key is required' });
  });

  it('rejects malformed /mark-read JSON before touching chat state', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(port, '/mark-read', 'POST', '{', {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(status).toBe(400);
    expect(JSON.parse(body)).toEqual({ error: 'invalid JSON' });
  });

  it('rejects oversized /mark-read bodies before touching chat state', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(port, '/mark-read', 'POST', JSON.stringify({
      conversation_key: '15551234567',
      pad: 'x'.repeat(70_000),
    }), {
      authorization: 'Bearer test-health-token-2515',
    });

    expect(status).toBe(413);
    expect(JSON.parse(body)).toEqual({ error: 'request body too large' });
  });

  it('returns 404 for /mark-read when the conversation key is unknown', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(
      port,
      '/mark-read',
      'POST',
      JSON.stringify({ conversation_key: 'missing-chat' }),
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(status).toBe(404);
    expect(JSON.parse(body)).toEqual({ error: 'chat not found', conversation_key: 'missing-chat' });
  });

  it('marks a conversation read through the health endpoint', async () => {
    const baseDeps = makeDeps(db);
    const connectionManager = {
      ...baseDeps.connectionManager,
      getSocket: vi.fn(() => null),
    } as unknown as ConnectionManager;
    ({ server, port } = await buildTestServer(makeDeps(db, { connectionManager })));
    db.raw
      .prepare('INSERT INTO chats (jid, conversation_key, unread_count) VALUES (?, ?, ?)')
      .run('15551234567@s.whatsapp.net', '15551234567', 4);

    const { status, body } = await httpReq(
      port,
      '/mark-read',
      'POST',
      JSON.stringify({ conversation_key: '15551234567' }),
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(status).toBe(200);
    // `remote` reaches the HTTP body because the handler serialises the result
    // verbatim; no socket and no messages means there was no receipt to send.
    expect(JSON.parse(body)).toEqual({
      ok: true,
      jid: '15551234567@s.whatsapp.net',
      conversation_key: '15551234567',
      remote: 'nothing_to_ack',
    });
    const row = db.raw
      .prepare('SELECT unread_count FROM chats WHERE conversation_key = ?')
      .get('15551234567') as { unread_count: number };
    expect(row.unread_count).toBe(0);
  });

  it('returns a 500 JSON response when /mark-read persistence unexpectedly fails', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));
    db.raw.prepare('DROP TABLE chats').run();

    const { status, body } = await httpReq(
      port,
      '/mark-read',
      'POST',
      JSON.stringify({ conversation_key: '15551234567' }),
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: 'internal error' });
  });
});

// ---------------------------------------------------------------------------
// GET /typing — Authorization header check (issue #389)
// ---------------------------------------------------------------------------

describe('GET /typing — Authorization header check', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    const presenceCache = {
      getAll: () => new Map<string, { status: string; updatedAt: number }>([
        ['15550100001@s.whatsapp.net', { status: 'composing', updatedAt: 1700000000000 }],
        ['15550100002@s.whatsapp.net', { status: 'available', updatedAt: 1700000001000 }],
      ]).entries(),
    };
    const deps = makeDeps(db, {
      connectionManager: {
        botJid: '15550199000@s.whatsapp.net',
        botLid: null,
        sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
        sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getConnectionState: vi.fn(() => emptyConnectionStateSnapshot({
          connected: true,
          stateChangedAt: '2026-07-30T00:00:00.000Z',
          lastDisconnectReason: null,
        })),
        presenceCache,
      } as unknown as ConnectionManager,
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
    const { status, body } = await httpReq(port, '/typing', 'GET');
    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when Bearer token does not match', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
    const { status } = await httpReq(port, '/typing', 'GET', undefined, {
      authorization: 'Bearer wrong-token',
    });
    expect(status).toBe(401);
  });

  it('returns 401 when no WHATSOUP_HEALTH_TOKEN is set', async () => {
    const { status, body } = await httpReq(port, '/typing', 'GET', undefined, {
      authorization: 'Bearer any-token',
    });
    expect(status).toBe(401);
    expect(JSON.parse(body)).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 200 with composing payload when Bearer token matches', async () => {
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
    const { status, body } = await httpReq(port, '/typing', 'GET', undefined, {
      authorization: 'Bearer test-health-token-2515',
    });
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(Array.isArray(json.composing)).toBe(true);
    expect(json.composing).toEqual([
      { jid: '15550100001@s.whatsapp.net', since: 1700000000000 },
    ]);
  });
});

describe('POST /agent/compact — empty body treated as {}', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
  });

  afterEach(async () => {
    db.close();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('treats an empty body as {} and dispatches compact with default options', async () => {
    const handleAgentCommand = vi.fn().mockResolvedValue({ ok: true, command: 'compact' });
    ({ server, port } = await buildTestServer(makeDeps(db, {
      instanceType: 'agent',
      runtime: { handleAgentCommand } as any,
    })));

    // Send a truly empty body (no bytes)
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1',
        port,
        path: '/agent/compact',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authorization': 'Bearer test-health-token-2515',
          'Content-Length': '0',
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      req.on('error', reject);
      req.end();
    });

    expect(result.status).toBe(200);
    expect(handleAgentCommand).toHaveBeenCalledWith({ command: 'compact', silent: true });
  });
});

describe('POST /heal — readBody error path', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    db = makeDb();
    process.env.WHATSOUP_HEALTH_TOKEN = 'test-health-token-2515';
  });

  afterEach(async () => {
    db.close();
    delete process.env.WHATSOUP_HEALTH_TOKEN;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 413 when /heal body exceeds the size limit via readBody', async () => {
    ({ server, port } = await buildTestServer(makeDeps(db)));

    const { status, body } = await httpReq(
      port,
      '/heal',
      'POST',
      JSON.stringify({ type: 'service_crash', pad: 'x'.repeat(70_000) }),
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(status).toBe(413);
    expect(JSON.parse(body)).toMatchObject({ error: 'request body too large' });
  });

  it('uses context field as fallback when errorHint is absent', async () => {
    const handleControlTurn = vi.fn().mockResolvedValue(undefined);
    ({ server, port } = await buildTestServer(makeDeps(db, {
      runtime: { handleControlTurn } as any,
    })));

    const { status, body } = await httpReq(
      port,
      '/heal',
      'POST',
      JSON.stringify({ type: 'service_crash', context: 'systemd-restart' }),
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(status).toBe(202);
    const json = JSON.parse(body);
    expect(typeof json.reportId).toBe('string');
    expect(typeof json.errorClass).toBe('string');
  });

  it('generates a fresh UUID when reportId is absent', async () => {
    const handleControlTurn = vi.fn().mockResolvedValue(undefined);
    ({ server, port } = await buildTestServer(makeDeps(db, {
      runtime: { handleControlTurn } as any,
    })));

    const { status, body } = await httpReq(
      port,
      '/heal',
      'POST',
      JSON.stringify({ type: 'service_crash' }),
      { authorization: 'Bearer test-health-token-2515' },
    );

    expect(status).toBe(202);
    const json = JSON.parse(body);
    // UUID v4 format
    expect(json.reportId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});
