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

  it('getState() returns cached state after check', async () => {
    const checker = new UpdateChecker('/tmp/fake-repo');
    (checker as any).execGit = vi.fn()
      .mockResolvedValueOnce('abc1234')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('def5678');
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
      .mockResolvedValueOnce('abc1234')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('abc1234');
    await checker.checkNow();
    expect(checker.getState().updateAvailable).toBe(false);
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
