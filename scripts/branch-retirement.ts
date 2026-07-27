import { pathToFileURL } from 'node:url';

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

/**
 * CLI entrypoint for `npm run guard:branch-retirement`. This module only
 * exports a pure predicate — there is no live collector wired yet to
 * populate `BranchRecord` from git/`gh`, so running it directly cannot
 * positively evaluate anything. Per this repo's fail-closed convention, a
 * check that cannot positively evaluate its condition must refuse, never
 * pass; a live collector is deliberately deferred to a follow-up task.
 */
function main(): number {
  console.error('branch-retirement: no live collector wired; predicate only. Refusing.');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
