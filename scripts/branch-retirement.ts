export interface BranchRecord {
  name: string;
  sha: string;
  upstream: string | null;
  ahead: number;
  prState: 'MERGED' | 'CLOSED' | 'OPEN' | null;
  hasWorktree: boolean;
  /** Every file on the branch is byte-identical on main. Ancestry does NOT satisfy this. */
  blobProven: boolean;
}

export interface RetirementDecision {
  name: string;
  retire: boolean;
  reasons: string[];
}

export function retirementCandidates(
  branches: BranchRecord[],
  _mainSha: string,
): RetirementDecision[] {
  return branches.map((b) => {
    const reasons: string[] = [];
    if (b.prState !== 'MERGED') reasons.push('pr-not-merged');
    if (!b.blobProven) reasons.push('no-blob-proof');
    if (b.hasWorktree) reasons.push('has-worktree');
    if (b.ahead > 0) reasons.push('ahead-of-upstream');
    return { name: b.name, retire: reasons.length === 0, reasons };
  });
}
