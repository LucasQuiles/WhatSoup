import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import {
  findDesignSystemHygieneIssues,
  parseArgs,
  runDesignSystemHygieneGuard,
} from '../../scripts/design-system-hygiene-guard.ts';

const repos: string[] = [];

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: cleanGitEnv() });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'design-system-hygiene-'));
  repos.push(repo);
  git(repo, ['init']);
  return repo;
}

function stageFile(repo: string, filePath: string, content: string): void {
  const absolute = join(repo, filePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  git(repo, ['add', filePath]);
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
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

  it('fails visual or contrast harness changes without QA hardening docs', () => {
    const repo = makeRepo();
    stageFile(repo, 'console/scripts/check-contrast-matrix.mjs', 'console.log("contrast");\n');

    expect(findDesignSystemHygieneIssues(repo).map((issue) => issue.code)).toEqual([
      'qa-harness-missing-docs',
    ]);
  });

  it('passes visual or contrast harness changes when qa-hardening.md is staged too', () => {
    const repo = makeRepo();
    stageFile(repo, 'console/scripts/check-contrast-matrix.mjs', 'console.log("contrast");\n');
    stageFile(repo, 'docs/design-system/06-implementation/qa-hardening.md', '# QA hardening\n');

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

  it('prints json and returns a failing status when issues exist', () => {
    const repo = makeRepo();
    stageFile(repo, 'console/src/styles/tokens.component.css', ':root { --card-gap: 12px; }\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(runDesignSystemHygieneGuard(['--json'], repo)).toBe(1);
    expect(log.mock.calls.join('\n')).toContain('"verdict": "FAIL"');
    expect(log.mock.calls.join('\n')).toContain('token-implementation-missing-spec');
  });

  it('parses supported args', () => {
    expect(parseArgs(['--staged', '--json'])).toEqual({ help: false, json: true, staged: true });
    expect(parseArgs(['--help'])).toEqual({ help: true, json: false, staged: true });
    expect(() => parseArgs(['--unknown'])).toThrow('unknown argument: --unknown');
  });
});
