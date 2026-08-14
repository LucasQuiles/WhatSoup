/**
 * capability-resolver-artifact (round-18 finding 1; round-19 findings 1+2): the resolver
 * artifact must be declared EXPLICITLY, the command shape validated against it (never
 * inferred from argv), and the attested digest must be a COMPOSITE binding the artifact
 * CONTENT and the execution SHAPE. These tests lock in:
 *   - r18: `perl -eCODE <decoy>` refused; a `watch-resolver`→node symlink cannot be the
 *     declared interpreted script;
 *   - r19: an `interpreted:false` MISLABEL of an interpreter is refused structurally; the
 *     composite changes on a content swap OR a shape change; the ONE canonicalizer is
 *     deterministic and is what `verifyResolverArtifact` returns.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canonicalExecutionIdentity,
  directoryManifestDigest,
  resolverCompositeDigest,
  stageResolverArtifact,
  verifyResolverArtifact,
} from '../../src/core/capability-resolver-artifact.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { trustedNodePath } from '../helpers/trusted-node.ts';

const tmp = trackTmpDirs('resolver-artifact-', { base: realpathSync(tmpdir()) });
// The interpreter must live at a TRUSTED path: `process.execPath` is world-writable on CI
// (hostedtoolcache) / a Homebrew node, which the r21 F1 guard correctly refuses. Falsifiers that
// assert that refusal build their OWN world-writable interpreter below and do NOT use NODE.
const NODE = trustedNodePath();
/** round-20: the composite now binds the INTERPRETER content too; interpreted fixtures use NODE. */
const NODE_DIGEST = createHash('sha256').update(readFileSync(NODE)).digest('hex');
/**
 * round-20 (advisor): the composite now also binds the whole-directory MANIFEST. Compute it EXACTLY
 * the way production does — over `dirname(realpathSync(artifactPath))` — so a test that hand-builds a
 * composite matches `verifyResolverArtifact`/`stageResolverArtifact`.
 */
const manifestOf = (path: string): string => directoryManifestDigest(dirname(realpathSync(path)));

function script(dir: string, name = 'resolver.cjs'): { path: string; contentDigest: string } {
  const path = join(dir, name);
  writeFileSync(path, 'process.stdout.write("processed:" + process.argv[2])\n');
  return { path, contentDigest: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

describe('verifyResolverArtifact (explicit, deny-by-default)', () => {
  it('verifies an interpreted resolver: hashes the declared SCRIPT (command[1]), not the interpreter', () => {
    const dir = tmp.make('ok-interp');
    const { path, contentDigest } = script(dir);
    const v = verifyResolverArtifact({ command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true });
    expect(v).toMatchObject({ contentDigest, realpath: realpathSync(path), interpreted: true });
  });

  it('verifies a direct executable resolver: hashes command[0] as the declared artifact', () => {
    const dir = tmp.make('ok-direct');
    const { path, contentDigest } = script(dir, 'resolver');
    const v = verifyResolverArtifact({ command: [path, '{source}'], resolverArtifactPath: path, interpreted: false });
    expect(v).toMatchObject({ contentDigest, interpreted: false });
  });

  it('BYPASS-A FALSIFIER: `perl -eCODE <decoy>` is refused (command[1] is a flag, not the declared script)', () => {
    const dir = tmp.make('perl');
    const { path: decoy } = script(dir, 'decoy.js');
    expect(() => verifyResolverArtifact({ command: ['perl', '-eprint("evil")', decoy], resolverArtifactPath: decoy, interpreted: true }))
      .toThrow(/is a flag, not the declared script|inline-code/);
  });

  it('BYPASS-B FALSIFIER: a symlink `watch-resolver`→node cannot be declared as the interpreted SCRIPT', () => {
    const dir = tmp.make('symlink');
    const symlink = join(dir, 'watch-resolver');
    symlinkSync(process.execPath, symlink);
    const { path: realScript } = script(dir);
    expect(() => verifyResolverArtifact({ command: [symlink, realScript, '{source}'], resolverArtifactPath: symlink, interpreted: true }))
      .toThrow(/does not equal declared resolverArtifactPath realpath/);
  });

  it('BYPASS-B, honest form: with interpreted:true the SCRIPT (command[1]) is what gets verified — decoy cannot be substituted', () => {
    const dir = tmp.make('symlink-ok');
    // The interpreter symlink lives OUTSIDE the resolver dir (round-20: a symlink INSIDE the
    // resolver dir is refused fail-closed by the whole-tree manifest). command[0] is realpath-
    // resolved to node and its target hashed; the resolver dir itself stays symlink-free.
    const binDir = tmp.make('symlink-ok-bin');
    const symlink = join(binDir, 'watch-resolver');
    symlinkSync(NODE, symlink); // trusted target: this test's second assertion expects verify to SUCCEED
    const { path: realScript, contentDigest } = script(dir);
    const { path: decoy } = script(dir, 'decoy.js');
    expect(() => verifyResolverArtifact({ command: [symlink, realScript, '{source}'], resolverArtifactPath: decoy, interpreted: true }))
      .toThrow(/does not equal declared resolverArtifactPath realpath/);
    expect(verifyResolverArtifact({ command: [symlink, realScript, '{source}'], resolverArtifactPath: realScript, interpreted: true }).contentDigest).toBe(contentDigest);
  });

  it('r19 MISLABEL FALSIFIER: interpreted:false whose artifact realpath IS an interpreter (watch-resolver→node) is refused', () => {
    const dir = tmp.make('mislabel-symlink');
    const symlink = join(dir, 'watch-resolver');
    symlinkSync(process.execPath, symlink); // realpath basename → "node"
    const { path: realScript } = script(dir);
    // The reviewer's bypass: declare node-symlink as the DIRECT artifact while a script arg runs.
    expect(() => verifyResolverArtifact({ command: [symlink, realScript, '{source}'], resolverArtifactPath: symlink, interpreted: false }))
      .toThrow(/is a known interpreter|mislabel refused/);
  });

  it('r19 MISLABEL FALSIFIER: interpreted:false artifact named like a versioned interpreter (node24) is refused', () => {
    const dir = tmp.make('mislabel-versioned');
    const { path } = script(dir, 'node24'); // a plain file named like an interpreter
    expect(() => verifyResolverArtifact({ command: [path, '{source}'], resolverArtifactPath: path, interpreted: false }))
      .toThrow(/is a known interpreter|mislabel refused/);
  });

  it('FALSIFIER: a missing resolverArtifactPath is refused (must be explicit, never inferred)', () => {
    const dir = tmp.make('noartifact');
    const { path } = script(dir);
    expect(() => verifyResolverArtifact({ command: [NODE, path, '{source}'], interpreted: true }))
      .toThrow(/resolverArtifactPath is required/);
  });

  it('FALSIFIER: a missing `interpreted` is refused (structure must be declared)', () => {
    const dir = tmp.make('nointerp');
    const { path } = script(dir);
    expect(() => verifyResolverArtifact({ command: [NODE, path, '{source}'], resolverArtifactPath: path }))
      .toThrow(/interpreted is required/);
  });

  it('FALSIFIER: declared artifact whose realpath != the executing token is refused (interpreted)', () => {
    const dir = tmp.make('mismatch-i');
    const { path } = script(dir);
    const { path: other } = script(dir, 'other.cjs');
    expect(() => verifyResolverArtifact({ command: [NODE, path, '{source}'], resolverArtifactPath: other, interpreted: true }))
      .toThrow(/does not equal declared resolverArtifactPath realpath/);
  });

  it('FALSIFIER: a nonexistent declared artifact is refused', () => {
    expect(() => verifyResolverArtifact({ command: [NODE, '/no/such/x.cjs', '{source}'], resolverArtifactPath: '/no/such/x.cjs', interpreted: true }))
      .toThrow(/not resolvable/);
  });
});

describe('composite digest (round-19 findings 1+2): content AND shape are bound', () => {
  it('verifyResolverArtifact.compositeDigest === resolverCompositeDigest(contentDigest, manifestDigest, execution) — the ONE canonicalizer', () => {
    const dir = tmp.make('composite-eq');
    const { path, contentDigest } = script(dir);
    const execution = { command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true };
    const v = verifyResolverArtifact(execution);
    expect(v.contentDigest).toBe(contentDigest);
    // Pass the manifest production computed (v.manifestDigest) AND assert it matches an independent
    // walk — proving the returned composite is exactly the pure-function recompute of the same inputs.
    expect(v.manifestDigest).toBe(manifestOf(path));
    expect(v.compositeDigest).toBe(resolverCompositeDigest(contentDigest, v.manifestDigest, execution, NODE_DIGEST));
  });

  it('the composite CHANGES when the execution SHAPE changes but the content does not (finding 2)', () => {
    const dir = tmp.make('composite-shape');
    const { path, contentDigest } = script(dir);
    const m = manifestOf(path); // constant across all three: same dir, only the SHAPE varies
    const base = resolverCompositeDigest(contentDigest, m, { command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true }, NODE_DIGEST);
    const extraArg = resolverCompositeDigest(contentDigest, m, { command: [NODE, path, '--danger', '{source}'], resolverArtifactPath: path, interpreted: true }, NODE_DIGEST);
    const swappedTemplate = resolverCompositeDigest(contentDigest, m, { command: [NODE, path, '--out={source}'], resolverArtifactPath: path, interpreted: true }, NODE_DIGEST);
    expect(extraArg).not.toBe(base);
    expect(swappedTemplate).not.toBe(base);
  });

  it('the composite CHANGES when the content changes but the shape does not (finding 1)', () => {
    const dir = tmp.make('composite-content');
    const path = join(dir, 'resolver.cjs');
    const execution = { command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true };
    writeFileSync(path, 'process.stdout.write("v1")\n');
    const v1 = resolverCompositeDigest(createHash('sha256').update(readFileSync(path)).digest('hex'), manifestOf(path), execution, NODE_DIGEST);
    writeFileSync(path, 'process.stdout.write("v2-EVIL")\n');
    const v2 = resolverCompositeDigest(createHash('sha256').update(readFileSync(path)).digest('hex'), manifestOf(path), execution, NODE_DIGEST);
    expect(v2).not.toBe(v1);
  });

  it('canonicalExecutionIdentity is deterministic and binds command + interpreted; deny-by-default on missing declaration', () => {
    const dir = tmp.make('canon');
    const { path } = script(dir);
    const a = canonicalExecutionIdentity({ command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true });
    const b = canonicalExecutionIdentity({ command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true });
    expect(a).toBe(b);
    expect(canonicalExecutionIdentity({ command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: false })).not.toBe(a);
    expect(() => canonicalExecutionIdentity({ command: [NODE, path, '{source}'], interpreted: true }))
      .toThrow(/resolverArtifactPath is required/);
  });
});

describe('round-20: interpreter identity, direct-mode arg constraint, and envelope binding', () => {
  it('BLOCKER-2a FALSIFIER: the composite CHANGES when the INTERPRETER content changes (same script) — a same-path interpreter swap is detected', () => {
    const dir = tmp.make('interp-swap');
    const { path } = script(dir);
    // The interpreter lives in a SEPARATE dir from the script so the whole-tree manifest (walked
    // over the script's dir) stays CONSTANT — isolating interpreterDigest as the sole variable.
    // Otherwise the manifest would also catch the fake-interp change and this test would pass even
    // if interpreterDigest were dropped from the composite (defeating its falsification power).
    const binDir = tmp.make('interp-swap-bin');
    const fakeInterp = join(binDir, 'fake-interp');
    writeFileSync(fakeInterp, '#!/bin/sh\nexec node "$@"\n');
    const execution = { command: [fakeInterp, path, '{source}'], resolverArtifactPath: path, interpreted: true };
    const c1 = verifyResolverArtifact(execution).compositeDigest;
    writeFileSync(fakeInterp, '#!/bin/sh\nexec node --EVIL-FLAG "$@"\n'); // swap ONLY the interpreter content
    const c2 = verifyResolverArtifact(execution).compositeDigest;
    expect(c2).not.toBe(c1); // pre-round-20 the interpreter was not hashed → these were equal
  });

  it('BLOCKER-2b FALSIFIER: a direct-mode command with a bare positional arg after the artifact is REFUSED (a renamed interpreter could run it)', () => {
    const dir = tmp.make('direct-bare');
    const { path } = script(dir, 'watch-resolver'); // basename evades the interpreter deny-list
    const smuggledScript = join(dir, 'evil.js');
    writeFileSync(smuggledScript, 'process.stdout.write("PWNED")');
    expect(() => verifyResolverArtifact({ command: [path, smuggledScript, '{source}'], resolverArtifactPath: path, interpreted: false }))
      .toThrow(/bare positional argument/);
  });

  it('the composite CHANGES when the ENVELOPE (timeoutMs / minOutputBytes) changes (round-20 gap)', () => {
    const dir = tmp.make('envelope');
    const { path, contentDigest } = script(dir);
    const m = manifestOf(path); // constant across all three: only the ENVELOPE varies
    const base = resolverCompositeDigest(contentDigest, m, { command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true, timeoutMs: 1000, minOutputBytes: 8 }, NODE_DIGEST);
    const diffTimeout = resolverCompositeDigest(contentDigest, m, { command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true, timeoutMs: 2000, minOutputBytes: 8 }, NODE_DIGEST);
    const diffMinOut = resolverCompositeDigest(contentDigest, m, { command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true, timeoutMs: 1000, minOutputBytes: 16 }, NODE_DIGEST);
    expect(diffTimeout).not.toBe(base);
    expect(diffMinOut).not.toBe(base);
  });
});

describe('stageResolverArtifact (round-20 findings 1+3: content-addressed immutable execution)', () => {
  it('BLOCKER-1 FALSIFIER: the staged bytes are UNAFFECTED by an in-place overwrite of the original after staging (verify == execute)', () => {
    const dir = tmp.make('stage-iso');
    const { path, contentDigest } = script(dir);
    const staged = stageResolverArtifact({ command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true });
    try {
      expect(staged.contentDigest).toBe(contentDigest); // the copy carries the verified bytes
      // The round-19 hardlink shared the inode, so this overwrite would have changed the executed
      // bytes. The staged COPY is a separate inode → the executed bytes are unchanged.
      writeFileSync(path, 'process.stdout.write("SWAPPED-EVIL")\n');
      const executedDigest = createHash('sha256').update(readFileSync(staged.stagedArtifactPath)).digest('hex');
      expect(executedDigest).toBe(contentDigest); // NOT the swapped bytes
    } finally {
      rmSync(staged.stageDir, { recursive: true, force: true });
    }
  });

  it('preserves sibling-module resolution: a sibling file is copied next to the staged artifact (dir-staging)', () => {
    const dir = tmp.make('stage-sibling');
    const { path } = script(dir);
    writeFileSync(join(dir, 'helper.cjs'), 'module.exports = () => "HELPER-OK";\n');
    const staged = stageResolverArtifact({ command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true });
    try {
      expect(existsSync(join(dirname(staged.stagedArtifactPath), 'helper.cjs'))).toBe(true);
    } finally {
      rmSync(staged.stageDir, { recursive: true, force: true });
    }
  });

  it('refuses a resolver directory that exceeds the staging size bound (fail-closed, no copy)', () => {
    const dir = tmp.make('stage-toobig');
    const { path } = script(dir);
    const big = join(dir, 'big.bin');
    writeFileSync(big, '');
    truncateSync(big, 65 * 1024 * 1024); // sparse — 65MB apparent size (> 64MB bound), instant
    expect(() => stageResolverArtifact({ command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true }))
      .toThrow(/exceeds the .*staging bound/);
  });

  it('ADVISOR-BLOCKER FALSIFIER: swapping a SIBLING after attestation changes the composite — the WHOLE tree is bound, not just the artifact', () => {
    // The exploit the advisor named: stage+execute the whole directory, but bind only the single
    // artifact file, and a post-attest `helper.cjs` overwrite executes (an `import './helper'` loads
    // it) while the artifact's own contentDigest — and thus the composite — is unchanged.
    const dir = tmp.make('stage-sibling-swap');
    const { path, contentDigest } = script(dir);
    const sibling = join(dir, 'helper.cjs');
    writeFileSync(sibling, 'module.exports = () => "HELPER-OK";\n');
    const execution = { command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true };
    const s1 = stageResolverArtifact(execution);
    const composite1 = s1.compositeDigest;
    const manifest1 = s1.manifestDigest;
    rmSync(s1.stageDir, { recursive: true, force: true });
    // Swap ONLY the sibling; the artifact's own bytes are untouched.
    writeFileSync(sibling, 'module.exports = () => "HELPER-EVIL";\n');
    const s2 = stageResolverArtifact(execution);
    const composite2 = s2.compositeDigest;
    const manifest2 = s2.manifestDigest;
    rmSync(s2.stageDir, { recursive: true, force: true });
    expect(s2.contentDigest).toBe(contentDigest); // artifact bytes unchanged...
    expect(manifest2).not.toBe(manifest1); // ...but the manifest saw the sibling change...
    expect(composite2).not.toBe(composite1); // ...so the drain-seam composite CHANGED (would refuse it).
  });

  it('refuses a resolver directory containing a SYMLINK, fail-closed BEFORE any copy (a symlink survives cpSync and can point at mutable bytes)', () => {
    const dir = tmp.make('stage-symlink');
    const { path } = script(dir);
    symlinkSync('/etc/hosts', join(dir, 'sneaky-link')); // target need not exist / is never read
    expect(() => stageResolverArtifact({ command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true }))
      .toThrow(/symlink/);
  });
});

describe('directoryManifestDigest (round-20 advisor: canonical whole-tree binding)', () => {
  it('is deterministic (independent of readdir order and locale) and recurses into subdirectories', () => {
    const dir = tmp.make('manifest-det');
    writeFileSync(join(dir, 'b.cjs'), 'B');
    writeFileSync(join(dir, 'a.cjs'), 'A');
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'lib', 'nested.cjs'), 'N'); // exercises the recursive walk + relpath
    expect(directoryManifestDigest(dir)).toBe(directoryManifestDigest(dir));
  });

  it('CHANGES when a nested subdirectory file changes (recursion is content-bound, not name-only)', () => {
    const dir = tmp.make('manifest-nested');
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'lib', 'nested.cjs'), 'N');
    const before = directoryManifestDigest(dir);
    writeFileSync(join(dir, 'lib', 'nested.cjs'), 'N-EVIL');
    expect(directoryManifestDigest(dir)).not.toBe(before);
  });

  it('CHANGES when any file content changes', () => {
    const dir = tmp.make('manifest-content');
    writeFileSync(join(dir, 'a.cjs'), 'A');
    const before = directoryManifestDigest(dir);
    writeFileSync(join(dir, 'a.cjs'), 'A-EVIL');
    expect(directoryManifestDigest(dir)).not.toBe(before);
  });

  it('CHANGES when a new sibling file is added', () => {
    const dir = tmp.make('manifest-add');
    writeFileSync(join(dir, 'a.cjs'), 'A');
    const before = directoryManifestDigest(dir);
    writeFileSync(join(dir, 'evil.cjs'), 'EVIL');
    expect(directoryManifestDigest(dir)).not.toBe(before);
  });

  it('refuses a symlink fail-closed', () => {
    const dir = tmp.make('manifest-symlink');
    writeFileSync(join(dir, 'a.cjs'), 'A');
    symlinkSync('/etc/hosts', join(dir, 'link'));
    expect(() => directoryManifestDigest(dir)).toThrow(/symlink/);
  });

  // round-21 finding 3: an added/empty DIRECTORY must change the manifest (round-20 entered only
  // regular files, so a post-attest empty dir was invisible to the composite).
  it('R21 F3 FALSIFIER: adding an EMPTY directory changes the manifest digest (directory entries are bound)', () => {
    const dir = tmp.make('r21-f3-manifest');
    writeFileSync(join(dir, 'resolver.cjs'), 'X');
    const before = directoryManifestDigest(dir);
    mkdirSync(join(dir, 'evil-empty-dir'));
    const after = directoryManifestDigest(dir);
    expect(after).not.toBe(before); // revert the fix → the empty dir is invisible → equal → RED
  });

  it('R21 F3: a NESTED empty directory is bound too (recursive)', () => {
    const dir = tmp.make('r21-f3-nested');
    writeFileSync(join(dir, 'resolver.cjs'), 'X');
    mkdirSync(join(dir, 'pkg'));
    const before = directoryManifestDigest(dir);
    mkdirSync(join(dir, 'pkg', '__pycache__'));
    expect(directoryManifestDigest(dir)).not.toBe(before);
  });
});

describe('round-21 execution-boundary falsifiers (reopened bypasses)', () => {
  // F2 (no precondition): round-20's finding-2b allowed FLAGS after a direct artifact, so a renamed
  // interpreter with `["-c","{source}"]` ran the inbound {source} as shell code. The malicious config
  // is refused at VERIFY (and STAGE) — so it can never be attested and can never reach the executor.
  it('R21 F2 FALSIFIER: direct-mode [artifact, "-c", "{source}"] is REFUSED at verify/stage (flag runs {source} as code)', () => {
    const dir = tmp.make('r21-f2');
    const artifact = join(dir, 'watch-resolver'); // renamed interpreter: basename evades isInterpreterName
    writeFileSync(artifact, '#!/bin/sh\nexec "$@"\n');
    const decl = { command: [artifact, '-c', '{source}'], resolverArtifactPath: artifact, interpreted: false } as const;
    expect(() => verifyResolverArtifact(decl)).toThrow(/flag/i); // revert fix → accepted → RED
    expect(() => stageResolverArtifact(decl)).toThrow(/flag/i);
    // a `--eval={source}` embedded code flag is ALSO refused (it starts with '-')
    expect(() => verifyResolverArtifact({ command: [artifact, '--eval={source}'], resolverArtifactPath: artifact, interpreted: false })).toThrow(/flag/i);
    // positive control — a bare {source} DATA token (no flag) is still accepted (the named awk-style
    // residual, whose structural closure is owner-gated; NOT this exploit)
    expect(() => verifyResolverArtifact({ command: [artifact, '{source}'], resolverArtifactPath: artifact, interpreted: false })).not.toThrow();
  });

  // F1: the interpreter is hashed then executed from its realpath (not staged). Refuse an interpreter
  // (or ancestor dir) a DIFFERENT untrusted actor could swap between hash and spawn: world-writable,
  // or group-writable by a group we belong to. (A euid-owned interpreter — nvm/homebrew node — is the
  // same-UID finding-4 boundary and is NOT refused; that is the positive control.)
  it('R21 F1 FALSIFIER: an interpreter in a WORLD-writable directory is REFUSED at verify/stage', () => {
    const dir = tmp.make('r21-f1');
    const resolver = join(dir, 'resolver.cjs');
    writeFileSync(resolver, 'process.stdout.write("ok")');
    const binDir = tmp.make('r21-f1-bin');
    const interp = join(binDir, 'node');
    writeFileSync(interp, '#!/bin/sh\nexit 0\n');
    chmodSync(interp, 0o755);
    chmodSync(binDir, 0o777); // WORLD-writable ancestor → any actor can rename the interpreter
    const decl = { command: [interp, resolver, '{source}'], resolverArtifactPath: resolver, interpreted: true } as const;
    expect(() => verifyResolverArtifact(decl)).toThrow(/world-writable/i); // revert fix → accepted → RED
    expect(() => stageResolverArtifact(decl)).toThrow(/world-writable/i);
    // positive control — the real user-owned node (755, not world/group-writable) is accepted
    expect(() => verifyResolverArtifact({ command: [NODE, resolver, '{source}'], resolverArtifactPath: resolver, interpreted: true })).not.toThrow();
  });
});
