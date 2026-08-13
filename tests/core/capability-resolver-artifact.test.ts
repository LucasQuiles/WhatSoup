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
import { readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canonicalExecutionIdentity,
  resolverCompositeDigest,
  verifyResolverArtifact,
} from '../../src/core/capability-resolver-artifact.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('resolver-artifact-', { base: realpathSync(tmpdir()) });
const NODE = realpathSync(process.execPath);

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
    const symlink = join(dir, 'watch-resolver');
    symlinkSync(process.execPath, symlink);
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
  it('verifyResolverArtifact.compositeDigest === resolverCompositeDigest(contentDigest, execution) — the ONE canonicalizer', () => {
    const dir = tmp.make('composite-eq');
    const { path, contentDigest } = script(dir);
    const execution = { command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true };
    const v = verifyResolverArtifact(execution);
    expect(v.contentDigest).toBe(contentDigest);
    expect(v.compositeDigest).toBe(resolverCompositeDigest(contentDigest, execution));
  });

  it('the composite CHANGES when the execution SHAPE changes but the content does not (finding 2)', () => {
    const dir = tmp.make('composite-shape');
    const { path, contentDigest } = script(dir);
    const base = resolverCompositeDigest(contentDigest, { command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true });
    const extraArg = resolverCompositeDigest(contentDigest, { command: [NODE, path, '--danger', '{source}'], resolverArtifactPath: path, interpreted: true });
    const swappedTemplate = resolverCompositeDigest(contentDigest, { command: [NODE, path, '--out={source}'], resolverArtifactPath: path, interpreted: true });
    expect(extraArg).not.toBe(base);
    expect(swappedTemplate).not.toBe(base);
  });

  it('the composite CHANGES when the content changes but the shape does not (finding 1)', () => {
    const dir = tmp.make('composite-content');
    const path = join(dir, 'resolver.cjs');
    const execution = { command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true };
    writeFileSync(path, 'process.stdout.write("v1")\n');
    const v1 = resolverCompositeDigest(createHash('sha256').update(readFileSync(path)).digest('hex'), execution);
    writeFileSync(path, 'process.stdout.write("v2-EVIL")\n');
    const v2 = resolverCompositeDigest(createHash('sha256').update(readFileSync(path)).digest('hex'), execution);
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
