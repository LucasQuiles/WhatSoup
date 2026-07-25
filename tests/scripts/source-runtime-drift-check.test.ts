import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

function runGit(cwd: string, args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
} {
  const proc = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: cleanGitEnv(),
  });
  return {
    status: proc.status,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    error: proc.error?.message,
  };
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

  it('loads Git state with a constant number of bulk commands across a diamond import graph', () => {
    const root = makeRepo();
    writeFileSync(
      path.join(root, 'src/main.ts'),
      "import './left.ts';\nimport './right.ts';\nexport const connect = true;\n",
      'utf8',
    );
    writeFileSync(path.join(root, 'src/left.ts'), "import './shared.ts';\n", 'utf8');
    writeFileSync(path.join(root, 'src/right.ts'), "import './shared.ts';\n", 'utf8');
    writeFileSync(path.join(root, 'src/shared.ts'), "export const shared = true;\n", 'utf8');
    execGit(root, ['add', 'src/main.ts', 'src/left.ts', 'src/right.ts', 'src/shared.ts']);
    execGit(root, ['commit', '-qm', 'diamond']);
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));
    const calls: string[][] = [];

    expect(collectSourceRuntimeIssues(root, manifest, {
      git: (cwd, args) => {
        calls.push(args);
        return runGit(cwd, args);
      },
    })).toEqual([]);
    expect(calls).toEqual([
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'],
      ['ls-files', '-z'],
      ['ls-tree', '-r', '--name-only', '-z', 'HEAD'],
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'],
    ]);
  });

  it('fails closed when a tracked runtime file changes during graph traversal', () => {
    const root = makeRepo();
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));
    let calls = 0;

    const issues = collectSourceRuntimeIssues(root, manifest, {
      git: (cwd, args) => {
        calls += 1;
        const result = runGit(cwd, args);
        if (calls === 3) {
          writeFileSync(
            path.join(root, 'src/main.ts'),
            "import { connect } from './transport/connection.ts';\nconnect();\n// concurrent edit\n",
            'utf8',
          );
        }
        return result;
      },
    });

    expect(calls).toBe(4);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'file-dirty', path: 'src/main.ts' }),
    ]));
  });

  it('fails closed when HEAD changes during graph traversal', () => {
    const root = makeRepo();
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));
    let calls = 0;

    const issues = collectSourceRuntimeIssues(root, manifest, {
      git: (cwd, args) => {
        calls += 1;
        const result = runGit(cwd, args);
        if (calls === 3) {
          writeFileSync(
            path.join(root, 'src/main.ts'),
            "import { connect } from './transport/connection.ts';\nconnect();\n// concurrent commit\n",
            'utf8',
          );
          execGit(root, ['add', 'src/main.ts']);
          execGit(root, ['commit', '-qm', 'concurrent']);
        }
        return result;
      },
    });

    expect(calls).toBe(4);
    expect(issues).toEqual([
      expect.objectContaining({
        kind: 'git-error',
        message: expect.stringContaining('HEAD changed during inspection'),
      }),
    ]);
  });

  it('flags an inspected runtime path renamed during graph traversal', () => {
    const root = makeRepo();
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));
    let calls = 0;

    const issues = collectSourceRuntimeIssues(root, manifest, {
      git: (cwd, args) => {
        calls += 1;
        if (calls === 4) {
          execGit(root, ['mv', 'src/main.ts', 'src/renamed.ts']);
        }
        return runGit(cwd, args);
      },
    });

    expect(calls).toBe(4);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'file-staged', path: 'src/main.ts' }),
    ]));
  });

  it('fails closed when a bulk Git snapshot command fails', () => {
    const root = makeRepo();
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));

    const issues = collectSourceRuntimeIssues(root, manifest, {
      git: (cwd, args) => args[0] === 'ls-tree'
        ? { status: 2, stdout: '', stderr: 'synthetic ls-tree failure' }
        : runGit(cwd, args),
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'git-error',
        message: expect.stringContaining('synthetic ls-tree failure'),
      }),
    ]));
    expect(issues.filter((issue) => issue.kind !== 'git-error')).toEqual([]);
  });

  it('fails closed when final bulk Git verification fails', () => {
    const root = makeRepo();
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));
    let calls = 0;

    const issues = collectSourceRuntimeIssues(root, manifest, {
      git: (cwd, args) => {
        calls += 1;
        return calls === 4
          ? { status: 2, stdout: '', stderr: 'synthetic final diff failure' }
          : runGit(cwd, args);
      },
    });

    expect(issues).toEqual([
      expect.objectContaining({
        kind: 'git-error',
        message: expect.stringContaining('synthetic final diff failure'),
      }),
    ]);
  });

  it('fails closed on an unsupported non-header porcelain record', () => {
    const root = makeRepo();
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));
    let injected = false;

    const issues = collectSourceRuntimeIssues(root, manifest, {
      git: (cwd, args) => {
        const result = runGit(cwd, args);
        if (!injected && args[0] === 'status') {
          injected = true;
          return { ...result, stdout: `${result.stdout}x unsupported-porcelain-record\0` };
        }
        return result;
      },
    });

    expect(issues).toEqual([
      expect.objectContaining({
        kind: 'git-error',
        message: expect.stringContaining('unsupported porcelain record'),
      }),
    ]);
  });

  it.each(Array.from({ length: 23 }, (_, index) => index + 41))(
    'fails closed on a %i-character branch object ID',
    (width) => {
      const root = makeRepo();
      const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));

      const issues = collectSourceRuntimeIssues(root, manifest, {
        git: (cwd, args) => {
          const result = runGit(cwd, args);
          return args[0] === 'status'
            ? {
                ...result,
                stdout: result.stdout.replace(
                  /# branch\.oid [^\0]+\0/,
                  `# branch.oid ${'a'.repeat(width)}\0`,
                ),
              }
            : result;
        },
      });

      expect(issues).toEqual([
        expect.objectContaining({
          kind: 'git-error',
          message: expect.stringContaining('invalid branch object ID'),
        }),
      ]);
    },
  );

  it('accepts an exact 64-character branch object ID', () => {
    const root = makeRepo();
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));

    const issues = collectSourceRuntimeIssues(root, manifest, {
      git: (cwd, args) => {
        const result = runGit(cwd, args);
        return args[0] === 'status'
          ? {
              ...result,
              stdout: result.stdout.replace(
                /# branch\.oid [^\0]+\0/,
                `# branch.oid ${'a'.repeat(64)}\0`,
              ),
            }
          : result;
      },
    });

    expect(issues).toEqual([]);
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

  it('flags a staged new imported module as uncommitted and staged, not untracked', () => {
    const root = makeRepo();
    const modulePath = 'src/transport/staged-new.ts';
    writeFileSync(
      path.join(root, 'src/main.ts'),
      "import { connect } from './transport/connection.ts';\nimport { stagedNew } from './transport/staged-new.ts';\nconnect();\nstagedNew();\n",
      'utf8',
    );
    writeFileSync(path.join(root, modulePath), "export function stagedNew() { return 'staged'; }\n", 'utf8');
    execGit(root, ['add', 'src/main.ts', modulePath]);
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));

    const issues = collectSourceRuntimeIssues(root, manifest);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'file-uncommitted',
        path: modulePath,
        importedBy: 'src/main.ts',
        specifier: './transport/staged-new.ts',
      }),
      expect.objectContaining({ kind: 'file-staged', path: modulePath }),
    ]));
    expect(issues.filter((item) => item.kind === 'file-untracked' && item.path === modulePath)).toEqual([]);
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

  it('canonicalizes accepted repo-relative manifest paths before Git classification', () => {
    const root = makeRepo();
    const manifest = parseSourceRuntimeManifest({
      schemaVersion: 1,
      scope: 'test',
      entrypoints: [{ path: './src/main.ts', mustContain: ['connect'], importGraph: true }],
    });

    expect(manifest.entrypoints[0]?.path).toBe('src/main.ts');
    expect(collectSourceRuntimeIssues(root, manifest)).toEqual([]);
  });

  it('rejects duplicate manifest paths after canonicalization', () => {
    expect(() => parseSourceRuntimeManifest({
      schemaVersion: 1,
      entrypoints: [
        { path: 'src/main.ts' },
        { path: './src/main.ts' },
      ],
    })).toThrow(/duplicate entrypoint src\/main\.ts/);
  });

  it('returns a structured issue without reading an import outside the repository', () => {
    const root = makeRepo();
    const outsideName = `whatsoup-outside-${path.basename(root)}.ts`;
    const outsidePath = path.join(root, '..', outsideName);
    mkdirSync(outsidePath);
    writeFileSync(path.join(root, 'src/main.ts'), `import '../../${outsideName}';\nexport const connect = true;\n`, 'utf8');
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));

    try {
      expect(collectSourceRuntimeIssues(root, manifest)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'import-outside-repo',
          path: `../${outsideName}`,
          importedBy: 'src/main.ts',
          specifier: `../../${outsideName}`,
        }),
      ]));
    } finally {
      rmSync(outsidePath, { recursive: true, force: true });
    }
  });

  it('does not read or expand an import reached through a directory symlink outside the repository', () => {
    const root = makeRepo();
    const outsideRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-source-runtime-outside-'));
    const symlinkPath = path.join(root, 'src/transport/outside');
    writeFileSync(
      path.join(outsideRoot, 'payload.ts'),
      "import './expanded.ts';\nexport const payload = true;\n",
      'utf8',
    );
    writeFileSync(path.join(outsideRoot, 'expanded.ts'), 'export const expanded = true;\n', 'utf8');
    symlinkSync(outsideRoot, symlinkPath, 'dir');
    writeFileSync(
      path.join(root, 'src/main.ts'),
      "import './transport/outside/payload.ts';\nexport const connect = true;\n",
      'utf8',
    );
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));

    try {
      const issues = collectSourceRuntimeIssues(root, manifest);

      expect(issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'import-outside-repo',
          path: 'src/transport/outside/payload.ts',
          importedBy: 'src/main.ts',
          specifier: './transport/outside/payload.ts',
        }),
      ]));
      expect(issues.some((item) => item.path === 'src/transport/outside/expanded.ts')).toBe(false);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('allows a tracked file symlink whose real target remains inside the repository', () => {
    const root = makeRepo();
    mkdirSync(path.join(root, 'src/shared'));
    writeFileSync(
      path.join(root, 'src/shared/helper.ts'),
      "import { value } from './value.ts';\nexport function helper() { return value; }\n",
      'utf8',
    );
    writeFileSync(path.join(root, 'src/shared/value.ts'), "export const value = 'ok';\n", 'utf8');
    const symlinkPath = path.join(root, 'src/transport/helper-link.ts');
    symlinkSync('../shared/helper.ts', symlinkPath);
    writeFileSync(
      path.join(root, 'src/transport/connection.ts'),
      "import { helper } from './helper-link.ts';\nexport function connect() { return helper(); }\n",
      'utf8',
    );
    execGit(root, [
      'add',
      'src/shared/helper.ts',
      'src/shared/value.ts',
      'src/transport/connection.ts',
      'src/transport/helper-link.ts',
    ]);
    execGit(root, ['commit', '-qm', 'contained symlink']);
    const manifest = parseSourceRuntimeManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));

    expect(collectSourceRuntimeIssues(root, manifest)).toEqual([]);
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

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// Rewrites manifest.json in `root` with a pinned sha256 for src/main.ts computed
// from its current on-disk content, so a later edit to that file is guaranteed
// to drift the hash.
function pinMainSha256(root: string): string {
  const currentMain = readFileSync(path.join(root, 'src/main.ts'), 'utf8');
  const pinned = sha256Hex(currentMain);
  writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      scope: 'test',
      entrypoints: [{ path: 'src/main.ts', sha256: pinned, mustContain: ['connect'], importGraph: true }],
    }, null, 2),
    'utf8',
  );
  return currentMain;
}

describe('source runtime drift check --suggest', () => {
  it('mentions --suggest in the default failure message for a sha256 drift', () => {
    const root = makeRepo();
    const originalMain = pinMainSha256(root);
    writeFileSync(path.join(root, 'src/main.ts'), `${originalMain}// drift\n`, 'utf8');

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (value?: unknown) => { errors.push(String(value)); };
    try {
      const issues = run(['--manifest', 'manifest.json'], root);
      expect(issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'file-sha256-drift', path: 'src/main.ts' }),
      ]));
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('--suggest');
    } finally {
      console.error = originalError;
    }
  });

  it('--suggest prints the corrected path and sha256 without writing the manifest', () => {
    const root = makeRepo();
    const originalMain = pinMainSha256(root);
    const manifestPath = path.join(root, 'manifest.json');
    const manifestBytesBefore = readFileSync(manifestPath);
    const driftedMain = `${originalMain}// drift\n`;
    writeFileSync(path.join(root, 'src/main.ts'), driftedMain, 'utf8');
    const expectedNewSha256 = sha256Hex(driftedMain);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => { logs.push(String(value)); };
    try {
      run(['--manifest', 'manifest.json', '--suggest'], root);
      expect(process.exitCode).toBe(1);
      const output = logs.join('\n');
      expect(output).toContain('src/main.ts');
      expect(output).toContain(expectedNewSha256);
    } finally {
      console.log = originalLog;
    }

    expect(readFileSync(manifestPath).equals(manifestBytesBefore)).toBe(true);
  });

  it('--help usage text mentions --suggest', () => {
    expect(() => run(['--help'], process.cwd())).toThrow(/--suggest/);
  });
});
