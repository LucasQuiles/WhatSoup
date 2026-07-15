import { describe, expect, it, vi } from 'vitest';

import {
  adaptEmojisForSingleSlot,
  createStatusReactionController,
  DEFAULT_STATUS_REACTION_EMOJIS,
  type StatusReactionAdapter,
  type StatusReactionEmojis,
} from '../../src/lib/status-reaction-controller.ts';

function makeAdapter(): StatusReactionAdapter & {
  calls: { set: string[]; clear: number };
} {
  return {
    calls: { set: [], clear: 0 },
    async setReaction(emoji: string) { this.calls.set.push(emoji); },
    async clearReaction() { this.calls.clear++; },
  } as StatusReactionAdapter & { calls: { set: string[]; clear: number } };
}

describe('createStatusReactionController', () => {
  const emojis: StatusReactionEmojis = {
    queued: '👀',
    thinking: '🤔',
    tool: '🔧',
    compacting: '📦',
    done: '✅',
    error: '❌',
    stallSoft: '⏳',
    stallHard: '⏰',
  };

  it('sets queued emoji on setQueued', async () => {
    const adapter = makeAdapter();
    const ctrl = createStatusReactionController(adapter, { emojis });
    ctrl.setQueued();
    await vi.waitFor(() => expect(adapter.calls.set).toContain('👀'));
    expect(ctrl.getState()).toBe('queued');
    expect(ctrl.getCurrentEmoji()).toBe('👀');
  });

  it('transitions through queued → thinking → tool → done', async () => {
    const adapter = makeAdapter();
    const ctrl = createStatusReactionController(adapter, {
      emojis,
      removeAfterFinalize: false,
    });
    ctrl.setQueued();
    ctrl.setThinking();
    ctrl.setTool();
    ctrl.setDone();
    await vi.waitFor(() => expect(adapter.calls.set).toContain('✅'));
    expect(adapter.calls.set).toEqual(['👀', '🤔', '🔧', '✅']);
    expect(ctrl.isFinalized()).toBe(true);
  });

  it('coalesces redundant state transitions', async () => {
    const adapter = makeAdapter();
    const ctrl = createStatusReactionController(adapter, {
      emojis,
      removeAfterFinalize: false,
    });
    ctrl.setThinking();
    ctrl.setThinking();
    ctrl.setThinking();
    await vi.waitFor(() => expect(adapter.calls.set.length).toBe(1));
    expect(adapter.calls.set).toEqual(['🤔']);
  });

  it('sets error emoji on setError', async () => {
    const adapter = makeAdapter();
    const ctrl = createStatusReactionController(adapter, {
      emojis,
      removeAfterFinalize: false,
    });
    ctrl.setError();
    await vi.waitFor(() => expect(adapter.calls.set).toContain('❌'));
    expect(ctrl.isFinalized()).toBe(true);
  });

  it('clears the reaction after done when removeAfterFinalize is true', async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const ctrl = createStatusReactionController(adapter, {
      emojis,
      removeAfterFinalize: true,
      removeDelayMs: 1000,
    });
    ctrl.setDone();
    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.calls.clear).toBe(1);
    vi.useRealTimers();
  });

  it('clears the reaction after error when removeAfterFinalize is true', async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const ctrl = createStatusReactionController(adapter, {
      emojis,
      removeAfterFinalize: true,
      removeDelayMs: 500,
    });
    ctrl.setError();
    await vi.advanceTimersByTimeAsync(500);
    expect(adapter.calls.clear).toBe(1);
    vi.useRealTimers();
  });

  it('restores initial emoji when restoreInitialAfterFinalize is true', async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const ctrl = createStatusReactionController(adapter, {
      emojis,
      removeAfterFinalize: false,
      restoreInitialAfterFinalize: true,
      removeDelayMs: 500,
    });
    ctrl.setQueued();
    ctrl.setThinking();
    ctrl.setDone();
    await vi.advanceTimersByTimeAsync(500);
    // After done + delay, should have restored queued emoji
    expect(adapter.calls.set[adapter.calls.set.length - 1]).toBe('👀');
    expect(adapter.calls.clear).toBe(0);
    vi.useRealTimers();
  });

  it('does not clear when removeAfterFinalize is false and restoreInitial is false', async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const ctrl = createStatusReactionController(adapter, {
      emojis,
      removeAfterFinalize: false,
      restoreInitialAfterFinalize: false,
    });
    ctrl.setDone();
    await vi.advanceTimersByTimeAsync(10000);
    expect(adapter.calls.clear).toBe(0);
    expect(adapter.calls.set).toContain('✅');
    vi.useRealTimers();
  });

  it('ignores state changes after finalize', async () => {
    const adapter = makeAdapter();
    const ctrl = createStatusReactionController(adapter, {
      emojis,
      removeAfterFinalize: false,
    });
    ctrl.setDone();
    await vi.waitFor(() => expect(adapter.calls.set).toContain('✅'));
    const setCountBefore = adapter.calls.set.length;
    ctrl.setThinking();
    ctrl.setTool();
    ctrl.setQueued();
    // No new setReaction calls after finalize
    expect(adapter.calls.set.length).toBe(setCountBefore);
  });

  it('clear() cancels pending removal timer', async () => {
    vi.useFakeTimers();
    const adapter = makeAdapter();
    const ctrl = createStatusReactionController(adapter, {
      emojis,
      removeAfterFinalize: true,
      removeDelayMs: 1000,
    });
    ctrl.setDone();
    // Cancel the scheduled removal
    ctrl.clear();
    expect(adapter.calls.clear).toBe(1); // clear() itself fires clearReaction
    await vi.advanceTimersByTimeAsync(2000);
    // No additional clear from the cancelled timer
    expect(adapter.calls.clear).toBe(1);
    vi.useRealTimers();
  });

  it('clear() prevents further state changes', async () => {
    const adapter = makeAdapter();
    const ctrl = createStatusReactionController(adapter, {
      emojis,
      removeAfterFinalize: false,
    });
    ctrl.clear();
    const setCount = adapter.calls.set.length;
    ctrl.setQueued();
    ctrl.setThinking();
    expect(adapter.calls.set.length).toBe(setCount); // no new sets
  });

  it('isolation: adapter errors do not throw', () => {
    const adapter: StatusReactionAdapter = {
      async setReaction() { throw new Error('network failure'); },
      async clearReaction() { throw new Error('network failure'); },
    };
    const onError = vi.fn();
    const ctrl = createStatusReactionController(adapter, { emojis, onError });
    expect(() => ctrl.setQueued()).not.toThrow();
  });

  it('isolation: adapter errors call onError callback', async () => {
    const adapter: StatusReactionAdapter = {
      async setReaction() { throw new Error('rate limited'); },
      async clearReaction() { throw new Error('rate limited'); },
    };
    const onError = vi.fn();
    const ctrl = createStatusReactionController(adapter, { emojis, onError });
    ctrl.setQueued();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'setReaction(👀)');
  });

  it('swallows non-Error rejections from adapter', async () => {
    const adapter: StatusReactionAdapter = {
      async setReaction() { throw 'string error'; },
      async clearReaction() {},
    };
    const onError = vi.fn();
    const ctrl = createStatusReactionController(adapter, { emojis, onError });
    ctrl.setQueued();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('uses fallback emoji for compacting when not specified', async () => {
    const adapter = makeAdapter();
    const minimalEmojis: StatusReactionEmojis = {
      queued: '👍', thinking: '🤔', tool: '🔧', done: '✅', error: '❌',
    };
    const ctrl = createStatusReactionController(adapter, {
      emojis: minimalEmojis,
      removeAfterFinalize: false,
    });
    ctrl.setCompacting();
    // Falls back to thinking emoji
    await vi.waitFor(() => expect(adapter.calls.set).toContain('🤔'));
  });

  it('uses fallback chain for stall-soft and stall-hard', async () => {
    const adapter = makeAdapter();
    const minimalEmojis: StatusReactionEmojis = {
      queued: '👍', thinking: '🤔', tool: '🔧', done: '✅', error: '❌',
    };
    const ctrl = createStatusReactionController(adapter, {
      emojis: minimalEmojis,
      removeAfterFinalize: false,
    });
    ctrl.setStallSoft();
    // Falls back to thinking emoji
    await vi.waitFor(() => expect(adapter.calls.set).toContain('🤔'));
  });

  it('getState() returns null initially', () => {
    const adapter = makeAdapter();
    const ctrl = createStatusReactionController(adapter, { emojis });
    expect(ctrl.getState()).toBeNull();
  });

  it('getCurrentEmoji() returns null initially', () => {
    const adapter = makeAdapter();
    const ctrl = createStatusReactionController(adapter, { emojis });
    expect(ctrl.getCurrentEmoji()).toBeNull();
  });
});

describe('adaptEmojisForSingleSlot', () => {
  it('sets stallHard equal to stallSoft for single-slot platforms', () => {
    const result = adaptEmojisForSingleSlot(DEFAULT_STATUS_REACTION_EMOJIS);
    expect(result.stallHard).toBe(result.stallSoft);
    expect(result.stallHard).toBe('⏳');
  });

  it('falls back to thinking when stallSoft is absent', () => {
    const emojis: StatusReactionEmojis = {
      queued: '👀', thinking: '🤔', tool: '🔧', done: '✅', error: '❌',
    };
    const result = adaptEmojisForSingleSlot(emojis);
    expect(result.stallHard).toBe('🤔');
  });

  it('preserves other emojis', () => {
    const result = adaptEmojisForSingleSlot(DEFAULT_STATUS_REACTION_EMOJIS);
    expect(result.queued).toBe('👀');
    expect(result.done).toBe('✅');
    expect(result.error).toBe('❌');
  });
});

describe('DEFAULT_STATUS_REACTION_EMOJIS', () => {
  it('has all required states', () => {
    expect(DEFAULT_STATUS_REACTION_EMOJIS.queued).toBeTruthy();
    expect(DEFAULT_STATUS_REACTION_EMOJIS.thinking).toBeTruthy();
    expect(DEFAULT_STATUS_REACTION_EMOJIS.tool).toBeTruthy();
    expect(DEFAULT_STATUS_REACTION_EMOJIS.done).toBeTruthy();
    expect(DEFAULT_STATUS_REACTION_EMOJIS.error).toBeTruthy();
  });
});
