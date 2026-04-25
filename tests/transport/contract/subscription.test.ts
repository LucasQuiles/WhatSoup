// tests/transport/contract/subscription.test.ts
import { describe, it, expect, vi } from 'vitest';
import { makeSubscription, type Subscription } from '../../../src/transport/contract/subscription.ts';

describe('Subscription', () => {
  it('dispose() is idempotent — second call is a no-op, no throw', () => {
    const onDispose = vi.fn();
    const sub: Subscription = makeSubscription(onDispose);
    sub.dispose();
    sub.dispose();
    sub.dispose();
    expect(onDispose).toHaveBeenCalledTimes(1);
  });

  it('dispose() runs the cleanup callback exactly once', () => {
    const cleanup = vi.fn();
    const sub = makeSubscription(cleanup);
    expect(cleanup).not.toHaveBeenCalled();
    sub.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('makeSubscription with no callback still has an idempotent dispose', () => {
    const sub = makeSubscription();
    expect(() => { sub.dispose(); sub.dispose(); }).not.toThrow();
  });
});
