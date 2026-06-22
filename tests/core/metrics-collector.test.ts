import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Database } from '../../src/core/database.ts'
import { backfillMetrics, collectHourlyMetrics } from '../../src/core/metrics-collector.ts'

function toUnixSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000)
}

function insertMessage(db: Database, opts: {
  timestamp: number
  fromMe?: boolean
  contentType?: string
  conversationKey?: string
  senderJid?: string
  messageId?: string
  deletedAt?: string | null
}) {
  db.raw.prepare(`
    INSERT INTO messages (
      chat_jid, conversation_key, sender_jid, sender_name, message_id,
      content, content_type, is_from_me, timestamp, content_text, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `${opts.conversationKey ?? 'chat'}@s.whatsapp.net`,
    opts.conversationKey ?? 'chat',
    opts.senderJid ?? '15550001111@s.whatsapp.net',
    'Tester',
    opts.messageId ?? `msg-${opts.timestamp}-${Math.random()}`,
    'hello',
    opts.contentType ?? 'text',
    opts.fromMe ? 1 : 0,
    opts.timestamp,
    'hello',
    opts.deletedAt ?? null,
  )
}

function insertAgentSession(db: Database, opts: {
  startedAt: string;
  endedAt?: string | null;
  status?: string;
  lastMessageAt?: string | null;
}): number {
  const result = db.raw.prepare(`
    INSERT INTO agent_sessions (claude_pid, started_in_directory, started_at, ended_at, status, last_message_at)
    VALUES (1, '/tmp', ?, ?, ?, ?)
  `).run(
    opts.startedAt,
    opts.endedAt ?? null,
    opts.status ?? 'active',
    opts.lastMessageAt ?? null,
  ) as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

function insertTokenEvent(db: Database, sessionId: number, timestamp: number, inputTokens: number, outputTokens: number) {
  db.raw.prepare(`
    INSERT INTO agent_token_events (agent_session_id, timestamp, input_tokens, output_tokens)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, timestamp, inputTokens, outputTokens);
}

function insertMessageWithTokens(db: Database, opts: {
  timestamp: number;
  fromMe?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  messageId?: string;
}) {
  db.raw.prepare(`
    INSERT INTO messages (
      chat_jid, conversation_key, sender_jid, sender_name, message_id,
      content, content_type, is_from_me, timestamp, content_text,
      input_tokens, output_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'chat@s.whatsapp.net',
    'chat',
    '15550001111@s.whatsapp.net',
    'Tester',
    opts.messageId ?? `msg-${opts.timestamp}-${Math.random()}`,
    'hello',
    'text',
    opts.fromMe ? 1 : 0,
    opts.timestamp,
    'hello',
    opts.inputTokens ?? 0,
    opts.outputTokens ?? 0,
  );
}

describe('metrics collector', () => {
  let db: Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.open()
  })

  afterEach(() => {
    db.close()
  })

  it('creates the metrics_hourly table via migration 15', () => {
    const table = db.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metrics_hourly'",
    ).get() as { name: string } | undefined

    const versions = db.raw.prepare(
      'SELECT version FROM schema_migrations WHERE version = 15',
    ).get() as { version: number } | undefined

    expect(table?.name).toBe('metrics_hourly')
    expect(versions?.version).toBe(15)
  })

  it('creates timestamp-window indexes used by metrics backfill', () => {
    const rows = db.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_messages_timestamp_%' ORDER BY name",
    ).all() as Array<{ name: string }>

    expect(rows.map((row) => row.name)).toEqual([
      'idx_messages_timestamp_content_type',
      'idx_messages_timestamp_from_me',
      'idx_messages_timestamp_input_tokens',
      'idx_messages_timestamp_output_tokens',
    ])
  })

  it('collects current-hour inbound, outbound, and media counts with upserts', () => {
    const now = new Date('2026-04-05T15:42:00.000Z')
    const bucket = '2026-04-05T15:00:00.000Z'

    insertMessage(db, { timestamp: toUnixSeconds('2026-04-05T15:01:00.000Z'), fromMe: false, contentType: 'text', messageId: 'in-1' })
    insertMessage(db, { timestamp: toUnixSeconds('2026-04-05T15:10:00.000Z'), fromMe: true, contentType: 'text', messageId: 'out-1' })
    insertMessage(db, { timestamp: toUnixSeconds('2026-04-05T15:20:00.000Z'), fromMe: false, contentType: 'image', messageId: 'media-1' })
    insertMessage(db, { timestamp: toUnixSeconds('2026-04-05T14:59:00.000Z'), fromMe: false, contentType: 'text', messageId: 'old-1' })

    collectHourlyMetrics(db, now)

    let rows = db.raw.prepare(
      'SELECT bucket, metric, value FROM metrics_hourly WHERE bucket = ? ORDER BY metric',
    ).all(bucket) as Array<{ bucket: string; metric: string; value: number }>

    expect(rows).toEqual([
      { bucket, metric: 'agent_tokens_in', value: 0 },
      { bucket, metric: 'agent_tokens_out', value: 0 },
      { bucket, metric: 'chat_tokens_in', value: 0 },
      { bucket, metric: 'chat_tokens_out', value: 0 },
      { bucket, metric: 'messages_in', value: 2 },
      { bucket, metric: 'messages_media', value: 1 },
      { bucket, metric: 'messages_out', value: 1 },
      { bucket, metric: 'sessions_active', value: 0 },
      { bucket, metric: 'sessions_started', value: 0 },
    ])

    insertMessage(db, { timestamp: toUnixSeconds('2026-04-05T15:30:00.000Z'), fromMe: true, contentType: 'text', messageId: 'out-2' })

    collectHourlyMetrics(db, now)

    rows = db.raw.prepare(
      'SELECT bucket, metric, value FROM metrics_hourly WHERE bucket = ? ORDER BY metric',
    ).all(bucket) as Array<{ bucket: string; metric: string; value: number }>

    expect(rows).toEqual([
      { bucket, metric: 'agent_tokens_in', value: 0 },
      { bucket, metric: 'agent_tokens_out', value: 0 },
      { bucket, metric: 'chat_tokens_in', value: 0 },
      { bucket, metric: 'chat_tokens_out', value: 0 },
      { bucket, metric: 'messages_in', value: 2 },
      { bucket, metric: 'messages_media', value: 1 },
      { bucket, metric: 'messages_out', value: 2 },
      { bucket, metric: 'sessions_active', value: 0 },
      { bucket, metric: 'sessions_started', value: 0 },
    ])
  })

  it('excludes soft-deleted messages from current-hour message volume metrics', () => {
    const now = new Date('2026-04-05T15:42:00.000Z')
    const bucket = '2026-04-05T15:00:00.000Z'

    insertMessage(db, {
      timestamp: toUnixSeconds('2026-04-05T15:01:00.000Z'),
      fromMe: false,
      contentType: 'text',
      messageId: 'active-in',
    })
    insertMessage(db, {
      timestamp: toUnixSeconds('2026-04-05T15:02:00.000Z'),
      fromMe: true,
      contentType: 'text',
      messageId: 'active-out',
    })
    insertMessage(db, {
      timestamp: toUnixSeconds('2026-04-05T15:03:00.000Z'),
      fromMe: false,
      contentType: 'image',
      messageId: 'deleted-in-media',
      deletedAt: '2026-04-05T15:30:00.000Z',
    })
    insertMessage(db, {
      timestamp: toUnixSeconds('2026-04-05T15:04:00.000Z'),
      fromMe: true,
      contentType: 'video',
      messageId: 'deleted-out-media',
      deletedAt: '2026-04-05T15:31:00.000Z',
    })

    collectHourlyMetrics(db, now)

    const rows = db.raw.prepare(
      "SELECT metric, value FROM metrics_hourly WHERE bucket = ? AND metric IN ('messages_in', 'messages_out', 'messages_media') ORDER BY metric",
    ).all(bucket) as Array<{ metric: string; value: number }>

    expect(rows).toEqual([
      { metric: 'messages_in', value: 1 },
      { metric: 'messages_media', value: 0 },
      { metric: 'messages_out', value: 1 },
    ])
  })

  it('backfills hourly metrics for the requested lookback window', () => {
    const now = new Date('2026-04-05T15:42:00.000Z')

    insertMessage(db, { timestamp: toUnixSeconds('2026-04-05T15:05:00.000Z'), fromMe: false, contentType: 'text', messageId: 'current-in' })
    insertMessage(db, { timestamp: toUnixSeconds('2026-04-05T14:15:00.000Z'), fromMe: true, contentType: 'audio', messageId: 'prev-out-media' })
    insertMessage(db, { timestamp: toUnixSeconds('2026-04-04T13:00:00.000Z'), fromMe: false, contentType: 'text', messageId: 'too-old' })

    backfillMetrics(db, 1, now)

    const rows = db.raw.prepare(
      'SELECT bucket, metric, value FROM metrics_hourly ORDER BY bucket, metric',
    ).all() as Array<{ bucket: string; metric: string; value: number }>

    expect(rows).toEqual([
      { bucket: '2026-04-05T14:00:00.000Z', metric: 'agent_tokens_in', value: 0 },
      { bucket: '2026-04-05T14:00:00.000Z', metric: 'agent_tokens_out', value: 0 },
      { bucket: '2026-04-05T14:00:00.000Z', metric: 'chat_tokens_in', value: 0 },
      { bucket: '2026-04-05T14:00:00.000Z', metric: 'chat_tokens_out', value: 0 },
      { bucket: '2026-04-05T14:00:00.000Z', metric: 'messages_in', value: 0 },
      { bucket: '2026-04-05T14:00:00.000Z', metric: 'messages_media', value: 1 },
      { bucket: '2026-04-05T14:00:00.000Z', metric: 'messages_out', value: 1 },
      { bucket: '2026-04-05T14:00:00.000Z', metric: 'sessions_active', value: 0 },
      { bucket: '2026-04-05T14:00:00.000Z', metric: 'sessions_started', value: 0 },
      { bucket: '2026-04-05T15:00:00.000Z', metric: 'agent_tokens_in', value: 0 },
      { bucket: '2026-04-05T15:00:00.000Z', metric: 'agent_tokens_out', value: 0 },
      { bucket: '2026-04-05T15:00:00.000Z', metric: 'chat_tokens_in', value: 0 },
      { bucket: '2026-04-05T15:00:00.000Z', metric: 'chat_tokens_out', value: 0 },
      { bucket: '2026-04-05T15:00:00.000Z', metric: 'messages_in', value: 1 },
      { bucket: '2026-04-05T15:00:00.000Z', metric: 'messages_media', value: 0 },
      { bucket: '2026-04-05T15:00:00.000Z', metric: 'messages_out', value: 0 },
      { bucket: '2026-04-05T15:00:00.000Z', metric: 'sessions_active', value: 0 },
      { bucket: '2026-04-05T15:00:00.000Z', metric: 'sessions_started', value: 0 },
    ])
  })

  it('collects zero-valued metrics for an empty current hour', () => {
    const now = new Date('2026-04-05T16:05:00.000Z')

    insertMessage(db, { timestamp: toUnixSeconds('2026-04-05T15:59:59.000Z'), fromMe: false, contentType: 'text', messageId: 'previous-hour-only' })

    collectHourlyMetrics(db, now)

    const rows = db.raw.prepare(
      'SELECT bucket, metric, value FROM metrics_hourly WHERE bucket = ? ORDER BY metric',
    ).all('2026-04-05T16:00:00.000Z') as Array<{ bucket: string; metric: string; value: number }>

    expect(rows).toEqual([
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'agent_tokens_in', value: 0 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'agent_tokens_out', value: 0 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'chat_tokens_in', value: 0 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'chat_tokens_out', value: 0 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'messages_in', value: 0 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'messages_media', value: 0 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'messages_out', value: 0 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'sessions_active', value: 0 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'sessions_started', value: 0 },
    ])
  })

  it('treats hour boundaries as inclusive start and exclusive end', () => {
    const now = new Date('2026-04-05T16:30:00.000Z')

    insertMessage(db, { timestamp: toUnixSeconds('2026-04-05T16:00:00.000Z'), fromMe: false, contentType: 'text', messageId: 'boundary-start' })
    insertMessage(db, { timestamp: toUnixSeconds('2026-04-05T16:59:59.000Z'), fromMe: true, contentType: 'image', messageId: 'boundary-end-minus-one' })
    insertMessage(db, { timestamp: toUnixSeconds('2026-04-05T17:00:00.000Z'), fromMe: false, contentType: 'text', messageId: 'next-hour-start' })

    collectHourlyMetrics(db, now)

    const rows = db.raw.prepare(
      'SELECT bucket, metric, value FROM metrics_hourly WHERE bucket = ? ORDER BY metric',
    ).all('2026-04-05T16:00:00.000Z') as Array<{ bucket: string; metric: string; value: number }>

    expect(rows).toEqual([
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'agent_tokens_in', value: 0 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'agent_tokens_out', value: 0 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'chat_tokens_in', value: 0 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'chat_tokens_out', value: 0 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'messages_in', value: 1 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'messages_media', value: 1 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'messages_out', value: 1 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'sessions_active', value: 0 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'sessions_started', value: 0 },
    ])
  })

  it('backfills only hours that contain messages and preserves gaps', () => {
    const now = new Date('2026-04-05T18:30:00.000Z')

    insertMessage(db, { timestamp: toUnixSeconds('2026-04-05T18:05:00.000Z'), fromMe: false, contentType: 'text', messageId: 'current-hour' })
    insertMessage(db, { timestamp: toUnixSeconds('2026-04-05T16:15:00.000Z'), fromMe: true, contentType: 'document', messageId: 'two-hours-back' })

    backfillMetrics(db, 1, now)

    const buckets = db.raw.prepare(
      'SELECT DISTINCT bucket FROM metrics_hourly ORDER BY bucket',
    ).all() as Array<{ bucket: string }>

    expect(buckets).toEqual([
      { bucket: '2026-04-05T16:00:00.000Z' },
      { bucket: '2026-04-05T18:00:00.000Z' },
    ])
  })

  it('collects agent_tokens_in and agent_tokens_out from agent_token_events', () => {
    const now = new Date('2026-04-05T15:42:00.000Z');
    const bucket = '2026-04-05T15:00:00.000Z';
    const sessionId = insertAgentSession(db, { startedAt: '2026-04-05T15:00:00.000Z', status: 'active' });

    insertTokenEvent(db, sessionId, toUnixSeconds('2026-04-05T15:05:00.000Z'), 100, 50);
    insertTokenEvent(db, sessionId, toUnixSeconds('2026-04-05T15:30:00.000Z'), 200, 75);
    // Outside window — should NOT be counted
    insertTokenEvent(db, sessionId, toUnixSeconds('2026-04-05T14:59:00.000Z'), 999, 999);

    collectHourlyMetrics(db, now);

    const rows = db.raw.prepare(
      "SELECT metric, value FROM metrics_hourly WHERE bucket = ? AND metric IN ('agent_tokens_in', 'agent_tokens_out') ORDER BY metric"
    ).all(bucket) as Array<{ metric: string; value: number }>;

    expect(rows).toEqual([
      { metric: 'agent_tokens_in', value: 300 },
      { metric: 'agent_tokens_out', value: 125 },
    ]);
  });

  it('collects chat_tokens_in and chat_tokens_out from messages table', () => {
    const now = new Date('2026-04-05T15:42:00.000Z');
    const bucket = '2026-04-05T15:00:00.000Z';

    insertMessageWithTokens(db, {
      timestamp: toUnixSeconds('2026-04-05T15:05:00.000Z'),
      fromMe: true,
      inputTokens: 80,
      outputTokens: 40,
      messageId: 'chat-tok-1',
    });
    insertMessageWithTokens(db, {
      timestamp: toUnixSeconds('2026-04-05T15:20:00.000Z'),
      fromMe: true,
      inputTokens: 120,
      outputTokens: 60,
      messageId: 'chat-tok-2',
    });
    // Zero-token message — should NOT be counted
    insertMessageWithTokens(db, {
      timestamp: toUnixSeconds('2026-04-05T15:25:00.000Z'),
      fromMe: false,
      inputTokens: 0,
      outputTokens: 0,
      messageId: 'chat-tok-3',
    });

    collectHourlyMetrics(db, now);

    const rows = db.raw.prepare(
      "SELECT metric, value FROM metrics_hourly WHERE bucket = ? AND metric LIKE 'chat_tokens_%' ORDER BY metric"
    ).all(bucket) as Array<{ metric: string; value: number }>;

    expect(rows).toEqual([
      { metric: 'chat_tokens_in', value: 200 },
      { metric: 'chat_tokens_out', value: 100 },
    ]);
  });

  it('collects sessions_active counting overlapping sessions excluding suspended', () => {
    const now = new Date('2026-04-05T15:42:00.000Z');
    const bucket = '2026-04-05T15:00:00.000Z';

    // Session spanning the entire hour (started before, still active)
    insertAgentSession(db, {
      startedAt: '2026-04-05T14:00:00.000Z',
      endedAt: null,
      status: 'active',
    });
    // Session that started and ended within the hour
    insertAgentSession(db, {
      startedAt: '2026-04-05T15:10:00.000Z',
      endedAt: '2026-04-05T15:40:00.000Z',
      status: 'ended',
    });
    // Suspended session — should NOT be counted
    insertAgentSession(db, {
      startedAt: '2026-04-05T15:00:00.000Z',
      endedAt: null,
      status: 'suspended',
    });
    // Session that ended before the hour — should NOT be counted
    insertAgentSession(db, {
      startedAt: '2026-04-05T13:00:00.000Z',
      endedAt: '2026-04-05T14:30:00.000Z',
      status: 'ended',
    });

    collectHourlyMetrics(db, now);

    const row = db.raw.prepare(
      "SELECT value FROM metrics_hourly WHERE bucket = ? AND metric = 'sessions_active'"
    ).get(bucket) as { value: number } | undefined;

    expect(row?.value).toBe(2);
  });

  it('collects sessions_started counting only sessions starting in the hour', () => {
    const now = new Date('2026-04-05T15:42:00.000Z');
    const bucket = '2026-04-05T15:00:00.000Z';

    // Started inside the hour
    insertAgentSession(db, { startedAt: '2026-04-05T15:05:00.000Z', status: 'active' });
    insertAgentSession(db, { startedAt: '2026-04-05T15:30:00.000Z', status: 'ended', endedAt: '2026-04-05T15:45:00.000Z' });
    // Started outside the hour — should NOT be counted
    insertAgentSession(db, { startedAt: '2026-04-05T14:55:00.000Z', status: 'active' });

    collectHourlyMetrics(db, now);

    const row = db.raw.prepare(
      "SELECT value FROM metrics_hourly WHERE bucket = ? AND metric = 'sessions_started'"
    ).get(bucket) as { value: number } | undefined;

    expect(row?.value).toBe(2);
  });

  it('collects per-provider agent token metrics', () => {
    const now = new Date('2026-04-05T15:42:00.000Z');
    const bucket = '2026-04-05T15:00:00.000Z';

    const s1 = insertAgentSession(db, { startedAt: '2026-04-05T15:00:00.000Z', status: 'active' });
    db.raw.prepare('UPDATE agent_sessions SET provider = ? WHERE id = ?').run('claude-cli', s1);
    insertTokenEvent(db, s1, toUnixSeconds('2026-04-05T15:05:00.000Z'), 100, 50);

    const s2 = insertAgentSession(db, { startedAt: '2026-04-05T15:00:00.000Z', status: 'active' });
    db.raw.prepare('UPDATE agent_sessions SET provider = ? WHERE id = ?').run('codex-cli', s2);
    insertTokenEvent(db, s2, toUnixSeconds('2026-04-05T15:10:00.000Z'), 200, 75);

    collectHourlyMetrics(db, now);

    // Aggregate keys still written
    const aggIn = db.raw.prepare(
      "SELECT value FROM metrics_hourly WHERE bucket = ? AND metric = 'agent_tokens_in'"
    ).get(bucket) as { value: number };
    expect(aggIn.value).toBe(300);

    // Per-provider keys also written
    const claudeIn = db.raw.prepare(
      "SELECT value FROM metrics_hourly WHERE bucket = ? AND metric = 'agent_tokens_in:claude-cli'"
    ).get(bucket) as { value: number } | undefined;
    expect(claudeIn?.value).toBe(100);

    const codexIn = db.raw.prepare(
      "SELECT value FROM metrics_hourly WHERE bucket = ? AND metric = 'agent_tokens_in:codex-cli'"
    ).get(bucket) as { value: number } | undefined;
    expect(codexIn?.value).toBe(200);
  });

  it('collects per-provider session metrics', () => {
    const now = new Date('2026-04-05T15:42:00.000Z');
    const bucket = '2026-04-05T15:00:00.000Z';

    insertAgentSession(db, { startedAt: '2026-04-05T15:05:00.000Z', status: 'active' });
    db.raw.prepare("UPDATE agent_sessions SET provider = 'claude-cli' WHERE id = (SELECT MAX(id) FROM agent_sessions)").run();

    insertAgentSession(db, { startedAt: '2026-04-05T15:10:00.000Z', status: 'active' });
    db.raw.prepare("UPDATE agent_sessions SET provider = 'codex-cli' WHERE id = (SELECT MAX(id) FROM agent_sessions)").run();

    insertAgentSession(db, { startedAt: '2026-04-05T15:15:00.000Z', status: 'active' });
    db.raw.prepare("UPDATE agent_sessions SET provider = 'codex-cli' WHERE id = (SELECT MAX(id) FROM agent_sessions)").run();

    collectHourlyMetrics(db, now);

    const claudeStarted = db.raw.prepare(
      "SELECT value FROM metrics_hourly WHERE bucket = ? AND metric = 'sessions_started:claude-cli'"
    ).get(bucket) as { value: number } | undefined;
    expect(claudeStarted?.value).toBe(1);

    const codexStarted = db.raw.prepare(
      "SELECT value FROM metrics_hourly WHERE bucket = ? AND metric = 'sessions_started:codex-cli'"
    ).get(bucket) as { value: number } | undefined;
    expect(codexStarted?.value).toBe(2);

    // Aggregate unchanged
    const totalStarted = db.raw.prepare(
      "SELECT value FROM metrics_hourly WHERE bucket = ? AND metric = 'sessions_started'"
    ).get(bucket) as { value: number };
    expect(totalStarted.value).toBe(3);
  });

  it('backfill iterates every hour for session metrics, not just active hours', () => {
    const now = new Date('2026-04-05T18:30:00.000Z');

    // Session spanning hours 15-17 (no messages in hours 16-17)
    insertAgentSession(db, {
      startedAt: '2026-04-05T15:00:00.000Z',
      endedAt: '2026-04-05T17:30:00.000Z',
      status: 'ended',
    });

    // A single message in hour 15 to give the backfill something for message metrics
    insertMessage(db, {
      timestamp: toUnixSeconds('2026-04-05T15:05:00.000Z'),
      fromMe: false,
      contentType: 'text',
      messageId: 'backfill-session-msg',
    });

    backfillMetrics(db, 1, now);

    // sessions_active should appear in hours 15, 16, and 17
    const activeRows = db.raw.prepare(
      "SELECT bucket, value FROM metrics_hourly WHERE metric = 'sessions_active' AND value > 0 ORDER BY bucket"
    ).all() as Array<{ bucket: string; value: number }>;

    expect(activeRows.length).toBeGreaterThanOrEqual(3);
    expect(activeRows.map(r => r.bucket)).toContain('2026-04-05T15:00:00.000Z');
    expect(activeRows.map(r => r.bucket)).toContain('2026-04-05T16:00:00.000Z');
    expect(activeRows.map(r => r.bucket)).toContain('2026-04-05T17:00:00.000Z');
  });
})
