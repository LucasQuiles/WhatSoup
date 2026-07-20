import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  createCatalogueSnapshotCache,
  type CatalogueEntry,
  type CatalogueSnapshotCache,
} from '../../../src/runtimes/agent/model-snapshot-cache.ts';

afterEach(() => vi.useRealTimers());
beforeEach(() => vi.clearAllMocks());

describe('CatalogueSnapshotCache', () => {
  it('resolves N against the snapshot the user saw', () => {
    const c = createCatalogueSnapshotCache();
    c.putCatalogueSnapshot('d@x', 'm-1', [
      { providerId: 'claude-cli', id: 'claude-opus-4-8' },
      { providerId: 'kimi', id: 'kimi-k3' },
    ]);
    expect(c.resolveCataloguePick('d@x', 2)).toEqual({
      providerId: 'kimi',
      id: 'kimi-k3',
    });
  });

  it('miss (out of range / expired) returns null, not a wrong pick', () => {
    const c = createCatalogueSnapshotCache();
    c.putCatalogueSnapshot('d@x', 'm-1', [
      { providerId: 'kimi', id: 'kimi-k3' },
    ]);
    expect(c.resolveCataloguePick('d@x', 5)).toBeNull(); // out of range
    expect(c.resolveCataloguePick('other@x', 1)).toBeNull(); // no snapshot for chat
  });

  it('quoted-reply resolves against the quoted message snapshot', () => {
    vi.useFakeTimers();
    const base = new Date('2026-07-20T00:00:00.000Z').getTime();
    vi.setSystemTime(base);

    const c = createCatalogueSnapshotCache();

    // First snapshot at m-1
    c.putCatalogueSnapshot('d@x', 'm-1', [
      { providerId: 'claude-cli', id: 'claude-opus-4-8' },
      { providerId: 'kimi', id: 'kimi-k3' },
      { providerId: 'anthropic', id: 'claude-sonnet-4' },
    ]);

    // Advance time and put a newer snapshot at m-2
    vi.setSystemTime(base + 60_000);
    c.putCatalogueSnapshot('d@x', 'm-2', [
      { providerId: 'claude-cli', id: 'claude-opus-4-8' },
      { providerId: 'openai', id: 'gpt-4' },
    ]);

    // Resolve without quotedMsgId should resolve against the latest (m-2)
    expect(c.resolveCataloguePick('d@x', 1)).toEqual({
      providerId: 'claude-cli',
      id: 'claude-opus-4-8',
    });
    expect(c.resolveCataloguePick('d@x', 2)).toEqual({
      providerId: 'openai',
      id: 'gpt-4',
    });

    // Resolve with quotedMsgId='m-1' should resolve against the older snapshot
    expect(c.resolveCataloguePick('d@x', 1, { quotedMsgId: 'm-1' })).toEqual({
      providerId: 'claude-cli',
      id: 'claude-opus-4-8',
    });
    expect(c.resolveCataloguePick('d@x', 3, { quotedMsgId: 'm-1' })).toEqual({
      providerId: 'anthropic',
      id: 'claude-sonnet-4',
    });

    // Out of range on the quoted message should return null
    expect(c.resolveCataloguePick('d@x', 4, { quotedMsgId: 'm-1' })).toBeNull();
  });

  it('snapshot expires after TTL (~15 min) and returns null', () => {
    vi.useFakeTimers();
    const base = new Date('2026-07-20T00:00:00.000Z').getTime();
    vi.setSystemTime(base);

    const c = createCatalogueSnapshotCache();
    c.putCatalogueSnapshot('d@x', 'm-1', [
      { providerId: 'kimi', id: 'kimi-k3' },
    ]);

    // At TTL start, it resolves
    expect(c.resolveCataloguePick('d@x', 1)).toEqual({
      providerId: 'kimi',
      id: 'kimi-k3',
    });

    // Just before TTL, it still resolves (14 min 59 sec)
    vi.setSystemTime(base + 14 * 60_000 + 59_000);
    expect(c.resolveCataloguePick('d@x', 1)).toEqual({
      providerId: 'kimi',
      id: 'kimi-k3',
    });

    // At TTL boundary (15 min) and beyond, it expires
    vi.setSystemTime(base + 15 * 60_000);
    expect(c.resolveCataloguePick('d@x', 1)).toBeNull();

    // Stays null after TTL
    vi.setSystemTime(base + 20 * 60_000);
    expect(c.resolveCataloguePick('d@x', 1)).toBeNull();
  });

  it('latest snapshot supersedes earlier ones for the same chat', () => {
    vi.useFakeTimers();
    const base = new Date('2026-07-20T00:00:00.000Z').getTime();
    vi.setSystemTime(base);

    const c = createCatalogueSnapshotCache();

    // First snapshot
    c.putCatalogueSnapshot('d@x', 'm-1', [
      { providerId: 'claude-cli', id: 'claude-opus-4-8' },
      { providerId: 'kimi', id: 'kimi-k3' },
    ]);

    expect(c.resolveCataloguePick('d@x', 2)).toEqual({
      providerId: 'kimi',
      id: 'kimi-k3',
    });

    // Second snapshot with different entries, but same chat
    vi.setSystemTime(base + 1_000);
    c.putCatalogueSnapshot('d@x', 'm-2', [
      { providerId: 'anthropic', id: 'claude-sonnet-4' },
    ]);

    // Now N=2 should be out of range (only 1 entry in new snapshot)
    expect(c.resolveCataloguePick('d@x', 2)).toBeNull();
    // N=1 should resolve to the new entry
    expect(c.resolveCataloguePick('d@x', 1)).toEqual({
      providerId: 'anthropic',
      id: 'claude-sonnet-4',
    });
  });

  it('handles multiple chats independently', () => {
    const c = createCatalogueSnapshotCache();

    c.putCatalogueSnapshot('chat-a@x', 'm-1', [
      { providerId: 'claude-cli', id: 'claude-opus-4-8' },
      { providerId: 'kimi', id: 'kimi-k3' },
    ]);

    c.putCatalogueSnapshot('chat-b@x', 'm-2', [
      { providerId: 'openai', id: 'gpt-4' },
    ]);

    expect(c.resolveCataloguePick('chat-a@x', 1)).toEqual({
      providerId: 'claude-cli',
      id: 'claude-opus-4-8',
    });
    expect(c.resolveCataloguePick('chat-a@x', 2)).toEqual({
      providerId: 'kimi',
      id: 'kimi-k3',
    });

    expect(c.resolveCataloguePick('chat-b@x', 1)).toEqual({
      providerId: 'openai',
      id: 'gpt-4',
    });
    expect(c.resolveCataloguePick('chat-b@x', 2)).toBeNull();
  });

  it('prunes expired entries from byMsgId to prevent unbounded growth', () => {
    vi.useFakeTimers();
    const base = new Date('2026-07-20T00:00:00.000Z').getTime();
    vi.setSystemTime(base);

    const c = createCatalogueSnapshotCache();

    // Put an old snapshot
    c.putCatalogueSnapshot('d@x', 'm-old', [
      { providerId: 'kimi', id: 'kimi-k3' },
    ]);
    expect((c as any).getMsgIdMapSize()).toBe(1);

    // Advance time past TTL (15 min + 1 sec)
    vi.setSystemTime(base + 15 * 60_000 + 1_000);

    // Put a new snapshot; this should trigger pruning of expired entries
    c.putCatalogueSnapshot('d@x', 'm-new', [
      { providerId: 'claude-cli', id: 'claude-opus-4-8' },
    ]);

    // Verify old snapshot by msgId returns null (expired)
    expect(c.resolveCataloguePick('d@x', 1, { quotedMsgId: 'm-old' })).toBeNull();

    // Verify the byMsgId map size is only 1 (only the new snapshot, old one pruned)
    expect((c as any).getMsgIdMapSize()).toBe(1);

    // Verify new snapshot resolves correctly
    expect(c.resolveCataloguePick('d@x', 1, { quotedMsgId: 'm-new' })).toEqual({
      providerId: 'claude-cli',
      id: 'claude-opus-4-8',
    });
  });
});
