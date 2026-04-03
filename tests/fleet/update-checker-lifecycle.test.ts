/**
 * UpdateChecker lifecycle tests — start() / stop() timer management.
 *
 * Coverage:
 *  - start() fires checkNow() immediately
 *  - start() sets a recurring interval
 *  - stop() clears the interval and nulls the timer
 *  - stop() is idempotent (safe to call twice)
 *  - checkNow() local rev-parse failure is caught and does not throw
 *  - rev-list directional check: only flags updateAvailable when remote has commits
 *    that local does not (not when local is simply different from remote SHA)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UpdateChecker } from '../../src/fleet/update-checker.ts';

describe('UpdateChecker — start() / stop() lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start() immediately calls checkNow()', async () => {
    const checker = new UpdateChecker('/tmp/fake');
    const checkNowSpy = vi.spyOn(checker, 'checkNow').mockResolvedValue({} as any);

    checker.start();

    // The first call is fire-and-forget (.catch(() => {})), so give a tick
    await Promise.resolve();

    expect(checkNowSpy).toHaveBeenCalledTimes(1);
    checker.stop();
  });

  it('start() triggers periodic checks at the 60-minute interval', async () => {
    const checker = new UpdateChecker('/tmp/fake');
    const checkNowSpy = vi.spyOn(checker, 'checkNow').mockResolvedValue({} as any);

    checker.start();
    await Promise.resolve(); // let the immediate call fire

    // Advance 60 minutes
    vi.advanceTimersByTime(60 * 60 * 1000);
    await Promise.resolve();

    expect(checkNowSpy).toHaveBeenCalledTimes(2); // immediate + 1 interval tick

    // Advance another 60 minutes
    vi.advanceTimersByTime(60 * 60 * 1000);
    await Promise.resolve();

    expect(checkNowSpy).toHaveBeenCalledTimes(3);
    checker.stop();
  });

  it('stop() prevents further interval checks', async () => {
    const checker = new UpdateChecker('/tmp/fake');
    const checkNowSpy = vi.spyOn(checker, 'checkNow').mockResolvedValue({} as any);

    checker.start();
    await Promise.resolve();

    checker.stop();

    vi.advanceTimersByTime(60 * 60 * 1000 * 3); // 3 hours — should not trigger
    await Promise.resolve();

    // Only the initial call — no interval calls
    expect(checkNowSpy).toHaveBeenCalledTimes(1);
  });

  it('stop() is idempotent — safe to call multiple times', () => {
    const checker = new UpdateChecker('/tmp/fake');
    vi.spyOn(checker, 'checkNow').mockResolvedValue({} as any);

    checker.start();
    expect(() => {
      checker.stop();
      checker.stop();
      checker.stop();
    }).not.toThrow();
  });

  it('start() with no timer — stop() does nothing when never started', () => {
    const checker = new UpdateChecker('/tmp/fake');
    expect(() => checker.stop()).not.toThrow();
  });
});

describe('UpdateChecker — checkNow() local rev-parse failure', () => {
  it('does not throw when local git rev-parse fails', async () => {
    const checker = new UpdateChecker('/tmp/fake');
    (checker as any).execGit = vi.fn().mockRejectedValue(new Error('not a git repo'));

    // Should resolve cleanly without throwing
    const state = await checker.checkNow();
    // State should be unchanged (defaults)
    expect(state.sha).toBe('unknown');
    expect(state.updateAvailable).toBe(false);
  });
});

describe('UpdateChecker — rev-list directional check', () => {
  it('updateAvailable false when behind count is 0 even if SHAs differ', async () => {
    // This tests the specific logic: the count from HEAD..origin/main matters,
    // not whether the SHAs are different strings.
    const checker = new UpdateChecker('/tmp/fake');
    (checker as any).execGit = vi.fn()
      .mockResolvedValueOnce('aaa1111') // local SHA
      .mockResolvedValueOnce('')        // fetch
      .mockResolvedValueOnce('bbb2222') // remote SHA (different!)
      .mockResolvedValueOnce('0');      // rev-list count: remote has 0 commits ahead

    await checker.checkNow();
    const state = checker.getState();
    expect(state.sha).toBe('aaa1111');
    expect(state.remoteSha).toBe('bbb2222');
    // SHAs differ but remote is NOT ahead — no update
    expect(state.updateAvailable).toBe(false);
  });

  it('updateAvailable true only when rev-list count > 0', async () => {
    const checker = new UpdateChecker('/tmp/fake');
    (checker as any).execGit = vi.fn()
      .mockResolvedValueOnce('aaa1111') // local SHA
      .mockResolvedValueOnce('')        // fetch
      .mockResolvedValueOnce('bbb2222') // remote SHA
      .mockResolvedValueOnce('2');      // 2 commits ahead on remote

    await checker.checkNow();
    expect(checker.getState().updateAvailable).toBe(true);
  });

  it('updateAvailable false when rev-list returns non-numeric string', async () => {
    // parseInt('', 10) → NaN, NaN > 0 is false → safe fallback
    const checker = new UpdateChecker('/tmp/fake');
    (checker as any).execGit = vi.fn()
      .mockResolvedValueOnce('aaa1111')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('bbb2222')
      .mockResolvedValueOnce(''); // empty — parseInt('', 10) = NaN

    await checker.checkNow();
    expect(checker.getState().updateAvailable).toBe(false);
  });
});
