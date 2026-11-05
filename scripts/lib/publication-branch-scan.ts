import { createVerifiedBinaryCheck, DISCLOSURE_PATCH_FLAGS, git, isTextCandidate, normalizeRepoPath } from './guard-core.ts';
import { MAX_EXACT_AGGREGATE_BLOB_BYTES, MAX_EXACT_BLOB_COUNT, MAX_EXACT_COMMIT_COUNT } from './ci-control/git-input.ts';
import { isFixtureFile } from './repo-hygiene-policy.ts';
import { baseRefFileLines, iterateUnifiedDiffAddedLines } from '../repo-hygiene-guard.ts';

/**
 * The publication scans read every path except a verified binary, with one exception:
 * in the fixture areas repo hygiene exempts (isFixtureFile), whose corpora are secret-
 * and path-shaped by design, they keep their earlier file selection (isTextCandidate).
 * So a fixture area keeps exactly the publication coverage it had, and is never widened.
 */
export function isPublicationFixtureExempt(filePath: string): boolean {
  return isFixtureFile(filePath) && !isTextCandidate(filePath);
}

export interface BranchScanLimits {
  commits: number;
  patchBytes: number;
  addedLines: number;
  baseBlobs: number;
  baseBytes: number;
  milliseconds: number;
}

/**
 * Limits on the branch scan's reads. Commit, base-blob and base-byte limits are the
 * shared exact-input constants (git-input-core.ts). The patch and added-line limits
 * are not: the exact-range patch limits (16 MiB, 100,000 lines) would refuse real PRs.
 * Over the last 200 PR ranges merged to main (measured 2026-11-03), the largest was
 * 353,042 added lines in 18.8 MB of patches (PR #3224), scanned in under 1 s. The
 * patch limit is the git() output ceiling, so a larger patch fails its read first;
 * the added-line limit leaves about five times that PR's count. The time limit
 * covers the whole scan, git reads included, at about sixty times that PR's time.
 */
export const BRANCH_SCAN_LIMITS: Readonly<BranchScanLimits> = Object.freeze({
  commits: MAX_EXACT_COMMIT_COUNT,
  patchBytes: 64 * 1024 * 1024,
  addedLines: 2_000_000,
  baseBlobs: MAX_EXACT_BLOB_COUNT,
  baseBytes: MAX_EXACT_AGGREGATE_BLOB_BYTES,
  milliseconds: 60_000,
});

/** The first measure past its limit, or null when every measure is within its limit. */
export function branchScanOverLimit(
  used: Readonly<BranchScanLimits>,
  limits: Readonly<BranchScanLimits> = BRANCH_SCAN_LIMITS,
): keyof BranchScanLimits | null {
  for (const key of Object.keys(limits) as (keyof BranchScanLimits)[]) {
    if (used[key] > limits[key]) return key;
  }
  return null;
}

/** `used` is what the scan had read when it returned; a stop reads nothing after it. */
export type BranchDiffResult<Issue> =
  | { issues: Issue[]; used: BranchScanLimits }
  | { inconclusive: string; used: BranchScanLimits };

function baseBlobByteCount(cwd: string, baseRef: string, filePath: string, timeout: number): number {
  try {
    return Number(git(['cat-file', '-s', `${baseRef}:${filePath}`], cwd, timeout).trim());
  } catch {
    return 0; // absent at the base: nothing to read
  }
}

/**
 * The private-literal scan over what a branch adds relative to its base, for the
 * push hook: at push time the index is clean, so the staged scan sees nothing.
 * A push discloses every commit, so this reads each commit's patch, merges
 * included and diffed against each parent. Every line the branch's final diff
 * adds is added by one of those patches, so no separate final diff is read.
 * Every path is scanned except a verified binary (createVerifiedBinaryCheck,
 * the test the repo-hygiene scans use) and isPublicationFixtureExempt's fixture
 * files. DISCLOSURE_PATCH_FLAGS keep a file Git
 * takes as binary in the patch as text, give each file's new blob id for that
 * test, and pin the output against user config, as do the flags beside them:
 * `log.diffMerges` can turn merges into a combined diff, and `diff.noprefix` or
 * `diff.dstPrefix` moves the path. Diffing a merge against a parent re-exposes
 * the other side's lines, so a matching line byte-identical to a line of the
 * same file on the base is skipped, the rule the repo-hygiene branch scan uses:
 * such content is already published. Only matching lines need that base read.
 * Every measure, elapsed time included, is checked against the limits after each
 * read and each added line; a stop or a failed read is INCONCLUSIVE, never a
 * pass. A git read may use only the time left. `head` defaults to HEAD;
 * naming a commit scans a range without checking it out. `now` is the clock, in
 * milliseconds.
 */
export function scanBranchRange<Issue extends { line?: number }>(
  cwd: string,
  baseRef: string,
  scanLine: (filePath: string, text: string) => Issue[],
  limits: Readonly<BranchScanLimits> = BRANCH_SCAN_LIMITS,
  head = 'HEAD',
  now: () => number = Date.now,
): BranchDiffResult<Issue> {
  const started = now();
  const used: BranchScanLimits = { commits: 0, patchBytes: 0, addedLines: 0, baseBlobs: 0, baseBytes: 0, milliseconds: 0 };
  const overLimit = (): BranchDiffResult<Issue> | null => {
    used.milliseconds = now() - started;
    const key = branchScanOverLimit(used, limits);
    return key === null
      ? null
      : { inconclusive: `${key} ${used[key]} is over the limit of ${limits[key]}`, used: { ...used } };
  };
  // A read that outlives the time left fails, and a failed read is INCONCLUSIVE.
  const timeLeft = () => Math.max(1, limits.milliseconds - (now() - started));
  try {
    const mergeBase = git(['merge-base', baseRef, head], cwd, timeLeft()).trim();
    const range = `${mergeBase}..${head}`;
    used.commits = Number(git(['rev-list', '--count', range], cwd, timeLeft()).trim());
    const commitStop = overLimit();
    if (commitStop) return commitStop;
    const patches = git([
      'log', '--format=', '--diff-merges=separate', '--unified=0', ...DISCLOSURE_PATCH_FLAGS,
      '--dst-prefix=b/', range,
    ], cwd, timeLeft());
    used.patchBytes = Buffer.byteLength(patches, 'utf8');
    const patchStop = overLimit();
    if (patchStop) return patchStop;

    const isVerifiedBinary = createVerifiedBinaryCheck(cwd, timeLeft);
    const matches = new Map<string, { filePath: string; line: number; text: string; found: Issue[] }>();
    for (const added of iterateUnifiedDiffAddedLines(patches)) {
      used.addedLines += 1;
      const lineStop = overLimit();
      if (lineStop) return lineStop;
      const filePath = normalizeRepoPath(added.filePath);
      if (isPublicationFixtureExempt(filePath) || isVerifiedBinary(filePath, added.blob)) continue;
      const key = `${filePath}\0${added.text}`;
      if (matches.has(key)) continue;
      const found = scanLine(filePath, added.text);
      if (found.length > 0) matches.set(key, { filePath, line: added.line, text: added.text, found });
    }
    // A blob read on the last line can use the time left, so check once more.
    const loopStop = overLimit();
    if (loopStop) return loopStop;

    const baseLines = new Map<string, Set<string>>();
    const issues: Issue[] = [];
    for (const match of matches.values()) {
      if (!baseLines.has(match.filePath)) {
        used.baseBlobs += 1;
        used.baseBytes += baseBlobByteCount(cwd, baseRef, match.filePath, timeLeft());
        const baseStop = overLimit();
        if (baseStop) return baseStop;
      }
      if (baseRefFileLines(cwd, baseRef, match.filePath, baseLines, timeLeft()).has(match.text)) continue;
      issues.push(...match.found.map((issue) => ({ ...issue, line: match.line })));
    }
    return { issues, used };
  } catch (error) {
    used.milliseconds = now() - started;
    return { inconclusive: `a git read failed: ${String((error as Error).message).split('\n')[0]}`, used: { ...used } };
  }
}
