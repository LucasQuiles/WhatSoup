// scripts/png-estate-guard.ts
// #2219 Option A ("keep docs, drop artifacts"): artifacts/ images live outside
// git (external hosting is the owner-gated follow-up); docs/ screenshots stay
// tracked under a shrink-only ratchet so the estate can never regrow silently.
//
// Modes:
//   --staged   pre-commit: reject any staged PNG under artifacts/ (that tree
//              is untracked by policy) and any staged NEW/CHANGED PNG larger
//              than MAX_NEW_PNG_BYTES.
//   (default)  ratchet: the tracked-PNG census may only shrink — count and
//              total bytes are both bounded by the baseline below, and
//              artifacts/ must contain zero tracked PNGs.
//
// Each PR that removes or compresses tracked PNGs LOWERS the baseline in the
// same change (the issue's "each PR lowers the ratchet"). Raising it requires
// its own reviewed change.
//
// Exit codes: 0 = clean; 1 = violation; 2 = guard could not run.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

export const MAX_NEW_PNG_BYTES = 100 * 1024;
// Post-Option-A baseline (docs/design-system 18 + docs/screenshots 15).
export const TRACKED_PNG_COUNT_BASELINE = 33;
export const TRACKED_PNG_BYTES_BASELINE = 13_319_198;

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function fail(lines: string[]): never {
  console.error('png-estate guard failed');
  for (const line of lines) console.error(`  ${line}`);
  process.exit(1);
}

function checkStaged(): void {
  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=AM'])
    .split('\n')
    .filter((p) => p.toLowerCase().endsWith('.png'));
  const violations: string[] = [];
  for (const path of staged) {
    if (path.startsWith('artifacts/')) {
      violations.push(
        `${path}: artifacts/ images are not tracked (issue #2219 Option A) — host externally`,
      );
      continue;
    }
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue; // deleted-after-staging edge; nothing to enforce
    }
    if (size > MAX_NEW_PNG_BYTES) {
      violations.push(
        `${path}: ${size} bytes exceeds the ${MAX_NEW_PNG_BYTES}-byte new-PNG bound — compress (e.g. WebP) or host externally`,
      );
    }
  }
  if (violations.length > 0) fail(violations);
  console.log(`png-estate guard passed (staged): ${staged.length} staged PNG(s) within policy`);
}

function checkRatchet(): void {
  // Scope floor (#2102 idiom): a tree with no tracked files at all is not a
  // clean estate, it is no estate — refuse rather than pass vacuously.
  const trackedAny = git(['ls-files']).split('\n').filter((p) => p.length > 0).length;
  if (trackedAny === 0) {
    console.error('png-estate guard: INCONCLUSIVE — examined 0 tracked files (empty or non-repo scan root)');
    process.exit(2);
  }
  const tracked = git(['ls-files', '*.png', '*.PNG'])
    .split('\n')
    .filter((p) => p.length > 0);
  const inArtifacts = tracked.filter((p) => p.startsWith('artifacts/'));
  let totalBytes = 0;
  for (const path of tracked) {
    try {
      totalBytes += statSync(path).size;
    } catch {
      fail([`tracked PNG unreadable in worktree: ${path}`]);
    }
  }
  const violations: string[] = [];
  if (inArtifacts.length > 0) {
    violations.push(
      `${inArtifacts.length} tracked PNG(s) under artifacts/ — that tree is untracked by policy (#2219 Option A): ${inArtifacts.slice(0, 5).join(', ')}`,
    );
  }
  if (tracked.length > TRACKED_PNG_COUNT_BASELINE) {
    violations.push(
      `tracked PNG count ${tracked.length} exceeds the ratchet baseline ${TRACKED_PNG_COUNT_BASELINE} — the census may only shrink`,
    );
  }
  if (totalBytes > TRACKED_PNG_BYTES_BASELINE) {
    violations.push(
      `tracked PNG bytes ${totalBytes} exceed the ratchet baseline ${TRACKED_PNG_BYTES_BASELINE} — the census may only shrink`,
    );
  }
  if (violations.length > 0) fail(violations);
  console.log(
    `png-estate guard passed (ratchet): ${tracked.length}/${TRACKED_PNG_COUNT_BASELINE} PNG(s), ${totalBytes}/${TRACKED_PNG_BYTES_BASELINE} bytes, artifacts/ clean`,
  );
}

try {
  if (process.argv.includes('--staged')) checkStaged();
  else checkRatchet();
} catch (err) {
  console.error(`png-estate guard: INCONCLUSIVE — could not run: ${String(err)}`);
  process.exit(2);
}
