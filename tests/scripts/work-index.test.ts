import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import {
  buildWorkIndex,
  compareWorkIndexCoverage,
  findIgnoredCanonicalDocs,
  findWorkIndexCheckIssues,
  findWorkIndexCoverageIssues,
  writeWorkIndex,
} from '../../scripts/work-index.ts';

const WORK_INDEX_TEST_TIMEOUT_MS = 30_000;
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() }).trim();
}

describe('work index scanner', () => {
  it('scans the current tree and includes the newly added superpowers files', () => {
    const index = buildWorkIndex(repoRoot);

    expect(index.total).toBe(index.rows.length);
    expect(index.rows.map((row) => row.path)).toEqual([...index.rows.map((row) => row.path)].sort());
    expect(index.rows.some((row) => row.path === 'docs/superpowers/plans/2026-04-25-operation-tracker.md')).toBe(true);
    expect(index.rows.some((row) => row.path === 'docs/superpowers/specs/2026-04-25-transport-layer-design.md')).toBe(true);
    expect(index.rows.some((row) => row.path === 'docs/superpowers/plans/2026-04-22-mw-bot-group-protection.md')).toBe(false);
    expect(index.rows.some((row) => row.path === 'docs/superpowers/plans/2026-04-23-history-sync-fitness-cleanup.md')).toBe(false);
  }, WORK_INDEX_TEST_TIMEOUT_MS);

  it('reports missing and stale coverage entries against a synthetic tree', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-work-index-'));
    const sdlcFile = path.join(root, 'docs/sdlc/active/example-epic/state.md');
    const planFile = path.join(root, 'docs/superpowers/plans/2026-04-25-example-plan.md');

    mkdirSync(path.dirname(sdlcFile), { recursive: true });
    mkdirSync(path.dirname(planFile), { recursive: true });
    writeFileSync(sdlcFile, '# Example\n**Status:** active\n', 'utf8');
    writeFileSync(planFile, '# Example\n', 'utf8');

    const issues = compareWorkIndexCoverage(root, new Set([
      'docs/sdlc/active/example-epic/state.md',
      'docs/superpowers/plans/2026-04-25-stale-plan.md',
    ]));

    expect(issues).toEqual({
      missing: ['docs/superpowers/plans/2026-04-25-example-plan.md'],
      stale: ['docs/superpowers/plans/2026-04-25-stale-plan.md'],
    });
  }, WORK_INDEX_TEST_TIMEOUT_MS);

  it('ignores untracked markdown files matched by gitignore', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-work-index-ignored-'));
    const ignoredPlan = path.join(root, 'docs/plans/local-only.md');
    const trackedPlan = path.join(root, 'docs/superpowers/plans/2026-04-25-example-plan.md');

    mkdirSync(path.dirname(ignoredPlan), { recursive: true });
    mkdirSync(path.dirname(trackedPlan), { recursive: true });
    writeFileSync(path.join(root, '.gitignore'), 'docs/plans/\n', 'utf8');
    writeFileSync(ignoredPlan, '# Local Only\n', 'utf8');
    writeFileSync(trackedPlan, '# Example\n', 'utf8');
    git(root, ['init']);
    git(root, ['config', 'user.name', 'Work Index Test']);
    git(root, ['config', 'user.email', 'work-index-test@users.noreply.github.com']);
    git(root, ['add', '.gitignore', 'docs/superpowers/plans/2026-04-25-example-plan.md']);
    git(root, ['commit', '-m', 'seed docs']);

    const index = buildWorkIndex(root);

    expect(index.rows.map((row) => row.path)).toEqual([
      'docs/superpowers/plans/2026-04-25-example-plan.md',
    ]);
    expect(compareWorkIndexCoverage(root, new Set(index.rows.map((row) => row.path)))).toEqual({
      missing: [],
      stale: [],
    });
  }, WORK_INDEX_TEST_TIMEOUT_MS);

  it('keeps the checked-in work-index artifacts clean', () => {
    expect(findWorkIndexCoverageIssues(repoRoot)).toEqual({ missing: [], stale: [] });
    expect(findWorkIndexCheckIssues(repoRoot)).toEqual({ missing: [], stale: [], drift: [], ignoredCanonical: [] });
  }, WORK_INDEX_TEST_TIMEOUT_MS);

  it('surfaces ignored markdown under a canonical doc root, but not under a local-only root (#640)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-work-index-ignored-canonical-'));
    // docs/specs holds a tracked canonical doc → it is a "canonical root".
    const trackedSpec = path.join(root, 'docs/specs/2026-01-01-design.md');
    // An ignored sibling under the SAME canonical root must be surfaced.
    const ignoredSpec = path.join(root, 'docs/specs/local-draft.md');
    // docs/plans holds NO tracked docs → purely local; ignored content stays silent.
    const ignoredPlan = path.join(root, 'docs/plans/scratch.md');

    mkdirSync(path.dirname(trackedSpec), { recursive: true });
    mkdirSync(path.dirname(ignoredPlan), { recursive: true });
    writeFileSync(path.join(root, '.gitignore'), 'docs/specs/\ndocs/plans/\n', 'utf8');
    writeFileSync(trackedSpec, '# Design\n', 'utf8');
    writeFileSync(ignoredSpec, '# Local Draft\n', 'utf8');
    writeFileSync(ignoredPlan, '# Scratch\n', 'utf8');
    git(root, ['init']);
    git(root, ['config', 'user.name', 'Work Index Test']);
    git(root, ['config', 'user.email', 'work-index-test@users.noreply.github.com']);
    // Force-add the canonical spec past gitignore; leave the drafts ignored.
    git(root, ['add', '.gitignore']);
    git(root, ['add', '-f', 'docs/specs/2026-01-01-design.md']);
    git(root, ['commit', '-m', 'seed canonical spec']);

    const ignored = findIgnoredCanonicalDocs(root);

    expect(ignored).toContain('docs/specs/local-draft.md');
    expect(ignored).not.toContain('docs/plans/scratch.md');
    // The check result carries it as a distinct, warn-class finding.
    writeWorkIndex(root);
    expect(findWorkIndexCheckIssues(root).ignoredCanonical).toContain('docs/specs/local-draft.md');
  }, WORK_INDEX_TEST_TIMEOUT_MS);

  it('honors an explicit leading status before explanatory status words', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-work-index-status-'));
    const planFile = path.join(root, 'docs/superpowers/plans/2026-04-25-example-plan.md');

    mkdirSync(path.dirname(planFile), { recursive: true });
    writeFileSync(
      planFile,
      '# Example\n**Status:** unknown - stalled at SPEC DRAFT stage; team consensus pending\n',
      'utf8',
    );
    git(root, ['init']);
    git(root, ['config', 'user.name', 'Work Index Test']);
    git(root, ['config', 'user.email', 'work-index-test@users.noreply.github.com']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'seed docs']);

    const index = buildWorkIndex(root);

    expect(index.rows.find((row) => row.path === 'docs/superpowers/plans/2026-04-25-example-plan.md')?.status)
      .toBe('unknown');
  }, WORK_INDEX_TEST_TIMEOUT_MS);

  it('detects stale generated work-index artifacts, not just path coverage', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-work-index-drift-'));
    const planFile = path.join(root, 'docs/superpowers/plans/2026-04-25-example-plan.md');

    mkdirSync(path.dirname(planFile), { recursive: true });
    writeFileSync(planFile, '# Example\n', 'utf8');
    git(root, ['init']);
    git(root, ['config', 'user.name', 'Work Index Test']);
    git(root, ['config', 'user.email', 'work-index-test@users.noreply.github.com']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'seed docs']);

    writeWorkIndex(root);
    expect(findWorkIndexCheckIssues(root)).toEqual({ missing: [], stale: [], drift: [], ignoredCanonical: [] });

    writeFileSync(planFile, '# Example\n**Status:** active\n', 'utf8');

    expect(findWorkIndexCheckIssues(root)).toEqual({
      missing: [],
      stale: [],
      drift: [
        { path: 'docs/work-index.json', reason: 'generated JSON differs from scanner output' },
        { path: 'docs/work-index.md', reason: 'generated Markdown differs from scanner output' },
      ],
      ignoredCanonical: [],
    });
  }, WORK_INDEX_TEST_TIMEOUT_MS);
});
