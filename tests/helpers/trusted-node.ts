// tests/helpers/trusted-node.ts
//
// A node interpreter at a TRUSTED path — one with no world/group-writable, non-sticky ancestor —
// for tests that exercise the resolver-execution HAPPY PATH.
//
// Why this exists: `process.execPath` cannot be used as the resolver interpreter in these tests.
// On GitHub Actions the runner's node lives under `/opt/hostedtoolcache/node/<v>/x64`, whose
// ancestor is world-writable WITHOUT the sticky bit; a Homebrew node (`/opt/homebrew/...`) is
// group-writable the same way. The round-21 finding-1 interpreter-writability guard
// (`assertInterpreterNotUntrustedWritable` in src/core/capability-resolver-artifact.ts) CORRECTLY
// refuses such an interpreter — a different actor could swap it between hash and spawn — so every
// resolver happy-path turns into `resolver_artifact_unverified`. Locally this never fires because
// the pinned nvm node lives in a user-owned, non-world-writable directory; it is latent until CI.
//
// The fix is test-infrastructure only: stage a byte-identical node at a trusted path and use THAT
// as the interpreter. The guard and every falsifier are unchanged. Tests that assert the guard
// REFUSES an untrusted interpreter (the F1 falsifiers) must keep building their OWN world-writable
// interpreter — do NOT route those through here.

import { accessSync, chmodSync, constants, copyFileSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { verifyResolverArtifact } from '../../src/core/capability-resolver-artifact.ts';

let cached: string | null = null;

/**
 * Path to a node interpreter with no untrusted-writable ancestor. Byte-identical to the running
 * node (hardlink where possible — same inode, faithful and free — else a reflink/copy). Memoized
 * per process; the staging directory is removed on process exit.
 *
 * Self-verified through the guard's OWN code path: if the chosen staging location happens to have a
 * world/group-writable non-sticky ancestor (e.g. `TMPDIR` redirected to a permissive tree),
 * `verifyResolverArtifact` throws the very "world-writable" error we are working around, and we
 * re-surface it as a NAMED setup failure instead of a mystifying per-test one.
 */
export function trustedNodePath(): string {
  if (cached) return cached;
  // realpathSync so a symlinked TMPDIR is resolved before the guard walks ancestors.
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'trusted-node-'));
  const node = join(dir, basename(process.execPath));
  try {
    linkSync(process.execPath, node); // same inode: faithful (preserves any signature) and free
  } catch {
    copyFileSync(process.execPath, node, constants.COPYFILE_FICLONE); // cross-fs fallback (reflink if supported)
  }
  // linkSync preserves the source mode; a copy may not carry the exec bit. Make it runnable and prove it.
  try {
    accessSync(node, constants.X_OK);
  } catch {
    chmodSync(node, 0o755); // a copy may drop the exec bit; ensure it, then re-assert
    accessSync(node, constants.X_OK);
  }
  // Self-check via the real guard. The interpreter (110MB node) must NOT live in the resolver
  // artifact's directory — the directory-manifest walk has a 64MB size cap and would throw a
  // spurious "exceeds staging bound" — so put the probe resolver in a sibling subdir.
  const probeDir = join(dir, 'probe');
  mkdirSync(probeDir);
  const probe = join(probeDir, 'probe.cjs');
  writeFileSync(probe, 'process.stdout.write("ok")\n');
  try {
    verifyResolverArtifact({ command: [node, probe, '{source}'], resolverArtifactPath: probe, interpreted: true });
  } catch (e) {
    throw new Error(`trustedNodePath: staged interpreter dir is unsuitable (${node}): ${(e as Error).message}`);
  }
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  cached = node;
  return node;
}
