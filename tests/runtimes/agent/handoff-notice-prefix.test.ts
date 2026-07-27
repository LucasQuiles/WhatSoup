import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { createChildLogger } = vi.hoisted(() => ({
  createChildLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  })),
}));

vi.mock('../../../src/logger.ts', () => ({ createChildLogger }));

import { toConversationKey } from '../../../src/core/conversation-key.ts';
import { Database } from '../../../src/core/database.ts';
import {
  flushPendingHandoffNotice,
  stashHandoffNotice,
  withHandoffPrefix,
} from '../../../src/runtimes/agent/handoff-notice-prefix.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import {
  ensureStandbyNoticeSchema,
  peekStandbyNotice,
} from '../../../src/runtimes/agent/standby-notice.ts';

const NOW = 1_781_000_000_000;
const CHAT = '15551230000@s.whatsapp.net';
const paths: string[] = [];

function freshDb(): Database {
  const path = join(tmpdir(), `whatsoup-handoff-prefix-test-${randomBytes(4).toString('hex')}.db`);
  paths.push(path);
  const db = new Database(path);
  db.open();
  ensureStandbyNoticeSchema(db);
  return db;
}

/** Minimal IOutboundQueue surface used by flushPendingHandoffNotice. */
function fakeQueue(targetChatJid: string): { queue: IOutboundQueue; enqueued: string[] } {
  const enqueued: string[] = [];
  const queue = {
    targetChatJid,
    enqueueText: (t: string) => { enqueued.push(t); },
  } as unknown as IOutboundQueue;
  return { queue, enqueued };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const p of paths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      const fp = p + suffix;
      if (existsSync(fp)) unlinkSync(fp);
    }
  }
});

describe('stashHandoffNotice', () => {
  it('preserves the agent-runtime component identity after extraction', () => {
    expect(createChildLogger).toHaveBeenCalledWith('agent-runtime');
  });

  it('persists the notice under the conversation key and returns true (independent of the flag)', () => {
    const db = freshDb();
    // No flag: stash is unconditional — the call-site guard, not this helper, gates it.
    expect(stashHandoffNotice(db, CHAT, 'Primary hit a limit. Continuing on backup.', NOW)).toBe(true);
    expect(peekStandbyNotice(db, toConversationKey(CHAT))).toBe('Primary hit a limit. Continuing on backup.');
    db.close();
  });

  it('returns false and does not throw when the underlying stash fails', () => {
    const db = freshDb();
    const realPrepare = db.raw.prepare.bind(db.raw);
    vi.spyOn(db.raw as unknown as { prepare: (sql: string) => unknown }, 'prepare').mockImplementation(
      ((sql: string) => {
        if (sql.includes('INSERT INTO standby_notice')) throw new Error('stash boom');
        return realPrepare(sql);
      }) as never,
    );
    expect(stashHandoffNotice(db, CHAT, 'x', NOW)).toBe(false);
    db.close();
  });
});

describe('withHandoffPrefix', () => {
  it('returns the text unchanged when the one-message flag is off', () => {
    const db = freshDb();
    stashHandoffNotice(db, CHAT, 'NOTICE', NOW);
    // Flag off → no consume, notice stays pending.
    expect(withHandoffPrefix(db, CHAT, 'answer')).toBe('answer');
    expect(peekStandbyNotice(db, toConversationKey(CHAT))).toBe('NOTICE');
    db.close();
  });

  it('prepends and consumes the pending notice exactly once when the flag is on', () => {
    vi.stubEnv('WHATSOUP_ONE_MESSAGE_HANDOFF', '1');
    const db = freshDb();
    stashHandoffNotice(db, CHAT, 'NOTICE', NOW);
    expect(withHandoffPrefix(db, CHAT, 'answer')).toBe('NOTICE\n\nanswer');
    // Consume-once: a second reply gets the bare text.
    expect(withHandoffPrefix(db, CHAT, 'again')).toBe('again');
    db.close();
  });

  it('returns the text unchanged when no notice is pending (flag on)', () => {
    vi.stubEnv('WHATSOUP_ONE_MESSAGE_HANDOFF', '1');
    const db = freshDb();
    expect(withHandoffPrefix(db, CHAT, 'answer')).toBe('answer');
    db.close();
  });

  it('returns the text unchanged (never throws) when consume fails, flag on', () => {
    vi.stubEnv('WHATSOUP_ONE_MESSAGE_HANDOFF', '1');
    const db = freshDb();
    stashHandoffNotice(db, CHAT, 'NOTICE', NOW);
    const realPrepare = db.raw.prepare.bind(db.raw);
    vi.spyOn(db.raw as unknown as { prepare: (sql: string) => unknown }, 'prepare').mockImplementation(
      ((sql: string) => {
        if (sql.includes('SELECT message_text')) throw new Error('consume boom');
        return realPrepare(sql);
      }) as never,
    );
    expect(withHandoffPrefix(db, CHAT, 'answer')).toBe('answer');
    db.close();
  });
});

describe('flushPendingHandoffNotice', () => {
  it('is a no-op when the flag is off, leaving the notice pending', () => {
    const db = freshDb();
    stashHandoffNotice(db, CHAT, 'NOTICE', NOW);
    const q = fakeQueue(CHAT);
    flushPendingHandoffNotice(db, q.queue);
    expect(q.enqueued).toEqual([]);
    expect(peekStandbyNotice(db, toConversationKey(CHAT))).toBe('NOTICE');
    db.close();
  });

  it('enqueues a still-pending notice standalone when the flag is on', () => {
    vi.stubEnv('WHATSOUP_ONE_MESSAGE_HANDOFF', '1');
    const db = freshDb();
    stashHandoffNotice(db, CHAT, 'NOTICE', NOW);
    const q = fakeQueue(CHAT);
    flushPendingHandoffNotice(db, q.queue);
    expect(q.enqueued).toEqual(['NOTICE']);
    db.close();
  });

  it('is a no-op when nothing is pending (flag on)', () => {
    vi.stubEnv('WHATSOUP_ONE_MESSAGE_HANDOFF', '1');
    const db = freshDb();
    const q = fakeQueue(CHAT);
    flushPendingHandoffNotice(db, q.queue);
    expect(q.enqueued).toEqual([]);
    db.close();
  });

  it('does not double-send: a reply that already prefixed the notice leaves flush a no-op', () => {
    vi.stubEnv('WHATSOUP_ONE_MESSAGE_HANDOFF', '1');
    const db = freshDb();
    stashHandoffNotice(db, CHAT, 'NOTICE', NOW);
    expect(withHandoffPrefix(db, CHAT, 'answer')).toBe('NOTICE\n\nanswer');
    const q = fakeQueue(CHAT);
    flushPendingHandoffNotice(db, q.queue);
    expect(q.enqueued).toEqual([]);
    db.close();
  });
});
