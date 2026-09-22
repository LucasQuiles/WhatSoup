// scripts/png-estate-guard.ts
// #2219 Option A ("keep docs, drop artifacts"): artifacts/ images live outside
// git (external hosting is the owner-gated follow-up); docs/ PNGs stay tracked
// under a shrink-only ratchet so the estate can never regrow silently.
//
// The docs/screenshots/ PNGs were then compressed in place, losslessly (owner
// decision "Compress in place": no history rewrite). Every tracked PNG path is
// pinned to its committed size in TRACKED_PNG_SIZE_BASELINE, so no existing
// PNG can grow and any PNG path outside the baseline is held to the new-PNG
// bound — in CI, not only at pre-commit.
//
// Modes:
//   --staged   pre-commit: reject any staged PNG under artifacts/ (that tree
//              is untracked by policy); reject any staged in-place change
//              (status M) of a tracked docs/screenshots/ PNG whose INDEX blob
//              is larger than its HEAD blob (a tracked screenshot may not
//              grow); reject every other staged new/changed/renamed PNG whose
//              INDEX blob is larger than MAX_NEW_PNG_BYTES.
//   (default)  ratchet (CI): artifacts/ must contain zero tracked PNGs; each
//              tracked PNG listed in TRACKED_PNG_SIZE_BASELINE is at most its
//              baselined size; each tracked PNG not listed is at most
//              MAX_NEW_PNG_BYTES; count and total bytes are bounded by the
//              baselines below.
//
// Measurement rules (review-hardened):
//   - all listings are NUL-separated with no pathspec, so quoted/unicode names
//     and mixed-case extensions (.Png) are matched on exact bytes, case-folded;
//   - sizes come from index blobs (`cat-file -s`), never the worktree, so
//     post-staging edits cannot change the verdict and symlinks (whose blob is
//     the target path text) are excluded by mode, as in check-zero-byte-tracked;
//   - the staged change set comes from plumbing (`diff-index --cached --raw`)
//     with rename detection requested explicitly, not from user diff config.
//
// Each PR that removes or compresses tracked PNGs LOWERS the baselines in the
// same change (the issue's "each PR lowers the ratchet"); the companion test
// pins the live census to these constants exactly, so a stale or typo'd
// baseline is red, not silent headroom. Raising one requires its own reviewed
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
// blob exceeds MAX_NEW_PNG_BYTES and the estate cannot carry them. Lowered
// again from 10_238_137 when the 15 docs/screenshots PNGs were compressed
// losslessly in place (6_864_376 -> 5_429_825 bytes, pixels unchanged).
export const TRACKED_PNG_COUNT_BASELINE = 25;
export const TRACKED_PNG_BYTES_BASELINE = 8_803_586;

// Committed blob size of every tracked PNG. The sum equals
// TRACKED_PNG_BYTES_BASELINE. The pre-compression docs/screenshots originals
// were 64_519-755_125 bytes, each larger than its entry here.
export const TRACKED_PNG_SIZE_BASELINE: Readonly<Record<string, number>> = {
  'docs/design-system/v35/qa/evidence/deployments-dark.png': 344_580,
  'docs/design-system/v35/qa/evidence/deployments-light.png': 345_487,
  'docs/design-system/v35/qa/evidence/dream-lab-dark.png': 446_039,
  'docs/design-system/v35/qa/evidence/dream-lab-light.png': 445_820,
  'docs/design-system/v35/qa/evidence/settings-dark.png': 302_402,
  'docs/design-system/v35/qa/evidence/settings-light.png': 302_573,
  'docs/design-system/v35/qa/evidence/skills-hub-dark.png': 423_079,
  'docs/design-system/v35/qa/evidence/skills-hub-light.png': 425_046,
  'docs/design-system/v35/qa/evidence/splash-dark.png': 170_228,
  'docs/design-system/v35/qa/evidence/splash-light.png': 168_507,
  'docs/screenshots/add-line-wizard.png': 622_509,
  'docs/screenshots/fleet-overview.png': 116_918,
  'docs/screenshots/inbox-agent.png': 563_450,
  'docs/screenshots/inbox-chatbot.png': 562_516,
  'docs/screenshots/inbox-line-picker.png': 504_592,
  'docs/screenshots/inbox.png': 57_882,
  'docs/screenshots/line-detail-access.png': 446_854,
  'docs/screenshots/line-detail-chat.png': 437_688,
  'docs/screenshots/line-detail-logs.png': 511_940,
  'docs/screenshots/line-detail-metrics.png': 51_072,
  'docs/screenshots/line-detail-mode.png': 386_385,
  'docs/screenshots/line-detail-pipeline.png': 388_870,
  'docs/screenshots/line-detail.png': 47_233,
  'docs/screenshots/ops-unhealthy.png': 595_136,
  'docs/screenshots/ops.png': 136_780,
};

export const DOCS_SCREENSHOT_PREFIX = 'docs/screenshots/';

const SYMLINK_MODE = '120000';

function isPng(path: string): boolean {
  return path.toLowerCase().endsWith('.png');
}

function nulList(raw: string): string[] {
  return raw.split('\0').filter((entry) => entry.length > 0);
}

function hasHead(cwd: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd);
    return true;
  } catch {
    return false;
  }
}

interface StagedPng {
  path: string;
  // HEAD-side blob for an in-place modification (status M); undefined otherwise.
  headOid: string | undefined;
}

function stagedPngs(cwd: string): StagedPng[] {
  if (!hasHead(cwd)) {
    // Unborn HEAD: every index entry is an addition.
    return nulList(git(['ls-files', '-z'], cwd))
      .filter(isPng)
      .map((path) => ({ path, headOid: undefined }));
  }
  // ":<m> <m> <oid> <oid> <status>\0<path>\0", plus a destination path for R/C.
  const tokens = nulList(
    git(['diff-index', '--cached', '--raw', '-z', '--no-abbrev', '-M', '--diff-filter=ACMR', 'HEAD'], cwd),
  );
  const out: StagedPng[] = [];
  let i = 0;
  while (i < tokens.length) {
    const meta = tokens[i]!;
    const fields = meta.slice(1).split(' ');
    const status = fields[4];
    if (!meta.startsWith(':') || fields.length !== 5 || status === undefined) {
      throw new Error(`malformed diff-index --raw row: ${JSON.stringify(meta)}`);
    }
    const pathCount = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
    const path = tokens[i + pathCount];
    if (path === undefined) throw new Error(`truncated diff-index --raw row: ${JSON.stringify(meta)}`);
    i += pathCount + 1;
    if (!isPng(path)) continue;
    out.push({ path, headOid: status === 'M' ? fields[2] : undefined });
  }
  return out;
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
  const staged = stagedPngs(cwd);
  const violations: string[] = [];
  for (const { path, headOid } of staged) {
    if (path.startsWith('artifacts/')) {
      violations.push(
        `${path}: artifacts/ images are not tracked (issue #2219 Option A) — host externally`,
      );
      continue;
    }
    const size = blobSize(cwd, `:0:${path}`);
    if (path.startsWith(DOCS_SCREENSHOT_PREFIX) && headOid !== undefined) {
      const headSize = blobSize(cwd, headOid);
      if (size > headSize) {
        violations.push(
          `${path}: ${size} staged bytes grows the tracked screenshot (HEAD ${headSize} bytes) — a tracked screenshot may not grow`,
        );
      }
      continue;
    }
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
  const grown: string[] = [];
  const oversizedNew: string[] = [];
  for (const png of pngs) {
    const size = blobSize(cwd, png.oid);
    totalBytes += size;
    const baseline = Object.hasOwn(TRACKED_PNG_SIZE_BASELINE, png.path)
      ? TRACKED_PNG_SIZE_BASELINE[png.path]!
      : undefined;
    if (baseline !== undefined) {
      if (size > baseline) grown.push(`${png.path} (${size} > ${baseline} bytes)`);
    } else if (size > MAX_NEW_PNG_BYTES) {
      oversizedNew.push(`${png.path} (${size} bytes)`);
    }
  }
  const violations: string[] = [];
  if (grown.length > 0) {
    violations.push(
      `${grown.length} tracked PNG(s) exceed their per-path size baseline — a tracked PNG may not grow: ${grown.join(', ')}`,
    );
  }
  if (oversizedNew.length > 0) {
    violations.push(
      `${oversizedNew.length} tracked PNG(s) outside the per-path baseline exceed the ${MAX_NEW_PNG_BYTES}-byte new-PNG bound: ${oversizedNew.join(', ')}`,
    );
  }
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
    `png-estate guard passed (ratchet): ${pngs.length}/${TRACKED_PNG_COUNT_BASELINE} PNG(s), ${totalBytes}/${TRACKED_PNG_BYTES_BASELINE} bytes, artifacts/ clean, every PNG within its per-path or new-PNG bound`,
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
