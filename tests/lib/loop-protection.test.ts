import { describe, expect, it, vi } from 'vitest';

import {
  createBotLoopGuard,
  createConversationLoopLimiter,
} from '../../src/lib/loop-protection.ts';

// ── createConversationLoopLimiter ─────────────────────────────────────────

describe('createConversationLoopLimiter', () => {
  it('allows messages below the threshold', () => {
    const limiter = createConversationLoopLimiter({ maxHitsPerWindow: 5 });
    for (let i = 0; i < 4; i++) {
      const result = limiter.check('chat1', `msg${i}`);
      expect(result.decision).toBe('allow');
    }
    limiter.stop();
  });

  it('blocks after threshold is exceeded', () => {
    const limiter = createConversationLoopLimiter({ maxHitsPerWindow: 3 });
    limiter.check('chat1', 'a');
    limiter.check('chat1', 'b');
    limiter.check('chat1', 'c');
    const result = limiter.check('chat1', 'd');
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('threshold');
    limiter.stop();
  });

  it('enforces cooldown after triggering', () => {
    let fakeNow = 0;
    const limiter = createConversationLoopLimiter({
      maxHitsPerWindow: 2,
      cooldownMs: 1000,
      now: () => fakeNow,
    });
    fakeNow = 0;
    limiter.check('chat1', 'a');
    limiter.check('chat1', 'b');
    // 3rd hit triggers cooldown
    const blocked = limiter.check('chat1', 'c');
    expect(blocked.decision).toBe('block');

    // During cooldown, all messages blocked
    fakeNow = 500;
    const duringCooldown = limiter.check('chat1', 'd');
    expect(duringCooldown.decision).toBe('block');
    expect(duringCooldown.cooldownRemainingMs).toBe(500);

    // After cooldown, allowed again
    fakeNow = 1001;
    const afterCooldown = limiter.check('chat1', 'e');
    expect(afterCooldown.decision).toBe('allow');
    limiter.stop();
  });

  it('detects identical-message loops separately from rate', () => {
    let fakeNow = 0;
    const limiter = createConversationLoopLimiter({
      maxHitsPerWindow: 100, // high rate threshold
      maxIdenticalPerWindow: 5, // lower identical threshold
      now: () => fakeNow,
    });
    // Send the same message many times — identical count should trigger
    for (let i = 0; i < 5; i++) {
      fakeNow = i * 100;
      const result = limiter.check('chat1', 'same message');
      if (i < 4) {
        expect(result.decision).toBe('allow');
      }
    }
    // 5th identical message should trigger (default threshold 5)
    fakeNow = 500;
    const result = limiter.check('chat1', 'same message');
    expect(result.decision).toBe('block');
    limiter.stop();
  });

  it('does NOT trigger on different messages at low rate', () => {
    const limiter = createConversationLoopLimiter({ maxHitsPerWindow: 10 });
    for (let i = 0; i < 5; i++) {
      const result = limiter.check('chat1', `unique-${i}`);
      expect(result.decision).toBe('allow');
    }
    limiter.stop();
  });

  it('isolates conversations — one tripping does not affect others', () => {
    const limiter = createConversationLoopLimiter({ maxHitsPerWindow: 2 });
    limiter.check('chat1', 'a');
    limiter.check('chat1', 'b');
    const blocked = limiter.check('chat1', 'c');
    expect(blocked.decision).toBe('block');

    const otherResult = limiter.check('chat2', 'x');
    expect(otherResult.decision).toBe('allow');
    limiter.stop();
  });

  it('prunes old hits outside the window', () => {
    let fakeNow = 0;
    const limiter = createConversationLoopLimiter({
      maxHitsPerWindow: 3,
      windowMs: 1000,
      now: () => fakeNow,
    });
    fakeNow = 0;
    limiter.check('chat1', 'a');
    fakeNow = 500;
    limiter.check('chat1', 'b');
    fakeNow = 1100; // first hit pruned
    limiter.check('chat1', 'c');
    // Should still be allowed (only 2 hits in window)
    fakeNow = 1200;
    const result = limiter.check('chat1', 'd');
    expect(result.decision).toBe('allow');
    limiter.stop();
  });

  it('reset(conversationKey) clears a single conversation', () => {
    const limiter = createConversationLoopLimiter({ maxHitsPerWindow: 2 });
    limiter.check('chat1', 'a');
    limiter.check('chat1', 'b');
    expect(limiter.check('chat1', 'c').decision).toBe('block');
    limiter.reset('chat1');
    expect(limiter.check('chat1', 'd').decision).toBe('allow');
    limiter.stop();
  });

  it('resetAll() clears all conversations', () => {
    const limiter = createConversationLoopLimiter({ maxHitsPerWindow: 2 });
    limiter.check('chat1', 'a');
    limiter.check('chat1', 'b');
    limiter.check('chat2', 'a');
    limiter.check('chat2', 'b');
    limiter.resetAll();
    expect(limiter.check('chat1', 'c').decision).toBe('allow');
    expect(limiter.check('chat2', 'c').decision).toBe('allow');
    limiter.stop();
  });

  it('compareText=false disables identical-text detection', () => {
    const limiter = createConversationLoopLimiter({
      maxHitsPerWindow: 100,
      compareText: false,
    });
    for (let i = 0; i < 10; i++) {
      const result = limiter.check('chat1', 'same');
      expect(result.decision).toBe('allow');
    }
    limiter.stop();
  });

  it('tracks hitCount in allow results', () => {
    const limiter = createConversationLoopLimiter({ maxHitsPerWindow: 5 });
    expect(limiter.check('chat1', 'a').hitCount).toBe(1);
    expect(limiter.check('chat1', 'b').hitCount).toBe(2);
    limiter.stop();
  });
});

// ── createBotLoopGuard ────────────────────────────────────────────────────

describe('createBotLoopGuard', () => {
  it('allows events below the threshold', () => {
    const guard = createBotLoopGuard({ maxEventsPerWindow: 10 });
    for (let i = 0; i < 9; i++) {
      const result = guard.check();
      expect(result.decision).toBe('allow');
    }
  });

  it('blocks after threshold is exceeded', () => {
    const guard = createBotLoopGuard({ maxEventsPerWindow: 5 });
    for (let i = 0; i < 5; i++) guard.check();
    const result = guard.check();
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('threshold');
  });

  it('enforces global cooldown after triggering', () => {
    let fakeNow = 0;
    const guard = createBotLoopGuard({
      maxEventsPerWindow: 3,
      windowSeconds: 60,
      cooldownSeconds: 30,
      now: () => fakeNow,
    });
    fakeNow = 0;
    guard.check();
    guard.check();
    guard.check();
    const blocked = guard.check();
    expect(blocked.decision).toBe('block');

    fakeNow = 10_000;
    const duringCooldown = guard.check();
    expect(duringCooldown.decision).toBe('block');

    fakeNow = 35_000;
    const after = guard.check();
    expect(after.decision).toBe('allow');
  });

  it('peek() does NOT record the event', () => {
    const guard = createBotLoopGuard({ maxEventsPerWindow: 3 });
    guard.peek();
    guard.peek();
    guard.peek();
    // peek did not record, so check should still be allowed
    const result = guard.check();
    expect(result.decision).toBe('allow');
    expect(result.eventsInWindow).toBe(1);
  });

  it('triggerCooldown() immediately blocks all events', () => {
    let fakeNow = 0;
    const guard = createBotLoopGuard({ cooldownSeconds: 60, now: () => fakeNow });
    guard.triggerCooldown('external signal');
    const result = guard.check();
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('cooldown');
  });

  it('reset() clears events and cooldown', () => {
    const guard = createBotLoopGuard({ maxEventsPerWindow: 2 });
    guard.check();
    guard.check();
    expect(guard.check().decision).toBe('block');
    guard.reset();
    expect(guard.check().decision).toBe('allow');
  });

  it('tracks eventsInWindow in allow results', () => {
    const guard = createBotLoopGuard({ maxEventsPerWindow: 10 });
    expect(guard.check().eventsInWindow).toBe(1);
    expect(guard.check().eventsInWindow).toBe(2);
    expect(guard.check().eventsInWindow).toBe(3);
  });

  it('prunes events outside the window', () => {
    let fakeNow = 0;
    const guard = createBotLoopGuard({
      maxEventsPerWindow: 3,
      windowSeconds: 1,
      now: () => fakeNow,
    });
    fakeNow = 0;
    guard.check();
    fakeNow = 500;
    guard.check();
    fakeNow = 1100; // first event pruned
    guard.check();
    // Should still be allowed (2 events in window)
    fakeNow = 1200;
    expect(guard.check().decision).toBe('allow');
  });

  it('works across multiple conversations (global scope)', () => {
    const guard = createBotLoopGuard({ maxEventsPerWindow: 3 });
    // The guard is global — it doesn't know about conversations
    guard.check();
    guard.check();
    guard.check();
    // 4th event from ANY context triggers
    expect(guard.check().decision).toBe('block');
  });
});
