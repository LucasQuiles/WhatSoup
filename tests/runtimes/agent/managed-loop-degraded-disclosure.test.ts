/**
 * #3149 — managed-loop fallback capability disclosure.
 *
 * When a chat is served by a managed-loop API fallback (openai-api /
 * anthropic-api standing in for a configured CLI primary), the ambient
 * child-process tool surface silently disappears. These tests pin the three
 * pieces that make that degradation visible: the pure eligibility predicate,
 * the user/model copy factories, and the deduped user-notice emit.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  emitManagedLoopDegradedNotice,
  isManagedLoopFallbackDegraded,
  managedLoopDegradedNotice,
  managedLoopDegradedSystemBlock,
} from '../../../src/runtimes/agent/managed-loop-disclosure.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';

describe('isManagedLoopFallbackDegraded (#3149)', () => {
  it('true only for a managed-loop provider standing in for a different configured primary', () => {
    expect(isManagedLoopFallbackDegraded('openai-api', 'claude-cli', false)).toBe(true);
    expect(isManagedLoopFallbackDegraded('anthropic-api', 'claude-cli', false)).toBe(true);
    expect(isManagedLoopFallbackDegraded('anthropic-api', 'opencode-cli', false)).toBe(true);
  });

  it('false when the managed-loop provider IS the configured primary (operator chose it)', () => {
    expect(isManagedLoopFallbackDegraded('openai-api', 'openai-api', false)).toBe(false);
  });

  it('false when a route policy deliberately selected the provider', () => {
    expect(isManagedLoopFallbackDegraded('openai-api', 'claude-cli', true)).toBe(false);
  });

  it('false for non-managed-loop fallbacks (a spawn-per-turn CLI keeps a child process)', () => {
    expect(isManagedLoopFallbackDegraded('opencode-cli', 'claude-cli', false)).toBe(false);
  });

  it('false for an unknown provider string (never guess a disclosure)', () => {
    expect(isManagedLoopFallbackDegraded('mystery-provider', 'claude-cli', false)).toBe(false);
  });
});

function makeEmitHarness(noticeDedupMs: number): {
  recentNotices: Map<string, number>;
  capDedupeMap: ReturnType<typeof vi.fn>;
  emit: (queue: IOutboundQueue) => void;
} {
  const recentNotices = new Map<string, number>();
  const capDedupeMap = vi.fn();
  return {
    recentNotices,
    capDedupeMap,
    emit: (queue) => emitManagedLoopDegradedNotice({ queue, recentNotices, noticeDedupMs, capDedupeMap }),
  };
}

function makeQueue(chatJid: string): { queue: IOutboundQueue; enqueueText: ReturnType<typeof vi.fn> } {
  const enqueueText = vi.fn();
  const queue = { targetChatJid: chatJid, enqueueText } as unknown as IOutboundQueue;
  return { queue, enqueueText };
}

describe('managed-loop degraded copy factories (#3149)', () => {
  it('the user notice names the absent capability classes without provider internals', () => {
    const notice = managedLoopDegradedNotice();
    expect(notice).toMatch(/backup/i);
    expect(notice).toMatch(/shell/i);
    expect(notice).toMatch(/file/i);
    expect(notice).toMatch(/skill/i);
    expect(notice).not.toMatch(/openai|anthropic|claude-cli|oauth/i);
  });

  it('the model context block forbids claiming child-process work', () => {
    const block = managedLoopDegradedSystemBlock();
    expect(block).toMatch(/DEGRADED CAPABILITIES/);
    expect(block).toMatch(/no shell/i);
    expect(block).toMatch(/Do not claim/i);
    expect(block).not.toMatch(/openai|anthropic/i);
  });
});

describe('emitManagedLoopDegradedNotice (#3149)', () => {
  it('enqueues exactly once per chat inside the dedup window', () => {
    const h = makeEmitHarness(60_000);
    const { queue, enqueueText } = makeQueue('probe@s.whatsapp.net');
    h.emit(queue);
    h.emit(queue);
    expect(enqueueText).toHaveBeenCalledTimes(1);
  });

  it('re-notifies after the dedup window expires (a days-long degradation is not one-shot)', () => {
    const h = makeEmitHarness(60_000);
    const { queue, enqueueText } = makeQueue('probe@s.whatsapp.net');
    h.emit(queue);
    // Age the recorded entry past the window instead of faking the clock.
    for (const key of h.recentNotices.keys()) h.recentNotices.set(key, Date.now() - 60_001);
    h.emit(queue);
    expect(enqueueText).toHaveBeenCalledTimes(2);
  });

  it('dedup is per chat, and the shared cap guard runs on every record', () => {
    const h = makeEmitHarness(60_000);
    const a = makeQueue('probe-a@s.whatsapp.net');
    const b = makeQueue('probe-b@s.whatsapp.net');
    h.emit(a.queue);
    h.emit(b.queue);
    expect(a.enqueueText).toHaveBeenCalledTimes(1);
    expect(b.enqueueText).toHaveBeenCalledTimes(1);
    expect(h.capDedupeMap).toHaveBeenCalledTimes(2);
  });
});
