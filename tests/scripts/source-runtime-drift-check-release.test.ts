// source-runtime-drift-check × non-git release exports.
//
// The checker verified its trust exclusively through git (status/ls-files/
// ls-tree), so a manifest-based release export — the deployed shape a release
// directory takes, whose wrapper-level closure check already trusts
// `.whatsoup-release-manifest.json` (#2662) — died with a single critical
// git-error before inspecting anything. Surfaced live on mini11 (2026-07-29,
// second standard-release boot attempt): the wrapper's closure check passed
// and the checker then refused the same tree.
//
// Contract pinned here: git repos keep git trust (existing suite); a non-git
// tree with a release manifest verifies every walked file against the
// manifest — membership plus per-file sha256 at the point the bytes are read;
// a tree with neither trust root still fails closed with git-error.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  collectSourceRuntimeIssues,
  parseSourceRuntimeManifest,
} from '../../scripts/source-runtime-drift-check.ts';

let tmpRoot = '';
afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

const ENTRYPOINT = 'src/database-compatibility-bootstrap.ts';
const IMPORTED = 'src/lib/helper.ts';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeReleaseTree(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-source-runtime-release-'));
  tmpRoot = root;
  mkdirSync(path.join(root, 'src/lib'), { recursive: true });
  writeFileSync(path.join(root, ENTRYPOINT), `import './lib/helper.ts';\nexport const boot = 1;\n`);
  writeFileSync(path.join(root, IMPORTED), 'export const helper = 1;\n');
  return root;
}

function writeReleaseManifest(root: string, paths: string[] = [ENTRYPOINT, IMPORTED]): void {
  const files = paths.map((rel) => {
    const body = readFileSync(path.join(root, rel));
    return { path: rel, sha256: sha256(body), sizeBytes: body.length };
  });
  writeFileSync(path.join(root, '.whatsoup-release-manifest.json'), JSON.stringify({
    schemaVersion: 2,
    source: { ref: 'fixture', commit: 'f'.repeat(40) },
    release: { path: root, createdAt: '2026-07-29T00:00:00.000Z', mutablePathExcludes: ['node_modules/**'] },
    rollback: { path: `${root}-before` },
    files,
  }, null, 2));
}

function sourceRuntimeManifest() {
  return parseSourceRuntimeManifest({
    schemaVersion: 1,
    scope: 'database-compatibility-bootstrap',
    entrypoints: [{ path: ENTRYPOINT, importGraph: true }],
  });
}

describe('collectSourceRuntimeIssues on a non-git release export', () => {
  it('passes a release export whose walked files match the release manifest', () => {
    const root = makeReleaseTree();
    writeReleaseManifest(root);
    const issues = collectSourceRuntimeIssues(root, sourceRuntimeManifest());
    expect(issues).toEqual([]);
  });

  it('reports critical sha256 drift for a tampered walked file', () => {
    const root = makeReleaseTree();
    writeReleaseManifest(root);
    writeFileSync(path.join(root, IMPORTED), 'export const helper = 2; // tampered\n');
    const issues = collectSourceRuntimeIssues(root, sourceRuntimeManifest());
    const drift = issues.find((i) => i.kind === 'file-sha256-drift' && i.path === IMPORTED);
    expect(drift).toBeDefined();
    expect(drift?.severity).toBe('critical');
  });

  it('reports a walked file absent from the release manifest as untracked', () => {
    const root = makeReleaseTree();
    writeReleaseManifest(root, [ENTRYPOINT]);
    const issues = collectSourceRuntimeIssues(root, sourceRuntimeManifest());
    expect(issues.some((i) => i.kind === 'file-untracked' && i.path === IMPORTED)).toBe(true);
  });

  it('still fails closed with git-error when neither git nor a release manifest exists', () => {
    const root = makeReleaseTree();
    const issues = collectSourceRuntimeIssues(root, sourceRuntimeManifest());
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe('git-error');
    expect(issues[0]?.severity).toBe('critical');
  });
});
