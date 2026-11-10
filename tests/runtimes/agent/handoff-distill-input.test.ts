import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { getRecentMessageText, storeMessageIfNew } from '../../../src/core/messages.ts';
import { defaultHandoffDistillConfig } from '../../../src/lib/handoff-distill-config.ts';
import { ensureHandoffArtifactSchema, getHandoffArtifact } from '../../../src/runtimes/agent/handoff-artifact.ts';

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  listActiveSessionRows: () => [{ conversationKey: 'c1', rowId: 1 }],
  getSessionTokenSnapshot: () => ({ totalInputTokens: 5000, totalOutputTokens: 0, lastCompactInputTokens: 0, lastCompactOutputTokens: 0 }),
}));
vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

import { HandoffDistillCoordinator } from '../../../src/runtimes/agent/handoff-distill-coordinator.ts';

describe('production handoff message read boundary', () => {
  const maxBytes = 64 * 1024;
  let db: Database;
  let coordinator: HandoffDistillCoordinator;
  let projected: Record<string, unknown>[];
  let fetchImpl: ReturnType<typeof vi.fn>;

  function store(id: string, content: string, senderName: string | null = null, rawMessage: string | null = null): void {
    storeMessageIfNew(db, {
      conversationKey: 'c1', chatJid: 'chat', senderJid: 'sender', senderName,
      messageId: id, content, rawMessage, isFromMe: false, timestamp: 1,
    });
  }

  function sweep(): Promise<void> {
    return (coordinator as unknown as { sweep(): Promise<void> }).sweep();
  }

  function projectedBytes(): number {
    return projected.reduce((sum, row) => sum + Object.values(row).reduce<number>(
      (bytes, value) => bytes + (typeof value === 'string' ? Buffer.byteLength(value) : 0), 0,
    ), 0);
  }

  beforeEach(() => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-key');
    fetchImpl = vi.fn(async () => Response.json({
      choices: [{ message: { content: 'bounded history' } }], usage: { total_tokens: 1 },
    }));
    vi.stubGlobal('fetch', fetchImpl);
    db = new Database(':memory:');
    db.open();
    ensureHandoffArtifactSchema(db);
    projected = [];
    const statementPrototype = Object.getPrototypeOf(db.raw.prepare('SELECT 1'));
    const originalAll = statementPrototype.all;
    // Observe the actual SQLite-to-JavaScript result, without replacing the query.
    vi.spyOn(statementPrototype, 'all').mockImplementation(function (this: unknown, ...args: unknown[]) {
      const rows = originalAll.apply(this, args) as Record<string, unknown>[];
      projected.push(...rows);
      return rows;
    });
    const config = defaultHandoffDistillConfig();
    config.verbatimN = 2;
    coordinator = new HandoffDistillCoordinator({
      db, instanceName: 'test', isEnabled: () => true,
      getModel: () => 'deepseek-chat', getConfig: () => config,
    });
    coordinator.start();
  });

  afterEach(() => {
    coordinator.shutdown();
    vi.restoreAllMocks();
    db.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('projects only bounded text in chronological order and excludes unused raw data', async () => {
    store('older', 'x'.repeat(maxBytes + 1));
    store('first', 'first text', 'First', 'unused-raw-'.repeat(maxBytes));
    store('second', 'second text', 'Second');
    store('deleted', 'x'.repeat(maxBytes + 1));
    db.raw.prepare('UPDATE messages SET deleted_at = ? WHERE message_id = ?').run('deleted', 'deleted');
    await sweep();
    expect(getHandoffArtifact(db, 'c1')?.summary).toBe('bounded history');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const requestArgs = fetchImpl.mock.calls[0] as [unknown, RequestInit];
    const request = JSON.parse(String(requestArgs[1].body));
    expect(request.messages[1].content).toBe('First: first text\nSecond: second text');
    expect(projected).toHaveLength(2);
    expect(projectedBytes()).toBe(Buffer.byteLength('first textFirstsecond textSecond'));
    expect(projected.some((row) => Object.hasOwn(row, 'raw_message'))).toBe(false);
  });

  it.each(['content', 'name', 'multibyte', 'nul', 'aggregate'])('rejects oversized %s before exposing text to JavaScript', async (kind) => {
    if (kind === 'name') store('one', '', 'n'.repeat(maxBytes + 1));
    else if (kind === 'multibyte') store('one', '🙂'.repeat(maxBytes / 4 + 1));
    else if (kind === 'nul') store('one', '\0'.repeat(maxBytes + 1));
    else if (kind === 'aggregate') {
      store('one', 'x'.repeat(maxBytes / 2));
      store('two', 'y'.repeat(maxBytes / 2 + 1));
    } else store('one', 'x'.repeat(maxBytes + 1));
    await sweep();
    expect(projectedBytes()).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getHandoffArtifact(db, 'c1')).toBeNull();
  });

  it('allows the exact stored-text bound while still refusing an oversized encoded request', async () => {
    store('one', 'x'.repeat(maxBytes));
    await sweep();
    expect(projectedBytes()).toBe(maxBytes);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getHandoffArtifact(db, 'c1')).toBeNull();
  });

  it('returns no text from a different conversation or an empty window', () => {
    store('other', 'private context');
    expect(getRecentMessageText(db, 'c2', 2, maxBytes)).toEqual([]);
    expect(projectedBytes()).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses an invalid row or byte bound: %s', (invalid) => {
    store('one', 'context');
    expect(() => getRecentMessageText(db, 'c1', invalid, maxBytes)).toThrow(/positive integer/);
    expect(() => getRecentMessageText(db, 'c1', 2, invalid)).toThrow(/positive integer/);
    expect(projected).toEqual([]);
  });
});
