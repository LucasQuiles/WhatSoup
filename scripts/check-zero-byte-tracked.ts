/**
 * check-zero-byte-tracked.ts — block tracked files that carry no bytes.
 *
 * Motivation (2026-07-31): a docs consolidation truncated
 * CLUSTER-alert-recovery-lifecycle.md from 99 bytes to 0 and the empty file
 * landed on main. Nothing caught it. The landing's own byte-verify passed
 * because it compares landed bytes against the anchored head — it proves
 * fidelity of transfer, not integrity of source, so a head that had already
 * lost the content verifies clean against itself.
 *
 * A tracked file at 0 bytes is either lost content or a placeholder. Only
 * placeholders whose whole purpose is to be empty are allowed, and they are
 * allowed by exact basename, never by directory or extension — a broad rule
 * would re-admit the very case this guard exists to catch (an emptied .md).
 *
 * Sizes come from the working tree, matching what a commit would record.
 * Symlinks are skipped: lstat on a symlink reports the length of its target
 * path, not the file, so a link is never meaningfully "zero-byte", and a
 * dangling link is a different defect with a different guard.
 */
import { lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ZeroByteFinding {
  file: string;
}

/**
 * Basenames whose entire function is to exist while empty. Exact matches only.
 * - .gitkeep/.keep/.placeholder: retain an otherwise-empty directory in git.
 * - __init__.py: marks a Python package; empty is the idiomatic form.
 * - py.typed: PEP 561 marker; the spec defines it as an empty file.
 * .gitignore is deliberately absent — an emptied .gitignore is a real defect.
 */
const ALLOWED_EMPTY_BASENAMES = new Set([
  '.gitkeep',
  '.keep',
  '.placeholder',
  '__init__.py',
  'py.typed',
]);

export interface ZeroByteScan {
  findings: ZeroByteFinding[];
  filesExamined: number;
}

function trackedFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter((p) => p.length > 0);
}

export function scanForZeroByteTrackedCounted(root: string): ZeroByteScan {
  const findings: ZeroByteFinding[] = [];
  let filesExamined = 0;

  for (const rel of trackedFiles(root)) {
    let st;
    try {
      st = lstatSync(path.join(root, rel));
    } catch {
      // Tracked but absent from the working tree (sparse checkout, deleted but
      // not staged). Not this guard's concern and not counted as examined.
      continue;
    }
    if (!st.isFile()) continue; // symlinks, gitlinks/submodules
    filesExamined += 1;
    if (st.size !== 0) continue;
    if (ALLOWED_EMPTY_BASENAMES.has(path.basename(rel))) continue;
    findings.push({ file: rel });
  }

  return { findings, filesExamined };
}

/** Findings only — pure, and legitimately allowed to return []. Unit tests use this. */
export function scanForZeroByteTracked(root: string): ZeroByteFinding[] {
  return scanForZeroByteTrackedCounted(root).findings;
}

function main(): number {
  const root = process.argv[2] ?? process.cwd();
  let scan: ZeroByteScan;
  try {
    scan = scanForZeroByteTrackedCounted(root);
  } catch (err) {
    console.error(`[zero-byte-tracked] FATAL ${(err as Error).message}`); // fail-closed
    return 2;
  }
  const { findings, filesExamined } = scan;

  // Refuse to certify a tree that was never read. "0 findings" from a scan that
  // examined 0 files is indistinguishable from a clean tree by exit code alone,
  // and this guard is meant to block — so an empty enumeration must not read as
  // green. Mirrors the same refusal in check-insecure-tempfile.ts.
  if (filesExamined === 0) {
    console.error(
      `[zero-byte-tracked] INCONCLUSIVE — examined 0 tracked files under ${root}; ` +
        'refusing to report "clean" for a tree that was never read',
    );
    return 2;
  }

  if (findings.length === 0) {
    console.log(`[zero-byte-tracked] clean (0 findings across ${filesExamined} tracked file(s))`);
    return 0;
  }
  for (const f of findings) console.error(`  zero-byte  ${f.file}`);
  console.error(
    `[zero-byte-tracked] ${findings.length} tracked file(s) with no content — BLOCK. ` +
      'Restore the content or delete the file; add a basename to ALLOWED_EMPTY_BASENAMES ' +
      'only if being empty is the file\'s entire purpose.',
  );
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]!).href) {
  process.exit(main());
}
