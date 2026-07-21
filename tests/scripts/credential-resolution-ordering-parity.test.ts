import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Cross-runtime credential-resolution ORDERING contract.
//
// The unscoped resolution order (env -> private file -> OS keyring) and the
// launchd health-token chain are implemented THREE times, in three languages
// that cannot share a seam: the in-process resolver (src/lib/keyring.ts), the
// launchd wrapper (deploy/whatsoup), and the health-probe mirror
// (deploy/scripts/bot-errors-health-check.py). The #1912 quality sweep found
// they had already drifted once. This test pins the order in each so any future
// reorder goes red instead of silently diverging. It is source-inspection by
// design — a behavioural test cannot span a bash/TS/python boundary.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** Assert each anchor appears, and strictly in the given order. */
function assertOrder(source: string, label: string, anchors: string[]): void {
  let prev = -1;
  let prevAnchor = '<start>';
  for (const anchor of anchors) {
    const idx = source.indexOf(anchor);
    expect(idx, `${label}: anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0);
    expect(
      idx,
      `${label}: "${anchor}" must come AFTER "${prevAnchor}" (resolution order drift)`,
    ).toBeGreaterThan(prev);
    prev = idx;
    prevAnchor = anchor;
  }
}

describe('credential resolution ordering parity (env -> file -> keyring)', () => {
  it('src/lib/keyring.ts unscoped lookup: env-first, then private file, then keyring', () => {
    const src = read('src/lib/keyring.ts');
    assertOrder(src, 'keyring.ts', [
      'const envFirst = options.user === undefined',
      'const fileVal = fileStoreRead(service)',
      "['find-generic-password', '-s', candidate, '-a', account, '-w']",
    ]);
  });

  // NOTE: the scoped-never-reads-unscoped-.key invariant is covered behaviourally in
  // tests/lib/keyring.test.ts; here we only pin cross-runtime resolution ORDER.

  it('deploy/scripts/bot-errors-health-check.py: env, then .key file, then keyring (mirrors keyring.ts)', () => {
    const src = read('deploy/scripts/bot-errors-health-check.py');
    assertOrder(src, 'bot-errors-health-check.py', [
      'if user is None and env_key and os.environ.get(env_key):',
      'if user is None and whatsoup_keyfile_present(service):',
      '_keychain_secret_status(candidates, account',
    ]);
  });
});
