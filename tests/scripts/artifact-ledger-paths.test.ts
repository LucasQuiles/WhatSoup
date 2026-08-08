// ---------------------------------------------------------------------------
// #2552: discriminating test — stale April artifact ledgers must not return to
// their fixed global paths.
//
// The four top-level artifacts/ ledgers were byte-frozen at April 2026 PR 0a
// commits (error_catalog.md / error_model.md / readiness.json at 082c83a2 and
// e80787da, all 2026-04-25) while claiming a current readiness verdict with no
// current provenance. They were relocated under docs/artifacts/pr-0a-2026-04-25/
// so the collision-prone fixed global paths no longer exist.
//
// DISCRIMINATOR: if any of the four fixed paths regresses (a tracked file
// re-created at the top-level location), the first test FAILS. If the archive
// is wiped without the move being preserved, the second test FAILS — proving
// the car moved (not deleted) the receipts into a namespaced subdir.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function gitLsFiles(pattern: string): string[] {
  return execFileSync('git', ['ls-files', '--', pattern], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: cleanGitEnv(),
  })
    .split('\n')
    .filter(Boolean);
}

// The four collision-prone fixed global paths from issue #2552. A tracked file
// at any of these is a regression: the readiness verdict they carry has no
// current provenance and independent runs could overwrite one another.
const STALE_FIXED_PATHS = [
  'artifacts/error_catalog.md',
  'artifacts/error_model.md',
  'artifacts/readiness.json',
  'artifacts/documentation_devops_readiness.md',
] as const;

const ARCHIVE_DIR = 'docs/artifacts/pr-0a-2026-04-25/';

describe('#2552 stale April artifact ledger paths', () => {
  it('has no tracked file at the four stale fixed global artifact paths', () => {
    const present = STALE_FIXED_PATHS.filter((p) => gitLsFiles(p).includes(p));
    expect(present).toEqual([]);
  });

  it('DISCRIMINATOR: the April PR 0a ledgers are archived (moved, not deleted) under the namespaced dated subdir', () => {
    const archived = gitLsFiles(ARCHIVE_DIR);
    for (const fixed of STALE_FIXED_PATHS) {
      const basename = fixed.split('/').pop()!;
      expect(archived).toContain(`${ARCHIVE_DIR}${basename}`);
    }
  });
});
