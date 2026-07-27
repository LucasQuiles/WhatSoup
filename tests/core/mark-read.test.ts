/**
 * Direct unit coverage for src/core/mark-read.ts.
 *
 * `markConversationRead(db, connectionManager, conversationKey)`:
 *   1. Looks up chats.jid by conversation_key (returns chat_not_found if missing).
 *   2. Picks the most-recent message via `ORDER BY pk DESC`.
 *   3. If a socket and a last message exist, calls sock.chatModify(...) with
 *      a key shape that flips `fromMe` based on botJid equality.
 *   4. Always zeroes chats.unread_count even when no socket / last message.
 *   5. Swallows chatModify() errors (logs warn, still returns ok+jid).
 *
 * Uses real in-memory SQLite (project convention) + minimal fakes for
 * sock + connectionManager. No prior direct mirror.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { markConversationRead } from '../../src/core/mark-read.ts';
import type { ConnectionManager, WhatsAppSocket } from '../../src/transport/connection.ts';

const SELF_JID = '15551234567@s.whatsapp.net';
const PEER_JID = '15559876543@s.whatsapp.net';
const CONV_KEY = `conv:${PEER_JID}`;
const CHAT_JID = PEER_JID;

type MarkReadPayload = {
  markRead: boolean;
  lastMessages: Array<{
    key: {
      id: string;
      fromMe: boolean;
    };
    messageTimestamp: number;
  }>;
};

type ChatModify = (payload: MarkReadPayload, jid: string) => Promise<void>;
type TestConnectionManager = Pick<ConnectionManager, 'getSocket' | 'botJid'>;

function seedChat(db: Database, opts?: { unread?: number }) {
  db.raw
    .prepare('INSERT INTO chats (jid, conversation_key, unread_count) VALUES (?, ?, ?)')
    .run(CHAT_JID, CONV_KEY, opts?.unread ?? 5);
}

function seedMessage(
  db: Database,
  opts: { id: string; sender: string; ts: number },
) {
  db.raw
    .prepare(
      'INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(CHAT_JID, CONV_KEY, opts.sender, opts.id, 'body', opts.ts);
}

function makeChatModify(impl?: ChatModify) {
  return vi.fn(impl ?? (async () => undefined));
}

function makeSocket(chatModify = makeChatModify()): WhatsAppSocket {
  return { chatModify } as unknown as WhatsAppSocket;
}

function firstChatModifyCall(chatModify: ReturnType<typeof makeChatModify>): [MarkReadPayload, string] {
  const call = chatModify.mock.calls[0];
  if (!call) {
    throw new Error('expected chatModify to have been called');
  }
  return call;
}

function makeConnMgr(socket: WhatsAppSocket | null, botJid = SELF_JID): TestConnectionManager {
  return {
    getSocket: vi.fn((): WhatsAppSocket | null => socket),
    botJid,
  };
}

describe('markConversationRead', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });
  afterEach(() => {
    db.close();
  });

  it('returns { ok: false, error: "chat_not_found" } when no chat row exists', async () => {
    const result = await markConversationRead(db, makeConnMgr(null), 'no-such-key');
    expect(result).toEqual({
      ok: false,
      error: 'chat_not_found',
      conversation_key: 'no-such-key',
    });
  });

  it('zeroes unread_count on success even when there are no messages and no socket', async () => {
    seedChat(db, { unread: 7 });
    const result = await markConversationRead(db, makeConnMgr(null), CONV_KEY);
    expect(result).toEqual({
      ok: true, jid: CHAT_JID, conversation_key: CONV_KEY, remote: 'nothing_to_ack',
    });
    const row = db.raw
      .prepare('SELECT unread_count FROM chats WHERE conversation_key = ?')
      .get(CONV_KEY) as { unread_count: number };
    expect(row.unread_count).toBe(0);
  });

  it('skips chatModify when no socket is available, still zeroes unread', async () => {
    seedChat(db, { unread: 3 });
    seedMessage(db, { id: 'm1', sender: PEER_JID, ts: 1_000 });
    const connMgr = makeConnMgr(null);
    const result = await markConversationRead(db, connMgr, CONV_KEY);
    expect(result.ok).toBe(true);
    expect(connMgr.getSocket).toHaveBeenCalledTimes(1);
    const row = db.raw
      .prepare('SELECT unread_count FROM chats WHERE conversation_key = ?')
      .get(CONV_KEY) as { unread_count: number };
    expect(row.unread_count).toBe(0);
  });

  it('calls sock.chatModify with the most-recent message (ORDER BY pk DESC)', async () => {
    seedChat(db);
    seedMessage(db, { id: 'm-newer-timestamp', sender: PEER_JID, ts: 2_000 });
    seedMessage(db, { id: 'm-newer-pk', sender: PEER_JID, ts: 1_000 });
    const chatModify = makeChatModify();
    const sock = makeSocket(chatModify);
    await markConversationRead(db, makeConnMgr(sock), CONV_KEY);
    expect(chatModify).toHaveBeenCalledTimes(1);
    const [payload, jid] = firstChatModifyCall(chatModify);
    expect(jid).toBe(CHAT_JID);
    expect(payload.markRead).toBe(true);
    expect(payload.lastMessages).toHaveLength(1);
    expect(payload.lastMessages[0].key.id).toBe('m-newer-pk');
    expect(payload.lastMessages[0].messageTimestamp).toBe(1_000);
  });

  it('flags fromMe=true when last message sender equals botJid', async () => {
    seedChat(db);
    seedMessage(db, { id: 'mine', sender: SELF_JID, ts: 1_000 });
    const chatModify = makeChatModify();
    await markConversationRead(db, makeConnMgr(makeSocket(chatModify), SELF_JID), CONV_KEY);
    const [payload] = firstChatModifyCall(chatModify);
    expect(payload.lastMessages[0].key.fromMe).toBe(true);
  });

  it('flags fromMe=false when last message sender differs from botJid', async () => {
    seedChat(db);
    seedMessage(db, { id: 'theirs', sender: PEER_JID, ts: 1_000 });
    const chatModify = makeChatModify();
    await markConversationRead(db, makeConnMgr(makeSocket(chatModify), SELF_JID), CONV_KEY);
    const [payload] = firstChatModifyCall(chatModify);
    expect(payload.lastMessages[0].key.fromMe).toBe(false);
  });

  it('swallows chatModify errors: still returns ok and zeroes unread', async () => {
    seedChat(db, { unread: 9 });
    seedMessage(db, { id: 'm1', sender: PEER_JID, ts: 1_000 });
    const chatModify = makeChatModify(async () => {
      throw new Error('boom');
    });
    const result = await markConversationRead(db, makeConnMgr(makeSocket(chatModify)), CONV_KEY);
    // The local zero is still applied — that is the specified behaviour. What is
    // new is that the caller can now SEE the remote receipt failed.
    expect(result).toEqual({
      ok: true, jid: CHAT_JID, conversation_key: CONV_KEY, remote: 'failed',
    });
    const row = db.raw
      .prepare('SELECT unread_count FROM chats WHERE conversation_key = ?')
      .get(CONV_KEY) as { unread_count: number };
    expect(row.unread_count).toBe(0);
  });

  it('skips chatModify when chat has no messages even if socket is present', async () => {
    seedChat(db);
    const chatModify = makeChatModify();
    await markConversationRead(db, makeConnMgr(makeSocket(chatModify)), CONV_KEY);
    expect(chatModify).not.toHaveBeenCalled();
  });

  it('returns the chat_jid (raw chat JID for sends) on success', async () => {
    seedChat(db);
    const result = await markConversationRead(db, makeConnMgr(null), CONV_KEY);
    expect(result).toEqual({
      ok: true, jid: CHAT_JID, conversation_key: CONV_KEY, remote: 'nothing_to_ack',
    });
  });

  // ─── #2292 L16: the REMOTE receipt outcome is now visible to the caller ────
  //
  // The local zero is unchanged and still specified above. What these pin is
  // that a caller can distinguish "WhatsApp accepted the receipt" from "the
  // local badge was cleared while the remote may still show unread".
  describe('remote receipt status (#2292 L16)', () => {
    it("reports 'acked' when chatModify succeeds", async () => {
      seedChat(db, { unread: 4 });
      seedMessage(db, { id: 'm1', sender: PEER_JID, ts: 1_000 });
      const result = await markConversationRead(db, makeConnMgr(makeSocket()), CONV_KEY);
      expect(result).toMatchObject({ ok: true, remote: 'acked' });
    });

    it("reports 'failed' when chatModify throws — distinguishable from a real ack", async () => {
      seedChat(db, { unread: 4 });
      seedMessage(db, { id: 'm1', sender: PEER_JID, ts: 1_000 });
      const chatModify = makeChatModify(async () => { throw new Error('boom'); });
      const result = await markConversationRead(db, makeConnMgr(makeSocket(chatModify)), CONV_KEY);
      expect(result).toMatchObject({ ok: true, remote: 'failed' });
      // The local badge is still cleared — that is the specified behaviour, and
      // the point of the status is that the divergence is now REPORTED.
      const row = db.raw
        .prepare('SELECT unread_count FROM chats WHERE conversation_key = ?')
        .get(CONV_KEY) as { unread_count: number };
      expect(row.unread_count).toBe(0);
    });

    it("reports 'offline' when there is no socket, not 'failed'", async () => {
      seedChat(db, { unread: 4 });
      seedMessage(db, { id: 'm1', sender: PEER_JID, ts: 1_000 });
      const result = await markConversationRead(db, makeConnMgr(null), CONV_KEY);
      expect(result).toMatchObject({ ok: true, remote: 'offline' });
    });

    it("reports 'nothing_to_ack' for a chat with no messages", async () => {
      seedChat(db, { unread: 0 });
      const result = await markConversationRead(db, makeConnMgr(makeSocket()), CONV_KEY);
      expect(result).toMatchObject({ ok: true, remote: 'nothing_to_ack' });
    });

    // Discriminating case: hardcoding any single status would satisfy one test
    // above while collapsing the distinction the field exists to make.
    it('gives the four cases four DISTINCT statuses', async () => {
      seedChat(db, { unread: 1 });
      const nothing = await markConversationRead(db, makeConnMgr(makeSocket()), CONV_KEY);
      seedMessage(db, { id: 'm1', sender: PEER_JID, ts: 1_000 });
      const acked = await markConversationRead(db, makeConnMgr(makeSocket()), CONV_KEY);
      const offline = await markConversationRead(db, makeConnMgr(null), CONV_KEY);
      const failed = await markConversationRead(
        db, makeConnMgr(makeSocket(makeChatModify(async () => { throw new Error('boom'); }))), CONV_KEY,
      );
      const seen = [nothing, acked, offline, failed].map((r) => (r as { remote: string }).remote);
      expect(seen).toEqual(['nothing_to_ack', 'acked', 'offline', 'failed']);
      expect(new Set(seen).size).toBe(4);
    });
  });
});
