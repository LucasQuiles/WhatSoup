import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanGitEnv } from '../../scripts/lib/guard-core.ts';
import {
  collectSourceRuntimeIssues,
  parseSourceRuntimeManifest,
  run,
} from '../../scripts/source-runtime-drift-check.ts';

let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
  process.exitCode = undefined;
  vi.unstubAllEnvs();
});

function execGit(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=.git/hooks', '-C', cwd, ...args], {
    env: cleanGitEnv(),
    stdio: 'pipe',
  });
}

function makeRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-source-runtime-'));
  tmpRoot = root;
  execGit(root, ['init', '-q']);
  execGit(root, ['config', 'user.email', 'test.invalid']);
  execGit(root, ['config', 'user.name', 'Test']);
  mkdirSync(path.join(root, 'src/transport'), { recursive: true });
  writeFileSync(path.join(root, 'src/main.ts'), "import { connect } from './transport/connection.ts';\nconnect();\n", 'utf8');
  writeFileSync(path.join(root, 'src/transport/connection.ts'), "import { helper } from './helper.ts';\nexport function connect() { return helper(); }\n", 'utf8');
  writeFileSync(path.join(root, 'src/transport/helper.ts'), "export function helper() { return 'ok'; }\n", 'utf8');
  writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      scope: 'test',
      entrypoints: [{ path: 'src/main.ts', mustContain: ['connect'], importGraph: true }],
    }, null, 2),
    'utf8',
  );
  execGit(root, ['add', 'src/main.ts', 'src/transport/connection.ts', 'src/transport/helper.ts', 'manifest.json']);
  execGit(root, ['commit', '-qm', 'init']);
  return root;
}

describe('source runtime drift check', () => {
  it('passes when the entrypoint import graph is tracked, committed, and clean', () => {
    const root = makeRepo();
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));

    expect(collectSourceRuntimeIssues(root, manifest)).toEqual([]);
  });

  it('ignores inherited hook Git environment when creating synthetic repos', () => {
    const parentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: cleanGitEnv(),
    }).trim();
    const parentGitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: cleanGitEnv(),
    }).trim();
    vi.stubEnv('GIT_DIR', parentGitDir);
    vi.stubEnv('GIT_WORK_TREE', process.cwd());
    vi.stubEnv('GIT_INDEX_FILE', path.join(process.cwd(), '.git', 'index'));

    const root = makeRepo();
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));

    expect(collectSourceRuntimeIssues(root, manifest)).toEqual([]);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: cleanGitEnv(),
    }).trim()).toBe(parentHead);
  });

  it('flags an imported module that exists but is untracked', () => {
    const root = makeRepo();
    writeFileSync(path.join(root, 'src/main.ts'), "import { connect } from './transport/connection.ts';\nimport { atomic } from './transport/atomic-auth-save.ts';\nconnect();\natomic();\n", 'utf8');
    writeFileSync(path.join(root, 'src/transport/connection.ts'), "import { helper } from './helper.ts';\nimport { atomic } from './atomic-auth-save.ts';\nexport function connect() { return helper() + atomic(); }\n", 'utf8');
    writeFileSync(path.join(root, 'src/transport/atomic-auth-save.ts'), "export function atomic() { return 'atomic'; }\n", 'utf8');
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));
    const issues = collectSourceRuntimeIssues(root, manifest);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'file-dirty', path: 'src/main.ts' }),
      expect.objectContaining({ kind: 'file-dirty', path: 'src/transport/connection.ts' }),
      expect.objectContaining({
        kind: 'file-untracked',
        path: 'src/transport/atomic-auth-save.ts',
        importers: expect.arrayContaining([
          { importedBy: 'src/main.ts', specifier: './transport/atomic-auth-save.ts' },
          { importedBy: 'src/transport/connection.ts', specifier: './atomic-auth-save.ts' },
        ]),
      }),
    ]));
    expect(issues.filter((issue) => issue.kind === 'file-untracked' && issue.path === 'src/transport/atomic-auth-save.ts')).toHaveLength(1);
  });

  it('flags a missing imported module before launchd can discover it by crash-looping', () => {
    const root = makeRepo();
    writeFileSync(path.join(root, 'src/transport/connection.ts'), "import { missing } from './factory.ts';\nexport function connect() { return missing(); }\n", 'utf8');
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));

    expect(collectSourceRuntimeIssues(root, manifest)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'import-missing',
        path: 'src/transport/factory.ts',
        importedBy: 'src/transport/connection.ts',
        specifier: './factory.ts',
      }),
    ]));
  });

  it('flags staged-but-uncommitted runtime files', () => {
    const root = makeRepo();
    writeFileSync(path.join(root, 'src/transport/helper.ts'), "export function helper() { return 'changed'; }\n", 'utf8');
    execGit(root, ['add', 'src/transport/helper.ts']);
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));

    expect(collectSourceRuntimeIssues(root, manifest)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'file-staged', path: 'src/transport/helper.ts' }),
    ]));
  });

  it('exits nonzero and emits JSON for drift', () => {
    const root = makeRepo();
    writeFileSync(path.join(root, 'src/transport/helper.ts'), "export function helper() { return 'changed'; }\n", 'utf8');
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => { messages.push(String(value)); };
    try {
      const issues = run(['--manifest', 'manifest.json', '--json'], root);
      expect(issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'file-dirty', path: 'src/transport/helper.ts' }),
      ]));
      expect(JSON.parse(messages.join('\n')).ok).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally {
      console.log = originalLog;
    }
  });

  it('rejects unsafe manifest paths', () => {
    expect(() => parseSourceRuntimeManifest({
      schemaVersion: 1,
      entrypoints: [{ path: '../outside.ts' }],
    })).toThrow(/repo-relative/);
  });

  it('flags non-regular runtime files', () => {
    const root = makeRepo();
    rmSync(path.join(root, 'src/transport/helper.ts'));
    mkdirSync(path.join(root, 'src/transport/helper.ts'));
    chmodSync(path.join(root, 'src/transport/helper.ts'), 0o755);
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));

    expect(collectSourceRuntimeIssues(root, manifest)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'file-kind', path: 'src/transport/helper.ts' }),
    ]));
  });
});
