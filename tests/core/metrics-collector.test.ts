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
}) {
  db.raw.prepare(`
    INSERT INTO messages (
      chat_jid, conversation_key, sender_jid, sender_name, message_id,
      content, content_type, is_from_me, timestamp, content_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  )
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
      { bucket, metric: 'messages_in', value: 2 },
      { bucket, metric: 'messages_media', value: 1 },
      { bucket, metric: 'messages_out', value: 1 },
    ])

    insertMessage(db, { timestamp: toUnixSeconds('2026-04-05T15:30:00.000Z'), fromMe: true, contentType: 'text', messageId: 'out-2' })

    collectHourlyMetrics(db, now)

    rows = db.raw.prepare(
      'SELECT bucket, metric, value FROM metrics_hourly WHERE bucket = ? ORDER BY metric',
    ).all(bucket) as Array<{ bucket: string; metric: string; value: number }>

    expect(rows).toEqual([
      { bucket, metric: 'messages_in', value: 2 },
      { bucket, metric: 'messages_media', value: 1 },
      { bucket, metric: 'messages_out', value: 2 },
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
      { bucket: '2026-04-05T14:00:00.000Z', metric: 'messages_in', value: 0 },
      { bucket: '2026-04-05T14:00:00.000Z', metric: 'messages_media', value: 1 },
      { bucket: '2026-04-05T14:00:00.000Z', metric: 'messages_out', value: 1 },
      { bucket: '2026-04-05T15:00:00.000Z', metric: 'messages_in', value: 1 },
      { bucket: '2026-04-05T15:00:00.000Z', metric: 'messages_media', value: 0 },
      { bucket: '2026-04-05T15:00:00.000Z', metric: 'messages_out', value: 0 },
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
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'messages_in', value: 0 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'messages_media', value: 0 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'messages_out', value: 0 },
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
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'messages_in', value: 1 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'messages_media', value: 1 },
      { bucket: '2026-04-05T16:00:00.000Z', metric: 'messages_out', value: 1 },
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
})
