// scripts/png-estate-guard.ts
// #2219 Option A ("keep docs, drop artifacts"): artifacts/ images live outside
// git (external hosting is the owner-gated follow-up); docs/ screenshots stay
// tracked under a shrink-only ratchet so the estate can never regrow silently.
//
// Modes:
//   --staged   pre-commit: reject any staged PNG under artifacts/ (that tree
//              is untracked by policy) and any staged NEW/CHANGED/RENAMED PNG
//              whose INDEX blob is larger than MAX_NEW_PNG_BYTES.
//   (default)  ratchet: the tracked-PNG census may only shrink — count and
//              total bytes are both bounded by the baseline below, and
//              artifacts/ must contain zero tracked PNGs.
//
// Measurement rules (review-hardened):
//   - all listings are NUL-separated with no pathspec, so quoted/unicode names
//     and mixed-case extensions (.Png) are matched on exact bytes, case-folded;
//   - sizes come from index blobs (`cat-file -s`), never the worktree, so
//     post-staging edits cannot change the verdict and symlinks (whose blob is
//     the target path text) are excluded by mode, as in check-zero-byte-tracked.
//
// Each PR that removes or compresses tracked PNGs LOWERS the baseline in the
// same change (the issue's "each PR lowers the ratchet"); the companion test
// pins the live census to these constants exactly, so a stale or typo'd
// baseline is red, not silent headroom. Raising it requires its own reviewed
// change.
//
// Exit codes: 0 = clean; 1 = violation; 2 = guard could not run.
import { pathToFileURL } from 'node:url';

import { git } from './lib/guard-core.ts';

export const MAX_NEW_PNG_BYTES = 100 * 1024;
// Post-Option-A baseline (docs/design-system 10 + docs/screenshots 15). Lowered
// from 33 / 13_319_198 when the eight QA evidence screenshots that rendered a
// pre-scrub operator identifier were removed rather than re-shot: a fresh
// 1440x900 @2x render of those surfaces is 119-476 KiB, so every replacement
// blob exceeds MAX_NEW_PNG_BYTES and the estate cannot carry them.
export const TRACKED_PNG_COUNT_BASELINE = 25;
export const TRACKED_PNG_BYTES_BASELINE = 10_238_137;

const SYMLINK_MODE = '120000';

function isPng(path: string): boolean {
  return path.toLowerCase().endsWith('.png');
}

function nulList(raw: string): string[] {
  return raw.split('\0').filter((entry) => entry.length > 0);
}

function blobSize(cwd: string, spec: string): number {
  const out = git(['cat-file', '-s', spec], cwd).trim();
  const size = Number.parseInt(out, 10);
  if (!Number.isInteger(size) || size < 0) {
    throw new Error(`malformed object size for ${spec}: ${out}`);
  }
  return size;
}

function fail(lines: string[]): never {
  console.error('png-estate guard failed');
  for (const line of lines) console.error(`  ${line}`);
  process.exit(1);
}

export function checkStaged(cwd = process.cwd()): void {
  const staged = nulList(
    git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], cwd),
  ).filter(isPng);
  const violations: string[] = [];
  for (const path of staged) {
    if (path.startsWith('artifacts/')) {
      violations.push(
        `${path}: artifacts/ images are not tracked (issue #2219 Option A) — host externally`,
      );
      continue;
    }
    const size = blobSize(cwd, `:0:${path}`);
    if (size > MAX_NEW_PNG_BYTES) {
      violations.push(
        `${path}: ${size} staged bytes exceeds the ${MAX_NEW_PNG_BYTES}-byte new-PNG bound — compress (e.g. WebP) or host externally`,
      );
    }
  }
  if (violations.length > 0) fail(violations);
  console.log(`png-estate guard passed (staged): ${staged.length} staged PNG(s) within policy`);
}

interface TrackedPng {
  path: string;
  oid: string;
}

function trackedPngCensus(cwd: string): { totalTracked: number; pngs: TrackedPng[] } {
  // `ls-files -sz`: "<mode> <oid> <stage>\t<path>" NUL-terminated.
  const rows = nulList(git(['ls-files', '-sz'], cwd));
  const pngs: TrackedPng[] = [];
  for (const row of rows) {
    const tab = row.indexOf('\t');
    if (tab < 0) throw new Error(`malformed ls-files row: ${JSON.stringify(row)}`);
    const [mode, oid] = row.slice(0, tab).split(' ');
    const path = row.slice(tab + 1);
    if (mode === SYMLINK_MODE || oid === undefined) continue;
    if (!isPng(path)) continue;
    pngs.push({ path, oid });
  }
  return { totalTracked: rows.length, pngs };
}

export function checkRatchet(cwd = process.cwd()): void {
  // Scope floor (#2102 idiom): a tree with no tracked files at all is not a
  // clean estate, it is no estate — refuse rather than pass vacuously.
  const { totalTracked, pngs } = trackedPngCensus(cwd);
  if (totalTracked === 0) {
    console.error('png-estate guard: INCONCLUSIVE — examined 0 tracked files (empty or non-repo scan root)');
    process.exit(2);
  }
  const inArtifacts = pngs.filter((png) => png.path.startsWith('artifacts/'));
  let totalBytes = 0;
  for (const png of pngs) totalBytes += blobSize(cwd, png.oid);
  const violations: string[] = [];
  if (inArtifacts.length > 0) {
    violations.push(
      `${inArtifacts.length} tracked PNG(s) under artifacts/ — that tree is untracked by policy (#2219 Option A): ${inArtifacts.slice(0, 5).map((png) => png.path).join(', ')}`,
    );
  }
  if (pngs.length > TRACKED_PNG_COUNT_BASELINE) {
    violations.push(
      `tracked PNG count ${pngs.length} exceeds the ratchet baseline ${TRACKED_PNG_COUNT_BASELINE} — the census may only shrink`,
    );
  }
  if (totalBytes > TRACKED_PNG_BYTES_BASELINE) {
    violations.push(
      `tracked PNG bytes ${totalBytes} exceed the ratchet baseline ${TRACKED_PNG_BYTES_BASELINE} — the census may only shrink`,
    );
  }
  if (violations.length > 0) fail(violations);
  console.log(
    `png-estate guard passed (ratchet): ${pngs.length}/${TRACKED_PNG_COUNT_BASELINE} PNG(s), ${totalBytes}/${TRACKED_PNG_BYTES_BASELINE} bytes, artifacts/ clean`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes('--staged')) checkStaged();
    else checkRatchet();
  } catch (err) {
    console.error(`png-estate guard: INCONCLUSIVE — could not run: ${String(err)}`);
    process.exit(2);
  }
}
