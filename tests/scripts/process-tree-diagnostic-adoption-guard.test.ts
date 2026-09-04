import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import {
  scanProcessTreeDiagnosticAdoptionRepo,
  scanProcessTreeDiagnosticAdoptionSource,
} from '../../scripts/process-tree-diagnostic-adoption-guard.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(REPO_ROOT, 'scripts/process-tree-diagnostic-adoption-guard.ts');
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

describe('process-tree diagnostic adoption source scan', () => {
  it('detects missing diagnostics through a named import alias', () => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/alias.ts',
      [
        "import { killSessionTree as reap } from './runtimes/agent/process-tree.ts';",
        "void reap(42, 'SIGTERM', { generationMarker: 'g', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ].join('\n'),
    );

    expect(result.callsExamined).toBe(1);
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING', line: 2 }),
    ]);
  });

  it('rejects a source-tagged caller that omits either required observer', () => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/source-only.ts',
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        "void killSessionTree(42, 'SIGTERM', { generationMarker: 'g', diagnosticSource: 'session_shutdown' });",
      ].join('\n'),
    );

    expect(result.callsExamined).toBe(1);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'PROCESS_TREE_OUTCOME_OBSERVER_MISSING', line: 2 }),
      expect.objectContaining({ kind: 'PROCESS_TREE_DIVERGENCE_OBSERVER_MISSING', line: 2 }),
    ]));
  });

  it('rejects observer properties whose values are not inline callables', () => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/non-callable-observers.ts',
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        "void killSessionTree(42, 'SIGTERM', { generationMarker: 'g', diagnosticSource: 'session_shutdown', onOutcome: undefined, onCgroupDivergence: false });",
      ].join('\n'),
    );

    expect(result.callsExamined).toBe(1);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'PROCESS_TREE_OUTCOME_OBSERVER_INVALID', line: 2 }),
      expect.objectContaining({ kind: 'PROCESS_TREE_DIVERGENCE_OBSERVER_INVALID', line: 2 }),
    ]));
  });

  it('detects an invalid source through a namespace import', () => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/namespace.ts',
      [
        "import * as tree from './runtimes/agent/process-tree.ts';",
        "void tree.killSessionTree(42, 'SIGTERM', { generationMarker: 'g', diagnosticSource: 'invented', onOutcome: () => {}, onCgroupDivergence: () => {} });",
      ].join('\n'),
    );

    expect(result.callsExamined).toBe(1);
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_INVALID', line: 2 }),
    ]);
  });

  it('does not mistake an unrelated local function for the canonical declaration', () => {
    const result = scanProcessTreeDiagnosticAdoptionSource(
      'src/unrelated.ts',
      "function killSessionTree() {}\nkillSessionTree();",
    );
    expect(result).toEqual({ callsExamined: 0, findings: [], callSites: [] });
  });
});

describe('process-tree diagnostic adoption live-tree ratchet', () => {
  it('covers exactly the three production callers with their canonical sources', () => {
    const result = scanProcessTreeDiagnosticAdoptionRepo(REPO_ROOT);
    expect(result.filesExamined).toBeGreaterThan(100);
    expect(result.callsExamined).toBe(3);
    expect(result.findings).toEqual([]);
    expect(result.sourceCounts).toEqual({
      ownership_loss_cleanup: 1,
      session_shutdown: 1,
      stale_session_sweep: 1,
    });
  });

  it('emits one schema-valid JSON document with effect metadata in verbose mode', () => {
    const output = execFileSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', GUARD, '--format', 'json', '--verbose'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      schema_version: 'process-tree-diagnostic-adoption.v1',
      status: 'pass',
      effect: {
        read_only: true,
        destructive: false,
        idempotent: true,
        open_world: false,
        supports_dry_run: false,
      },
      calls_examined: 3,
    });
  });

  it('advertises every observer and traversal failure kind in its schema', () => {
    const output = execFileSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', GUARD, '--schema', '--format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const parsed = JSON.parse(output) as { error_kinds: string[] };
    expect(parsed.error_kinds).toEqual(expect.arrayContaining([
      'PROCESS_TREE_OUTCOME_OBSERVER_INVALID',
      'PROCESS_TREE_DIVERGENCE_OBSERVER_INVALID',
      'PROCESS_TREE_DIRECTORY_READ_FAILED',
    ]));
  });

  it('is inconclusive when any nested source directory cannot be enumerated', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-adoption-unreadable-'));
    temporaryRoots.push(root);
    const blocked = path.join(root, 'src', 'blocked');
    mkdirSync(blocked, { recursive: true });

    const result = scanProcessTreeDiagnosticAdoptionRepo(root, {
      readdir: (directory) => {
        if (directory === blocked) throw new Error('injected directory read failure');
        return readdirSync(directory, { withFileTypes: true });
      },
    });

    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'PROCESS_TREE_DIRECTORY_READ_FAILED',
      file: 'src/blocked',
      retryable: true,
    }));
  });

  it('fails closed with a stable error kind and remediation hint', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'process-tree-adoption-'));
    temporaryRoots.push(root);
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(
      path.join(root, 'src', 'caller.ts'),
      [
        "import { killSessionTree } from './runtimes/agent/process-tree.ts';",
        "void killSessionTree(42, 'SIGTERM', { generationMarker: 'g' });",
      ].join('\n'),
    );

    const result = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', GUARD, '--format', 'json', '--root', root],
      { cwd: root, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      errors: Array<{ kind: string; retryable: boolean; hint: string }>;
    };
    expect(parsed.status).toBe('fail');
    expect(parsed.errors[0]).toMatchObject({
      kind: 'PROCESS_TREE_DIAGNOSTIC_SOURCE_MISSING',
      retryable: false,
    });
    expect(parsed.errors[0]?.hint).toContain('diagnosticSource');
  });
});
