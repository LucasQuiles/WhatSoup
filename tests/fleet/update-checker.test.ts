// tests/fleet/update-checker.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UpdateChecker } from '../../src/fleet/update-checker.ts';

describe('UpdateChecker', () => {
  it('getState() returns initial state before first check', () => {
    const checker = new UpdateChecker('/tmp/fake-repo');
    const state = checker.getState();
    expect(state.sha).toBe('unknown');
    expect(state.remoteSha).toBe('unknown');
    expect(state.updateAvailable).toBe(false);
    expect(state.checkedAt).toBe('');
  });

  it('getState() returns cached state after check — remote ahead', async () => {
    const checker = new UpdateChecker('/tmp/fake-repo');
    (checker as any).execGit = vi.fn()
      .mockResolvedValueOnce('abc1234')   // rev-parse HEAD
      .mockResolvedValueOnce('')          // git fetch
      .mockResolvedValueOnce('def5678')   // rev-parse origin/main
      .mockResolvedValueOnce('3');        // rev-list --count HEAD..origin/main
    await checker.checkNow();
    const state = checker.getState();
    expect(state.sha).toBe('abc1234');
    expect(state.remoteSha).toBe('def5678');
    expect(state.updateAvailable).toBe(true);
    expect(state.checkedAt).toBeTruthy();
  });

  it('updateAvailable is false when SHAs match', async () => {
    const checker = new UpdateChecker('/tmp/fake-repo');
    (checker as any).execGit = vi.fn()
      .mockResolvedValueOnce('abc1234')   // rev-parse HEAD
      .mockResolvedValueOnce('')          // git fetch
      .mockResolvedValueOnce('abc1234')   // rev-parse origin/main
      .mockResolvedValueOnce('0');        // rev-list --count (same SHA = 0)
    await checker.checkNow();
    expect(checker.getState().updateAvailable).toBe(false);
  });

  it('updateAvailable is false when local is ahead of remote', async () => {
    const checker = new UpdateChecker('/tmp/fake-repo');
    (checker as any).execGit = vi.fn()
      .mockResolvedValueOnce('def5678')   // rev-parse HEAD (local is newer)
      .mockResolvedValueOnce('')          // git fetch
      .mockResolvedValueOnce('abc1234')   // rev-parse origin/main (older)
      .mockResolvedValueOnce('0');        // rev-list --count HEAD..origin/main = 0 (remote has nothing new)
    await checker.checkNow();
    const state = checker.getState();
    expect(state.sha).toBe('def5678');
    expect(state.remoteSha).toBe('abc1234');
    expect(state.updateAvailable).toBe(false);
  });

  it('checkNow() handles git fetch failure gracefully', async () => {
    const checker = new UpdateChecker('/tmp/fake-repo');
    (checker as any).execGit = vi.fn()
      .mockResolvedValueOnce('abc1234')
      .mockRejectedValueOnce(new Error('no internet'));
    await checker.checkNow();
    const state = checker.getState();
    expect(state.sha).toBe('abc1234');
    expect(state.remoteSha).toBe('unknown');
    expect(state.updateAvailable).toBe(false);
  });
});
