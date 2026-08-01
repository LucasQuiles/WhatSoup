import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import {
  findDesignSystemHygieneIssues,
  parseArgs,
  runDesignSystemHygieneGuard,
} from '../../scripts/design-system-hygiene-guard.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('');

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: cleanGitEnv() });
}

function gitOutput(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: cleanGitEnv() }).trim();
}

function makeRepo(): string {
  const repo = tmp.make('design-system-hygiene');
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'WhatSoup Test']);
  git(repo, ['config', 'user.email', 'whatsoup-test@users.noreply.github.com']);
  return repo;
}

function stageFile(repo: string, filePath: string, content: string): void {
  const absolute = join(repo, filePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  git(repo, ['add', filePath]);
}

function commit(repo: string, message: string): void {
  git(repo, ['commit', '-m', message]);
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('design-system hygiene guard', () => {
  it('passes when no design-system files are staged', () => {
    const repo = makeRepo();
    stageFile(repo, 'src/example.ts', 'export const value = 1;\n');

    expect(findDesignSystemHygieneIssues(repo)).toEqual([]);
  });

  it('fails token implementation changes without the token spec SSOT', () => {
    const repo = makeRepo();
    stageFile(repo, 'console/src/styles/tokens.semantic.css', ':root { --accent: #35f; }\n');

    expect(findDesignSystemHygieneIssues(repo)).toEqual([
      {
        code: 'token-implementation-missing-spec',
        filePath: 'console/src/styles/tokens.semantic.css',
        message: 'staged token implementation changes must update the token spec SSOT',
        required: ['docs/design-system/03-spec/tokens-v3.md'],
      },
    ]);
  });

  it('passes token implementation changes when tokens-v3.md is staged too', () => {
    const repo = makeRepo();
    stageFile(repo, 'console/src/styles/tokens.semantic.css', ':root { --accent: #35f; }\n');
    stageFile(repo, 'docs/design-system/03-spec/tokens-v3.md', '# Tokens\n\n- Accent updated.\n');

    expect(findDesignSystemHygieneIssues(repo)).toEqual([]);
  });

  it('fails lint implementation changes without lint-plan maintenance', () => {
    const repo = makeRepo();
    stageFile(repo, 'console/eslint-rules/index.mjs', 'export default { rules: {} };\n');

    expect(findDesignSystemHygieneIssues(repo).map((issue) => issue.code)).toEqual([
      'lint-implementation-missing-plan',
    ]);
  });

  it('fails default ESLint config changes without lint-plan maintenance', () => {
    const repo = makeRepo();
    stageFile(repo, 'console/eslint.config.js', 'export default [];\n');

    expect(findDesignSystemHygieneIssues(repo).map((issue) => issue.code)).toEqual([
      'lint-implementation-missing-plan',
    ]);
  });

  it('passes lint implementation changes when lint-plan.md is staged too', () => {
    const repo = makeRepo();
    stageFile(repo, 'console/eslint-rules/index.mjs', 'export default { rules: {} };\n');
    stageFile(repo, 'docs/design-system/04-enforcement/lint-plan.md', '# Lint plan\n');

    expect(findDesignSystemHygieneIssues(repo)).toEqual([]);
  });

  it('passes default ESLint config changes when lint-plan.md is staged too', () => {
    const repo = makeRepo();
    stageFile(repo, 'console/eslint.config.js', 'export default [];\n');
    stageFile(repo, 'docs/design-system/04-enforcement/lint-plan.md', '# Lint plan\n');

    expect(findDesignSystemHygieneIssues(repo)).toEqual([]);
  });

  it('fails visual, brand, color-semantics, contrast, resilience, or font harness changes without QA hardening docs', () => {
    const repo = makeRepo();
    stageFile(repo, 'console/scripts/check-color-semantics.mjs', 'console.log("color");\n');

    expect(findDesignSystemHygieneIssues(repo).map((issue) => issue.code)).toEqual([
      'qa-harness-missing-docs',
    ]);
  });

  it('passes visual, brand, color-semantics, contrast, resilience, or font harness changes when qa-hardening.md is staged too', () => {
    const repo = makeRepo();
    stageFile(repo, 'console/scripts/check-color-semantics.mjs', 'console.log("color");\n');
    stageFile(repo, 'docs/design-system/06-implementation/qa-hardening.md', '# QA hardening\n');

    expect(findDesignSystemHygieneIssues(repo)).toEqual([]);
  });

  it('fails font implementation changes without typography and provenance docs', () => {
    const repo = makeRepo();
    stageFile(repo, 'console/src/styles/fonts.css', '@font-face { font-family: Fixture; }\n');

    expect(findDesignSystemHygieneIssues(repo).map((issue) => issue.code)).toEqual([
      'font-implementation-missing-typography-spec',
      'font-asset-missing-provenance',
    ]);
  });

  it('passes font implementation changes when typography and provenance docs are staged too', () => {
    const repo = makeRepo();
    stageFile(repo, 'console/src/styles/fonts.css', '@font-face { font-family: Fixture; }\n');
    stageFile(repo, 'docs/design-system/03-spec/typography.md', '# Typography\n');
    stageFile(repo, 'console/public/fonts/README.md', '# Font provenance\n');

    expect(findDesignSystemHygieneIssues(repo)).toEqual([]);
  });

  it('fails font asset changes without typography and provenance docs', () => {
    const repo = makeRepo();
    stageFile(repo, 'console/public/fonts/Fixture.woff2', 'font-bytes');

    expect(findDesignSystemHygieneIssues(repo).map((issue) => issue.code)).toEqual([
      'font-implementation-missing-typography-spec',
      'font-asset-missing-provenance',
    ]);
  });

  it('fails brand asset changes without brand and iconography specs', () => {
    const repo = makeRepo();
    stageFile(repo, 'console/public/favicon.svg', '<svg />\n');

    expect(findDesignSystemHygieneIssues(repo).map((issue) => issue.code)).toEqual([
      'brand-asset-missing-brand-spec',
      'brand-asset-missing-iconography-spec',
    ]);
  });

  it('passes brand asset changes when brand and iconography specs are staged too', () => {
    const repo = makeRepo();
    stageFile(repo, 'console/public/favicon.svg', '<svg />\n');
    stageFile(repo, 'docs/design-system/03-spec/brand.md', '# Brand\n');
    stageFile(repo, 'docs/design-system/03-spec/iconography.md', '# Iconography\n');

    expect(findDesignSystemHygieneIssues(repo)).toEqual([]);
  });

  it('fails added design package scripts without QA hardening docs', () => {
    const repo = makeRepo();
    stageFile(
      repo,
      'package.json',
      JSON.stringify({ scripts: { 'guard:design-system-hygiene': 'tsx scripts/design-system-hygiene-guard.ts' } }, null, 2),
    );

    expect(findDesignSystemHygieneIssues(repo).map((issue) => issue.code)).toEqual([
      'design-script-missing-docs',
    ]);
  });

  it('fails changed-range token implementation changes without the token spec SSOT', () => {
    const repo = makeRepo();
    stageFile(repo, 'README.md', '# Fixture\n');
    commit(repo, 'base');
    const base = gitOutput(repo, ['rev-parse', 'HEAD']);

    stageFile(repo, 'console/src/styles/tokens.semantic.css', ':root { --accent: #35f; }\n');
    commit(repo, 'token change');

    expect(findDesignSystemHygieneIssues(repo, { changedSince: base }).map((issue) => issue.code)).toEqual([
      'token-implementation-missing-spec',
    ]);
  });

  it('passes changed-range token implementation changes when tokens-v3.md changed too', () => {
    const repo = makeRepo();
    stageFile(repo, 'README.md', '# Fixture\n');
    commit(repo, 'base');
    const base = gitOutput(repo, ['rev-parse', 'HEAD']);

    stageFile(repo, 'console/src/styles/tokens.semantic.css', ':root { --accent: #35f; }\n');
    stageFile(repo, 'docs/design-system/03-spec/tokens-v3.md', '# Tokens\n\n- Accent updated.\n');
    commit(repo, 'token change with docs');

    expect(findDesignSystemHygieneIssues(repo, { changedSince: base })).toEqual([]);
  });

  it('prints changed-range json mode', () => {
    const repo = makeRepo();
    stageFile(repo, 'README.md', '# Fixture\n');
    commit(repo, 'base');
    const base = gitOutput(repo, ['rev-parse', 'HEAD']);
    stageFile(repo, 'console/eslint-rules/index.mjs', 'export default { rules: {} };\n');
    commit(repo, 'lint change');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(runDesignSystemHygieneGuard(['--changed-since', base, '--json'], repo)).toBe(1);
    expect(log.mock.calls.join('\n')).toContain('"mode": "changed-since"');
    expect(log.mock.calls.join('\n')).toContain('lint-implementation-missing-plan');
  });

  it('prints json and returns a failing status when issues exist', () => {
    const repo = makeRepo();
    stageFile(repo, 'console/src/styles/tokens.component.css', ':root { --card-gap: 12px; }\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(runDesignSystemHygieneGuard(['--json'], repo)).toBe(1);
    expect(log.mock.calls.join('\n')).toContain('"verdict": "FAIL"');
    expect(log.mock.calls.join('\n')).toContain('token-implementation-missing-spec');
  });

  it('parses supported args', () => {
    expect(parseArgs(['--staged', '--json'])).toEqual({ changedSince: null, help: false, json: true, staged: true });
    expect(parseArgs(['--changed-since', 'origin/main'])).toEqual({ changedSince: 'origin/main', help: false, json: false, staged: false });
    expect(parseArgs(['--help'])).toEqual({ changedSince: null, help: true, json: false, staged: true });
    expect(() => parseArgs(['--changed-since'])).toThrow('--changed-since requires a git ref');
    expect(() => parseArgs(['--unknown'])).toThrow('unknown argument: --unknown');
  });
});
