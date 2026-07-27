import { describe, expect, it } from 'vitest';
import { retirementCandidates, type BranchRecord } from '../../scripts/branch-retirement.ts';

const base: BranchRecord = {
  name: 'fix/example', sha: 'a'.repeat(40), upstream: 'origin/fix/example',
  ahead: 0, prState: 'MERGED', hasWorktree: false, blobProven: true,
};

describe('retirementCandidates', () => {
  it('retires a merged, blob-proven, worktree-free branch that is not ahead', () => {
    const [d] = retirementCandidates([base], 'm'.repeat(40));
    expect(d.retire).toBe(true);
    expect(d.reasons).toEqual([]);
  });

  it('refuses a branch that still has a worktree', () => {
    const [d] = retirementCandidates([{ ...base, hasWorktree: true }], 'm'.repeat(40));
    expect(d.retire).toBe(false);
    expect(d.reasons).toContain('has-worktree');
  });

  it('refuses a branch ahead of its upstream', () => {
    const [d] = retirementCandidates([{ ...base, ahead: 3 }], 'm'.repeat(40));
    expect(d.retire).toBe(false);
    expect(d.reasons).toContain('ahead-of-upstream');
  });

  it('refuses when blob proof is absent, even if the PR says MERGED', () => {
    const [d] = retirementCandidates([{ ...base, blobProven: false }], 'm'.repeat(40));
    expect(d.retire).toBe(false);
    expect(d.reasons).toContain('no-blob-proof');
  });

  it('refuses an OPEN PR', () => {
    const [d] = retirementCandidates([{ ...base, prState: 'OPEN' }], 'm'.repeat(40));
    expect(d.retire).toBe(false);
    expect(d.reasons).toContain('pr-not-merged');
  });

  it('refuses a branch with no PR at all', () => {
    const [d] = retirementCandidates([{ ...base, prState: null }], 'm'.repeat(40));
    expect(d.retire).toBe(false);
    expect(d.reasons).toContain('pr-not-merged');
  });
});
