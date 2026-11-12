import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../helpers/resolved-tool-registry.ts';
import { registerChatManagementTools } from '../../../src/mcp/tools/chat-management.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import type { WhatsAppSocket } from '../../../src/transport/connection.ts';

// list_chats used to pick each paged conversation's latest message with a CTE
// that copied every column of every message into a window-function sort
// (~230 MB of SQLite temp files per call on a 36k-message instance). The
// query below is that legacy statement, frozen verbatim as the result oracle:
// the indexed per-conversation lookup must return exactly the same rows.
const LEGACY_LIST_CHATS_SQL = `WITH base_conversation_rows AS (
    SELECT m.conversation_key,
           COALESCE(c.jid, (
             SELECT m2.chat_jid
             FROM messages m2
             WHERE m2.conversation_key = m.conversation_key
               AND m2.deleted_at IS NULL
             ORDER BY m2.timestamp DESC, m2.pk DESC
             LIMIT 1
           )) AS chat_jid,
           MAX(m.timestamp) AS last_timestamp,
           COUNT(*) AS message_count,
           c.name,
           c.unread_count,
           c.is_archived,
           c.is_pinned,
           c.mute_until,
           c.ephemeral_duration
    FROM messages m
    LEFT JOIN chats c ON c.conversation_key = m.conversation_key
    WHERE m.deleted_at IS NULL
    GROUP BY m.conversation_key

    UNION ALL

    SELECT c2.conversation_key,
           c2.jid AS chat_jid,
           NULL AS last_timestamp,
           0 AS message_count,
           c2.name,
           c2.unread_count,
           c2.is_archived,
           c2.is_pinned,
           c2.mute_until,
           c2.ephemeral_duration
    FROM chats c2
    WHERE c2.conversation_key NOT IN (
      SELECT DISTINCT conversation_key FROM messages WHERE deleted_at IS NULL
    )
  ), conversation_rows AS (
    SELECT b.*, lm.phone_jid
    FROM base_conversation_rows b
    LEFT JOIN lid_mappings lm
      ON b.chat_jid = lm.lid || '@lid'
      OR (
        instr(b.chat_jid, ':') > 1
        AND substr(b.chat_jid, 1, instr(b.chat_jid, ':') - 1) = lm.lid
        AND length(b.chat_jid) > instr(b.chat_jid, ':') + 4
        AND substr(b.chat_jid, -4) = '@lid'
      )
  ), filtered_rows AS (
    SELECT *
    FROM conversation_rows
    WHERE ? IS NULL
       OR lower(conversation_key) LIKE ? ESCAPE '\\'
       OR lower(chat_jid) LIKE ? ESCAPE '\\'
       OR lower(COALESCE(name, '')) LIKE ? ESCAPE '\\'
       OR lower(COALESCE(phone_jid, '')) LIKE ? ESCAPE '\\'
  ), paged_rows AS (
    SELECT *
    FROM filtered_rows
    ORDER BY
      CASE WHEN ? = 'name' THEN lower(COALESCE(name, conversation_key)) END ASC,
      CASE WHEN ? = 'last_active' THEN last_timestamp END DESC NULLS LAST,
      conversation_key ASC
    LIMIT ? OFFSET ?
  ), latest_messages AS (
    SELECT *
    FROM (
      SELECT m.*,
             ROW_NUMBER() OVER (
               PARTITION BY m.conversation_key
               ORDER BY m.timestamp DESC, m.pk DESC
             ) AS rn
      FROM messages m
      WHERE m.deleted_at IS NULL
        AND m.conversation_key IN (SELECT conversation_key FROM paged_rows)
    ) latest_ranked
    WHERE rn = 1
  )
  SELECT paged_rows.*,
         latest.message_id AS last_message_id,
         latest.sender_name AS last_sender_name,
         latest.content AS last_content,
         latest.content_text AS last_content_text,
         latest.content_type AS last_content_type,
         latest.timestamp AS last_message_timestamp
  FROM paged_rows
  LEFT JOIN latest_messages latest
    ON latest.conversation_key = paged_rows.conversation_key
  ORDER BY
    CASE WHEN ? = 'name' THEN lower(COALESCE(name, paged_rows.conversation_key)) END ASC,
    CASE WHEN ? = 'last_active' THEN last_timestamp END DESC NULLS LAST,
    paged_rows.conversation_key ASC`;

const GLOBAL: SessionContext = { tier: 'global' };

function seed(db: Database): void {
  db.raw.exec(`
    INSERT INTO messages
      (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, content_type, is_from_me, timestamp, deleted_at)
    VALUES
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'a1', 'a one', 'text', 0, 1000, NULL),
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'a2', 'a two', 'text', 0, 3000, NULL),
      ('111@s.whatsapp.net', '111', 'me@s.whatsapp.net', 'Me', 'a3', 'a tie wins on pk', 'text', 1, 3000, NULL),
      ('111@s.whatsapp.net', '111', '111@s.whatsapp.net', 'Alice', 'a4', 'a deleted newest', 'text', 0, 9000, '2026-01-01T00:00:00Z'),
      ('222@s.whatsapp.net', '222', '222@s.whatsapp.net', 'Bob', 'b1', 'b only', 'image', 0, 5000, NULL),
      ('333@g.us', '333', '444@s.whatsapp.net', 'Carol', 'c1', 'group one', 'text', 0, 2000, NULL),
      ('333@g.us', '333', '444@s.whatsapp.net', 'Carol', 'c2', 'group two', 'text', 0, 7000, NULL),
      ('555@s.whatsapp.net', '555', '555@s.whatsapp.net', 'Dan', 'd1', 'all deleted', 'text', 0, 8000, '2026-01-01T00:00:00Z'),
      ('9999@lid', '9999', '9999@lid', 'Lid Contact', 'l1', 'lid dm', 'text', 0, 6000, NULL),
      ('9999:12@lid', '9999', '9999:12@lid', 'Lid Contact', 'l2', 'lid dm device', 'text', 0, 6000, NULL);
    INSERT INTO chats (jid, conversation_key, name, unread_count, is_archived, is_pinned)
    VALUES
      ('111@s.whatsapp.net', '111', 'Alice Chat', 2, 0, 1),
      ('333@g.us', '333', 'Book club 100%', 0, 1, 0),
      ('777@s.whatsapp.net', '777', 'Empty chat', 0, 0, 0);
    INSERT INTO lid_mappings (lid, phone_jid) VALUES ('9999', 'fixture-phone@s.whatsapp.net');
  `);
}

/** list_chats binds: 5 x LIKE pattern, sort x2, limit, offset, sort x2. */
function binds(likeQuery: string | null, sortBy: string, limit: number, offset: number): Array<string | number | null> {
  return [likeQuery, likeQuery, likeQuery, likeQuery, likeQuery, sortBy, sortBy, limit, offset, sortBy, sortBy];
}

describe('list_chats latest-message lookup', () => {
  let db: Database;
  let registry: ToolRegistry;
  let sql: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.open();
    registry = new ToolRegistry();
    registerChatManagementTools(db, () => ({}) as WhatsAppSocket, (tool) => registry.register(tool));
    seed(db);
    // Capture the statement the real handler prepares, so the plan and
    // equivalence checks below exercise exactly what production runs.
    const prepare = vi.spyOn(db.raw, 'prepare');
    const result = await registry.call('list_chats', {}, GLOBAL);
    expect(result.isError).toBeUndefined();
    const captured = prepare.mock.calls.map((call) => String(call[0])).filter((text) => text.includes('paged_rows'));
    prepare.mockRestore();
    expect(captured).toHaveLength(1);
    sql = captured[0];
  });

  const cases: Array<{ query: string | null; sortBy: string; limit: number; offset: number }> = [];
  for (const sortBy of ['last_active', 'name']) {
    for (const [limit, offset] of [[100, 0], [2, 0], [2, 2], [1, 5], [3, 50]] as const) {
      cases.push({ query: null, sortBy, limit, offset });
    }
    // Free-text search path: name, JID, conversation key, mapped LID phone, LIKE metacharacter, no match.
    for (const query of ['%alice%', '%@g.us%', '%22%', '%fixture-phone%', '%100\\%%', '%nomatch%']) {
      cases.push({ query, sortBy, limit: 100, offset: 0 });
      cases.push({ query, sortBy, limit: 1, offset: 1 });
    }
  }

  it.each(cases)('returns the legacy rows for query=$query sort=$sortBy limit=$limit offset=$offset', ({ query, sortBy, limit, offset }) => {
    const args = binds(query, sortBy, limit, offset);
    const expected = db.raw.prepare(LEGACY_LIST_CHATS_SQL).all(...args);
    const actual = db.raw.prepare(sql).all(...args);
    expect(actual).toEqual(expected);
  });

  it('picks the newest non-deleted message, breaking timestamp ties by pk', () => {
    const rows = db.raw.prepare(sql).all(...binds(null, 'last_active', 100, 0)) as Array<{
      conversation_key: string;
      last_message_id: string | null;
    }>;
    const latest = Object.fromEntries(rows.map((row) => [row.conversation_key, row.last_message_id]));
    expect(latest).toEqual({ '111': 'a3', '222': 'b1', '333': 'c2', '777': null, '9999': 'l2' });
  });

  it('looks up the latest message by index instead of sorting every message', () => {
    const plan = db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds(null, 'last_active', 100, 0)) as Array<{
      detail: string;
    }>;
    const details = plan.map((row) => row.detail);
    // The legacy CTE materialised m.* for every message and sorted it for
    // ROW_NUMBER(): a temp B-tree fed by the messages table. Only the small
    // per-page ORDER BY sorts may remain.
    expect(details.filter((detail) => /USE TEMP B-TREE/.test(detail) && !/FOR ORDER BY/.test(detail))).toEqual([]);
    expect(details.some((detail) => /latest_ranked|latest_messages/.test(detail))).toBe(false);
    expect(details).toContainEqual(expect.stringMatching(/SEARCH m\d? USING INDEX idx_messages_conversation_ts \(conversation_key=\?\)/));
  });
});
