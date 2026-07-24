import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  createCatalogueSnapshotCache,
  type CatalogueEntry,
  type CatalogueSnapshotCache,
} from '../../../src/runtimes/agent/model-snapshot-cache.ts';

afterEach(() => vi.useRealTimers());
beforeEach(() => vi.clearAllMocks());

describe('CatalogueSnapshotCache', () => {
  const SENDER_A = 'sender-a@x';
  const SENDER_B = 'sender-b@x';

  it('resolves N against the snapshot the user saw', () => {
    const c = createCatalogueSnapshotCache();
    c.putCatalogueSnapshot('d@x', SENDER_A, 'm-1', [
      { providerId: 'claude-cli', id: 'claude-opus-4-8' },
      { providerId: 'kimi', id: 'kimi-k3' },
    ]);
    expect(c.resolveCataloguePick('d@x', SENDER_A, 2)).toEqual({
      providerId: 'kimi',
      id: 'kimi-k3',
    });
  });

  it('miss (out of range / expired) returns null, not a wrong pick', () => {
    const c = createCatalogueSnapshotCache();
    c.putCatalogueSnapshot('d@x', SENDER_A, 'm-1', [
      { providerId: 'kimi', id: 'kimi-k3' },
    ]);
    expect(c.resolveCataloguePick('d@x', SENDER_A, 5)).toBeNull(); // out of range
    expect(c.resolveCataloguePick('other@x', SENDER_A, 1)).toBeNull(); // no snapshot for chat
  });

  it('quoted-reply resolves against the quoted message snapshot', () => {
    vi.useFakeTimers();
    const base = new Date('2026-07-20T00:00:00.000Z').getTime();
    vi.setSystemTime(base);

    const c = createCatalogueSnapshotCache();

    // First snapshot at m-1
    c.putCatalogueSnapshot('d@x', SENDER_A, 'm-1', [
      { providerId: 'claude-cli', id: 'claude-opus-4-8' },
      { providerId: 'kimi', id: 'kimi-k3' },
      { providerId: 'anthropic', id: 'claude-sonnet-4' },
    ]);

    // Advance time and put a newer snapshot at m-2
    vi.setSystemTime(base + 60_000);
    c.putCatalogueSnapshot('d@x', SENDER_A, 'm-2', [
      { providerId: 'claude-cli', id: 'claude-opus-4-8' },
      { providerId: 'openai', id: 'gpt-4' },
    ]);

    // Resolve without quotedMsgId should resolve against the latest (m-2)
    expect(c.resolveCataloguePick('d@x', SENDER_A, 1)).toEqual({
      providerId: 'claude-cli',
      id: 'claude-opus-4-8',
    });
    expect(c.resolveCataloguePick('d@x', SENDER_A, 2)).toEqual({
      providerId: 'openai',
      id: 'gpt-4',
    });

    // Resolve with quotedMsgId='m-1' should resolve against the older snapshot
    expect(c.resolveCataloguePick('d@x', SENDER_A, 1, { quotedMsgId: 'm-1' })).toEqual({
      providerId: 'claude-cli',
      id: 'claude-opus-4-8',
    });
    expect(c.resolveCataloguePick('d@x', SENDER_A, 3, { quotedMsgId: 'm-1' })).toEqual({
      providerId: 'anthropic',
      id: 'claude-sonnet-4',
    });

    // Out of range on the quoted message should return null
    expect(c.resolveCataloguePick('d@x', SENDER_A, 4, { quotedMsgId: 'm-1' })).toBeNull();
  });

  it('snapshot expires after TTL (~15 min) and returns null', () => {
    vi.useFakeTimers();
    const base = new Date('2026-07-20T00:00:00.000Z').getTime();
    vi.setSystemTime(base);

    const c = createCatalogueSnapshotCache();
    c.putCatalogueSnapshot('d@x', SENDER_A, 'm-1', [
      { providerId: 'kimi', id: 'kimi-k3' },
    ]);

    // At TTL start, it resolves
    expect(c.resolveCataloguePick('d@x', SENDER_A, 1)).toEqual({
      providerId: 'kimi',
      id: 'kimi-k3',
    });

    // Just before TTL, it still resolves (14 min 59 sec)
    vi.setSystemTime(base + 14 * 60_000 + 59_000);
    expect(c.resolveCataloguePick('d@x', SENDER_A, 1)).toEqual({
      providerId: 'kimi',
      id: 'kimi-k3',
    });

    // At TTL boundary (15 min) and beyond, it expires
    vi.setSystemTime(base + 15 * 60_000);
    expect(c.resolveCataloguePick('d@x', SENDER_A, 1)).toBeNull();

    // Stays null after TTL
    vi.setSystemTime(base + 20 * 60_000);
    expect(c.resolveCataloguePick('d@x', SENDER_A, 1)).toBeNull();
  });

  it('latest snapshot supersedes earlier ones for the same chat AND sender', () => {
    vi.useFakeTimers();
    const base = new Date('2026-07-20T00:00:00.000Z').getTime();
    vi.setSystemTime(base);

    const c = createCatalogueSnapshotCache();

    // First snapshot
    c.putCatalogueSnapshot('d@x', SENDER_A, 'm-1', [
      { providerId: 'claude-cli', id: 'claude-opus-4-8' },
      { providerId: 'kimi', id: 'kimi-k3' },
    ]);

    expect(c.resolveCataloguePick('d@x', SENDER_A, 2)).toEqual({
      providerId: 'kimi',
      id: 'kimi-k3',
    });

    // Second snapshot with different entries, same chat AND same sender
    vi.setSystemTime(base + 1_000);
    c.putCatalogueSnapshot('d@x', SENDER_A, 'm-2', [
      { providerId: 'anthropic', id: 'claude-sonnet-4' },
    ]);

    // Now N=2 should be out of range (only 1 entry in new snapshot)
    expect(c.resolveCataloguePick('d@x', SENDER_A, 2)).toBeNull();
    // N=1 should resolve to the new entry
    expect(c.resolveCataloguePick('d@x', SENDER_A, 1)).toEqual({
      providerId: 'anthropic',
      id: 'claude-sonnet-4',
    });
  });

  it('handles multiple chats independently', () => {
    const c = createCatalogueSnapshotCache();

    c.putCatalogueSnapshot('chat-a@x', SENDER_A, 'm-1', [
      { providerId: 'claude-cli', id: 'claude-opus-4-8' },
      { providerId: 'kimi', id: 'kimi-k3' },
    ]);

    c.putCatalogueSnapshot('chat-b@x', SENDER_A, 'm-2', [
      { providerId: 'openai', id: 'gpt-4' },
    ]);

    expect(c.resolveCataloguePick('chat-a@x', SENDER_A, 1)).toEqual({
      providerId: 'claude-cli',
      id: 'claude-opus-4-8',
    });
    expect(c.resolveCataloguePick('chat-a@x', SENDER_A, 2)).toEqual({
      providerId: 'kimi',
      id: 'kimi-k3',
    });

    expect(c.resolveCataloguePick('chat-b@x', SENDER_A, 1)).toEqual({
      providerId: 'openai',
      id: 'gpt-4',
    });
    expect(c.resolveCataloguePick('chat-b@x', SENDER_A, 2)).toBeNull();
  });

  // IMPORTANT 2 (final-review): the "latest" slot is keyed per-(chatJid,
  // senderJid) — a second/filtered render by a DIFFERENT sender in the SAME
  // chat must never repoint the first sender's numbered pick. Before this
  // fix, `latestByChat` was keyed by chatJid alone with a constant synthetic
  // msgId, so B's render silently overwrote A's snapshot.
  it('keeps each sender\'s latest snapshot independent within the SAME chat', () => {
    const c = createCatalogueSnapshotCache();

    // A renders a filtered menu — just one entry.
    c.putCatalogueSnapshot('group@x', SENDER_A, 'model-list:group@x', [
      { providerId: 'opencode-cli', id: 'kimi/kimi-k3' },
    ]);

    // B renders the full, unfiltered menu in the SAME chat — same constant
    // msgId shape a real render would use (per-chat, not per-render).
    c.putCatalogueSnapshot('group@x', SENDER_B, 'model-list:group@x', [
      { providerId: 'claude-cli', id: 'claude-opus-4-8' },
      { providerId: 'opencode-cli', id: 'kimi/kimi-k3' },
      { providerId: 'opencode-cli', id: 'glm/glm-5.2' },
    ]);

    // A's own N=1 must still resolve against what A saw, not B's later render.
    expect(c.resolveCataloguePick('group@x', SENDER_A, 1)).toEqual({
      providerId: 'opencode-cli',
      id: 'kimi/kimi-k3',
    });
    // B's N=1 resolves against B's own (full) menu.
    expect(c.resolveCataloguePick('group@x', SENDER_B, 1)).toEqual({
      providerId: 'claude-cli',
      id: 'claude-opus-4-8',
    });
    expect(c.resolveCataloguePick('group@x', SENDER_B, 3)).toEqual({
      providerId: 'opencode-cli',
      id: 'glm/glm-5.2',
    });
    // A never saw a 3rd entry — out of range against A's own snapshot.
    expect(c.resolveCataloguePick('group@x', SENDER_A, 3)).toBeNull();
  });

  it('prunes expired entries from byMsgId to prevent unbounded growth', () => {
    vi.useFakeTimers();
    const base = new Date('2026-07-20T00:00:00.000Z').getTime();
    vi.setSystemTime(base);

    const c = createCatalogueSnapshotCache();

    // Put an old snapshot
    c.putCatalogueSnapshot('d@x', SENDER_A, 'm-old', [
      { providerId: 'kimi', id: 'kimi-k3' },
    ]);
    expect((c as any).getMsgIdMapSize()).toBe(1);

    // Advance time past TTL (15 min + 1 sec)
    vi.setSystemTime(base + 15 * 60_000 + 1_000);

    // Put a new snapshot; this should trigger pruning of expired entries
    c.putCatalogueSnapshot('d@x', SENDER_A, 'm-new', [
      { providerId: 'claude-cli', id: 'claude-opus-4-8' },
    ]);

    // Verify old snapshot by msgId returns null (expired)
    expect(c.resolveCataloguePick('d@x', SENDER_A, 1, { quotedMsgId: 'm-old' })).toBeNull();

    // Verify the byMsgId map size is only 1 (only the new snapshot, old one pruned)
    expect((c as any).getMsgIdMapSize()).toBe(1);

    // Verify new snapshot resolves correctly
    expect(c.resolveCataloguePick('d@x', SENDER_A, 1, { quotedMsgId: 'm-new' })).toEqual({
      providerId: 'claude-cli',
      id: 'claude-opus-4-8',
    });
  });

  // ── Slice 2: the drill layer shares ONE latest slot with the flat menu ──────
  describe('drill layer (Slice 2) — single-slot recency', () => {
    const CHAT = 'g@g.us';
    const BRAND_ENTRY = { kind: 'brand' as const, label: 'OpenCode', brand: 'OpenCode', provider: 'opencode-cli' };
    const FLAT_ENTRY: CatalogueEntry = { providerId: 'claude-cli', id: 'claude-opus-4-8' };

    it('a drill write SUPERSEDES the flat slot: resolveLatestPick returns the drill, resolveCataloguePick MISSES', () => {
      const c = createCatalogueSnapshotCache();
      c.putCatalogueSnapshot(CHAT, SENDER_A, 'm-1', [FLAT_ENTRY]);
      c.putDrillSnapshot(CHAT, SENDER_A, 'brand', [BRAND_ENTRY]);
      expect(c.resolveLatestPick(CHAT, SENDER_A, 1)).toEqual({ kind: 'drill', entry: BRAND_ENTRY });
      // The flat-only reader (used by `/model N default`) must NOT pin the
      // stale flat entry while a newer drill is what the user is looking at.
      expect(c.resolveCataloguePick(CHAT, SENDER_A, 1)).toBeNull();
      expect(c.latestSnapshotKind(CHAT, SENDER_A)).toBe('drill');
    });

    it('a flat write SUPERSEDES the drill slot: both readers return the flat entry again', () => {
      const c = createCatalogueSnapshotCache();
      c.putDrillSnapshot(CHAT, SENDER_A, 'brand', [BRAND_ENTRY]);
      c.putCatalogueSnapshot(CHAT, SENDER_A, 'm-2', [FLAT_ENTRY]);
      expect(c.resolveLatestPick(CHAT, SENDER_A, 1)).toEqual({ kind: 'flat', entry: FLAT_ENTRY });
      expect(c.resolveCataloguePick(CHAT, SENDER_A, 1)).toEqual(FLAT_ENTRY);
      expect(c.latestSnapshotKind(CHAT, SENDER_A)).toBe('flat');
    });

    it('per-(chat,sender) isolation ACROSS kinds: B opening a drill never repoints A’s flat pick in the same chat', () => {
      const c = createCatalogueSnapshotCache();
      c.putCatalogueSnapshot(CHAT, SENDER_A, 'm-1', [FLAT_ENTRY]);
      c.putDrillSnapshot(CHAT, SENDER_B, 'brand', [BRAND_ENTRY]);
      expect(c.resolveLatestPick(CHAT, SENDER_A, 1)).toEqual({ kind: 'flat', entry: FLAT_ENTRY });
      expect(c.resolveLatestPick(CHAT, SENDER_B, 1)).toEqual({ kind: 'drill', entry: BRAND_ENTRY });
      // Each sender's `/model N default` behaves per THEIR own slot.
      expect(c.resolveCataloguePick(CHAT, SENDER_A, 1)).toEqual(FLAT_ENTRY);
      expect(c.resolveCataloguePick(CHAT, SENDER_B, 1)).toBeNull();
      expect(c.latestSnapshotKind(CHAT, SENDER_A)).toBe('flat');
      expect(c.latestSnapshotKind(CHAT, SENDER_B)).toBe('drill');
    });

    it('out-of-range on a live drill returns null without disturbing the slot kind', () => {
      const c = createCatalogueSnapshotCache();
      c.putDrillSnapshot(CHAT, SENDER_A, 'brand', [BRAND_ENTRY]);
      expect(c.resolveLatestPick(CHAT, SENDER_A, 9)).toBeNull();
      // Still a live drill — the miss re-render must show the drill, not flat.
      expect(c.latestSnapshotKind(CHAT, SENDER_A)).toBe('drill');
    });

    it('an EXPIRED drill slot reads as no-snapshot on every path (consistent TTL boundary)', () => {
      vi.useFakeTimers();
      const c = createCatalogueSnapshotCache();
      c.putDrillSnapshot(CHAT, SENDER_A, 'brand', [BRAND_ENTRY]);
      vi.advanceTimersByTime(15 * 60_000 + 1);
      expect(c.resolveLatestPick(CHAT, SENDER_A, 1)).toBeNull();
      expect(c.resolveCataloguePick(CHAT, SENDER_A, 1)).toBeNull();
      // null (not 'drill') → a true snapshot-miss, so the handler opens L1.
      expect(c.latestSnapshotKind(CHAT, SENDER_A)).toBeNull();
    });

    it('an empty drill snapshot (Level-1 degrade) makes a following pick MISS cleanly, never resolving a stale flat entry', () => {
      const c = createCatalogueSnapshotCache();
      c.putCatalogueSnapshot(CHAT, SENDER_A, 'm-1', [FLAT_ENTRY]);
      c.putDrillSnapshot(CHAT, SENDER_A, 'brand', []); // degrade path writes empty
      expect(c.resolveLatestPick(CHAT, SENDER_A, 1)).toBeNull();
      expect(c.resolveCataloguePick(CHAT, SENDER_A, 1)).toBeNull();
    });
  });
});
