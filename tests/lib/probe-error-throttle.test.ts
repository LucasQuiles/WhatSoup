// The leaf module's own tests. These cases previously lived in
// tests/core/health-probe-storm.test.ts and imported the class through
// `src/core/health.ts`'s re-export, so the leaf's own module path was only ever
// exercised transitively. The extraction exists precisely so the agent runtime
// can bound a log line without pulling health.ts's transport-reaching import
// graph in, and a test that never imports the leaf directly cannot show that the
// leaf stands alone. Importing it here does.
import { describe, expect, it } from 'vitest';

import { ProbeErrorThrottle } from '../../src/lib/probe-error-throttle.ts';

describe('ProbeErrorThrottle (#1778 Defect B)', () => {
  it('emits on the 1st failure then only at powers of two — O(log N), not O(N)', () => {
    const throttle = new ProbeErrorThrottle();
    const emitted: number[] = [];
    for (let i = 1; i <= 1000; i += 1) {
      const n = throttle.onFailure('probe-x');
      if (n !== null) emitted.push(n);
    }
    // {1,2,4,8,16,32,64,128,256,512} — 10 emissions for 1000 failures.
    expect(emitted).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512]);
  });

  it('keeps distinct probe keys independent', () => {
    const throttle = new ProbeErrorThrottle();
    expect(throttle.onFailure('a')).toBe(1);
    expect(throttle.onFailure('b')).toBe(1);
    expect(throttle.onFailure('a')).toBe(2);
    expect(throttle.onFailure('b')).toBe(2);
  });

  it('onSuccess reports and clears the accumulated failure count so the next storm re-alerts from 1', () => {
    const throttle = new ProbeErrorThrottle();
    for (let i = 0; i < 5; i += 1) throttle.onFailure('probe-y');
    expect(throttle.onSuccess('probe-y')).toBe(5);
    // Clean → nothing to clear.
    expect(throttle.onSuccess('probe-y')).toBe(0);
    // Re-alerts from 1 after recovery.
    expect(throttle.onFailure('probe-y')).toBe(1);
  });

  it('retains a key until it is cleared, so a caller that stops observing a key must clear it', () => {
    // The retention contract the runtime consumer depends on: the throttle has
    // no lifecycle of its own and never expires a key. A caller whose key space
    // shrinks (a conversation leaving the session map) has to call onSuccess for
    // that key, because nothing else will. Pinned here so the consumer-side fix
    // in the runtime's deletion path has a stated contract to rely on.
    const throttle = new ProbeErrorThrottle();
    expect(throttle.onFailure('gone')).toBe(1);
    expect(throttle.onFailure('gone')).toBe(2);
    // Still remembered: a 3rd failure is suppressed rather than re-alerting.
    expect(throttle.onFailure('gone')).toBeNull();
    // Only an explicit clear resets it.
    expect(throttle.onSuccess('gone')).toBe(3);
    expect(throttle.onFailure('gone')).toBe(1);
  });
});
