import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { storeMessage } from '../../../src/core/messages.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';
import { loadConversationWindow } from '../../../src/runtimes/chat/window.ts';
import { config } from '../../../src/config.ts';

// Helper: open a fresh in-memory database for each test
function openDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

type StoreInput = Parameters<typeof storeMessage>[1];

/** Wrapper that auto-fills conversationKey from chatJid. */
function store(db: Database, msg: Omit<StoreInput, 'conversationKey'>): void {
  storeMessage(db, { ...msg, conversationKey: toConversationKey(msg.chatJid) });
}

// Base unix timestamp (seconds): far in the past so no window-extension triggers
const BASE_TS = Math.floor(Date.now() / 1000) - 24 * 60 * 60; // 24 hours ago

function makeMessageId(): (() => string) {
  let seq = 0;
  return () => `msg-${++seq}`;
}

describe('loadConversationWindow', () => {
  let db: Database;
  let nextId: () => string;

  beforeEach(() => {
    db = openDb();
    nextId = makeMessageId();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---- Positive cases ----

  it('returns an empty array when the database has no messages', () => {
    const result = loadConversationWindow(db, 'chat1@g.us');
    expect(result).toEqual([]);
  });

  it('returns all 50 messages in chronological (ASC) order', () => {
    const chat = 'chat-asc@g.us';
    for (let i = 0; i < 50; i++) {
      store(db, {
        chatJid: chat,
        senderJid: 'alice@s.whatsapp.net',
        senderName: 'Alice',
        messageId: nextId(),
        content: `msg ${i}`,
        isFromMe: false,
        timestamp: BASE_TS + i,
      });
    }

    const result = loadConversationWindow(db, chat);
    // All messages present (they are from different senders but same role 'user',
    // they will be merged into one because it's one consecutive block — but the
    // content of each should reflect the order)
    const joined = result.map((m) => m.content).join('\n');
    // The very first content fragment must appear before the last
    expect(joined).toContain('msg 0');
    expect(joined).toContain('msg 49');
    const idxFirst = joined.indexOf('msg 0');
    const idxLast = joined.indexOf('msg 49');
    expect(idxFirst).toBeLessThan(idxLast);
  });

  it('maps isFromMe=true messages to role=assistant', () => {
    const chat = 'chat-bot@g.us';
    store(db, {
      chatJid: chat,
      senderJid: 'bot@s.whatsapp.net',
      messageId: nextId(),
      content: 'I am the bot',
      isFromMe: true,
      timestamp: BASE_TS,
    });

    const result = loadConversationWindow(db, chat);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect(result[0].content).toBe('I am the bot');
  });

  it('maps isFromMe=false messages to role=user with [Name]: prefix', () => {
    const chat = 'chat-user@g.us';
    store(db, {
      chatJid: chat,
      senderJid: 'alice@s.whatsapp.net',
      senderName: 'Alice',
      messageId: nextId(),
      content: 'hello there',
      isFromMe: false,
      timestamp: BASE_TS,
    });

    const result = loadConversationWindow(db, chat);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('[Alice]: hello there');
  });

  it('merges consecutive same-role messages with a newline separator', () => {
    const chat = 'chat-merge@g.us';
    // Three consecutive user messages from the same sender
    for (let i = 1; i <= 3; i++) {
      store(db, {
        chatJid: chat,
        senderJid: 'alice@s.whatsapp.net',
        senderName: 'Alice',
        messageId: nextId(),
        content: `line ${i}`,
        isFromMe: false,
        timestamp: BASE_TS + i,
      });
    }

    const result = loadConversationWindow(db, chat);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('[Alice]: line 1\n[Alice]: line 2\n[Alice]: line 3');
  });

  it('does NOT merge messages across different roles', () => {
    const chat = 'chat-roles@g.us';
    store(db, {
      chatJid: chat,
      senderJid: 'alice@s.whatsapp.net',
      senderName: 'Alice',
      messageId: nextId(),
      content: 'user message',
      isFromMe: false,
      timestamp: BASE_TS,
    });
    store(db, {
      chatJid: chat,
      senderJid: 'bot@s.whatsapp.net',
      messageId: nextId(),
      content: 'bot reply',
      isFromMe: true,
      timestamp: BASE_TS + 1,
    });
    store(db, {
      chatJid: chat,
      senderJid: 'alice@s.whatsapp.net',
      senderName: 'Alice',
      messageId: nextId(),
      content: 'user again',
      isFromMe: false,
      timestamp: BASE_TS + 2,
    });

    const result = loadConversationWindow(db, chat);
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
    expect(result[2].role).toBe('user');
  });

  it('preserves unicode content including emoji and CJK characters', () => {
    const chat = 'chat-unicode@g.us';
    const unicodeContent = '你好 🎉 こんにちは مرحبا';
    store(db, {
      chatJid: chat,
      senderJid: 'alice@s.whatsapp.net',
      senderName: 'Alice',
      messageId: nextId(),
      content: unicodeContent,
      isFromMe: false,
      timestamp: BASE_TS,
    });

    const result = loadConversationWindow(db, chat);
    expect(result[0].content).toContain(unicodeContent);
  });

  it('prefixes each sender with their own name in a group chat', () => {
    const chat = 'group@g.us';
    store(db, {
      chatJid: chat,
      senderJid: 'alice@s.whatsapp.net',
      senderName: 'Alice',
      messageId: nextId(),
      content: 'from alice',
      isFromMe: false,
      timestamp: BASE_TS,
    });
    store(db, {
      chatJid: chat,
      senderJid: 'bob@s.whatsapp.net',
      senderName: 'Bob',
      messageId: nextId(),
      content: 'from bob',
      isFromMe: false,
      timestamp: BASE_TS + 1,
    });

    const result = loadConversationWindow(db, chat);
    // Alice and Bob have different names so they are NOT merged (different names
    // does not change role, so they ARE merged — both role='user').
    // Merged into one user message, each line prefixed.
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('[Alice]: from alice');
    expect(result[0].content).toContain('[Bob]: from bob');
  });

  it('extends to 100 messages when oldest in initial window is within 10 min', () => {
    const chat = 'chat-extend@g.us';
    const nowSec = Math.floor(Date.now() / 1000);
    // Insert 80 messages, all within the last 5 minutes
    for (let i = 0; i < 80; i++) {
      store(db, {
        chatJid: chat,
        senderJid: 'alice@s.whatsapp.net',
        senderName: 'Alice',
        messageId: nextId(),
        content: `recent ${i}`,
        isFromMe: false,
        // Space messages 1s apart, all starting 80s ago (within 10 min)
        timestamp: nowSec - 80 + i,
      });
    }

    const result = loadConversationWindow(db, chat);
    // With extension triggered, all 80 messages should be included
    // (they're all within the extended 100-message window)
    const allContent = result.map((m) => m.content).join('\n');
    // Should include both the earliest and latest messages
    expect(allContent).toContain('recent 0');
    expect(allContent).toContain('recent 79');
  });

  it('does NOT extend window when oldest message is older than 10 min threshold', () => {
    const chat = 'chat-no-extend@g.us';
    const nowSec = Math.floor(Date.now() / 1000);
    // Insert 80 messages with the oldest being 15 minutes ago (outside threshold)
    for (let i = 0; i < 80; i++) {
      store(db, {
        chatJid: chat,
        senderJid: 'alice@s.whatsapp.net',
        senderName: 'Alice',
        messageId: nextId(),
        content: `old ${i}`,
        isFromMe: false,
        timestamp: nowSec - 15 * 60 + i, // oldest is 15 min ago, newest is ~14 min ago
      });
    }

    const result = loadConversationWindow(db, chat);
    // No extension: only the latest 50 are fetched and merged
    const allContent = result.map((m) => m.content).join('\n');
    // The most recent 50 are 'old 30' through 'old 79'
    expect(allContent).toContain('old 79');
    expect(allContent).toContain('old 30');
    // The very oldest (old 0) should NOT be present
    // (check for 'old 0\n' or 'old 0)' to avoid matching 'old 30', 'old 40' etc.)
    const hasOld0 = /\bold 0\b/.test(allContent) &&
      !allContent.includes('old 0\n') === false;
    // More reliable: check that 'old 29' is absent (49th from end going back = index 30)
    expect(allContent).not.toMatch(/\bold 29\b/);
  });

  // ---- Negative cases ----

  it('skips messages with null content', () => {
    const chat = 'chat-null@g.us';
    store(db, {
      chatJid: chat,
      senderJid: 'alice@s.whatsapp.net',
      senderName: 'Alice',
      messageId: nextId(),
      content: null,
      isFromMe: false,
      timestamp: BASE_TS,
    });
    store(db, {
      chatJid: chat,
      senderJid: 'alice@s.whatsapp.net',
      senderName: 'Alice',
      messageId: nextId(),
      content: 'visible message',
      isFromMe: false,
      timestamp: BASE_TS + 1,
    });

    const result = loadConversationWindow(db, chat);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('visible message');
  });

  it('returns only the most recent 50 when more than 50 messages exist', () => {
    const chat = 'chat-51@g.us';
    // Insert 51 messages with distinct, easily distinguishable content
    for (let i = 1; i <= 51; i++) {
      store(db, {
        chatJid: chat,
        senderJid: 'bot@s.whatsapp.net',
        messageId: nextId(),
        content: `reply ${i}`,
        isFromMe: true,
        timestamp: BASE_TS + i,
      });
    }

    const result = loadConversationWindow(db, chat);
    const allContent = result.map((m) => m.content).join('\n');
    // The very first message (#1) must be absent
    expect(allContent).not.toMatch(/\breply 1\b/);
    // Messages 2 through 51 should be present
    expect(allContent).toContain('reply 2');
    expect(allContent).toContain('reply 51');
  });

  it('uses "[Unknown]: " prefix when senderName is null and falls back to JID local part', () => {
    const chat = 'chat-unknown@g.us';
    store(db, {
      chatJid: chat,
      senderJid: 'mystery@s.whatsapp.net',
      senderName: null,
      messageId: nextId(),
      content: 'who am I?',
      isFromMe: false,
      timestamp: BASE_TS,
    });

    const result = loadConversationWindow(db, chat);
    expect(result).toHaveLength(1);
    // Falls back to the local part of the JID: 'mystery'
    expect(result[0].content).toBe('[mystery]: who am I?');
  });

  it('does not include messages from a different chat JID', () => {
    const chatA = 'chat-a@g.us';
    const chatB = 'chat-b@g.us';

    store(db, {
      chatJid: chatA,
      senderJid: 'alice@s.whatsapp.net',
      senderName: 'Alice',
      messageId: nextId(),
      content: 'only in A',
      isFromMe: false,
      timestamp: BASE_TS,
    });
    store(db, {
      chatJid: chatB,
      senderJid: 'bob@s.whatsapp.net',
      senderName: 'Bob',
      messageId: nextId(),
      content: 'only in B',
      isFromMe: false,
      timestamp: BASE_TS + 1,
    });

    const resultA = loadConversationWindow(db, chatA);
    const resultB = loadConversationWindow(db, chatB);

    expect(resultA.map((m) => m.content).join()).not.toContain('only in B');
    expect(resultB.map((m) => m.content).join()).not.toContain('only in A');
  });

  it('handles all-null-content messages gracefully, returning empty array', () => {
    const chat = 'chat-all-null@g.us';
    for (let i = 0; i < 5; i++) {
      store(db, {
        chatJid: chat,
        senderJid: 'alice@s.whatsapp.net',
        senderName: 'Alice',
        messageId: nextId(),
        content: null,
        isFromMe: false,
        timestamp: BASE_TS + i,
      });
    }

    const result = loadConversationWindow(db, chat);
    expect(result).toEqual([]);
  });

  it('interleaves assistant and user messages without merging across roles', () => {
    const chat = 'chat-interleave@g.us';
    const pairs = [
      { content: 'q1', isFromMe: false },
      { content: 'a1', isFromMe: true },
      { content: 'q2', isFromMe: false },
      { content: 'a2', isFromMe: true },
    ];
    pairs.forEach((p, i) => {
      store(db, {
        chatJid: chat,
        senderJid: p.isFromMe ? 'bot@s.whatsapp.net' : 'alice@s.whatsapp.net',
        senderName: p.isFromMe ? null : 'Alice',
        messageId: nextId(),
        content: p.content,
        isFromMe: p.isFromMe,
        timestamp: BASE_TS + i,
      });
    });

    const result = loadConversationWindow(db, chat);
    expect(result).toHaveLength(4);
    expect(result.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('correctly merges multiple bot replies sent back-to-back', () => {
    const chat = 'chat-bot-merge@g.us';
    store(db, {
      chatJid: chat,
      senderJid: 'bot@s.whatsapp.net',
      messageId: nextId(),
      content: 'part one',
      isFromMe: true,
      timestamp: BASE_TS,
    });
    store(db, {
      chatJid: chat,
      senderJid: 'bot@s.whatsapp.net',
      messageId: nextId(),
      content: 'part two',
      isFromMe: true,
      timestamp: BASE_TS + 1,
    });

    const result = loadConversationWindow(db, chat);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect(result[0].content).toBe('part one\npart two');
  });

  it('window boundary: exactly 50 messages returns all 50', () => {
    const chat = 'chat-exact50@g.us';
    for (let i = 0; i < 50; i++) {
      store(db, {
        chatJid: chat,
        senderJid: 'bot@s.whatsapp.net',
        messageId: nextId(),
        content: `r${i}`,
        isFromMe: true,
        timestamp: BASE_TS + i,
      });
    }

    const result = loadConversationWindow(db, chat);
    const allContent = result.map((m) => m.content).join('\n');
    expect(allContent).toContain('r0');
    expect(allContent).toContain('r49');
  });
});
