import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const policyPath = join(repoRoot, 'deploy/lib/python-lock-policy.sh');
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-python-policy-'));
  roots.push(root);
  return root;
}

function executable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
}

function runPolicy(body: string, env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('/bin/bash', ['-c', `. "${policyPath}"\n${body}`], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Python lock runtime policy', () => {
  it('accepts only the qualified CPython 3.13.16 runtime', () => {
    const root = tempRoot();
    const python = join(root, 'python');
    executable(python, [
      'if [ "$1" = "-c" ]; then printf "%s\\n" "cpython:3.13.16"; exit 0; fi',
      'exit 2',
    ].join('\n'));

    const result = runPolicy(`whatsoup_require_locked_python "${python}"`);

    expect(result.status, result.stderr).toBe(0);
  });

  it('fails closed when the runtime patch differs from the lock qualification', () => {
    const root = tempRoot();
    const python = join(root, 'python');
    executable(python, [
      'if [ "$1" = "-c" ]; then printf "%s\\n" "cpython:3.13.15"; exit 0; fi',
      'exit 2',
    ].join('\n'));

    const result = runPolicy(`whatsoup_require_locked_python "${python}"`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CPython 3.13.16');
  });

  it('selects the declared lock for the native platform and architecture', () => {
    const root = tempRoot();
    const bin = join(root, 'bin');
    const uname = join(bin, 'uname');
    mkdirSync(join(root, 'requirements/python'), { recursive: true });
    writeFileSync(join(root, 'requirements/python/.keep'), '', { encoding: 'utf8', flag: 'w' });
    executable(uname, [
      'case "$1" in',
      '  -s) printf "%s\\n" Darwin ;;',
      '  -m) printf "%s\\n" arm64 ;;',
      '  *) exit 2 ;;',
      'esac',
    ].join('\n'));

    const result = runPolicy(`whatsoup_python_lock_path "${root}" transcription`, { PATH: bin });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`${root}/requirements/python/transcription-cpython313-darwin-arm64.txt`);
  });

  it('installs from the selected lock with hashes, binary-only artifacts, and the controlled index', () => {
    const root = tempRoot();
    const bin = join(root, 'bin');
    const python = join(bin, 'python');
    const log = join(root, 'pip-args');
    mkdirSync(join(root, 'requirements/python'), { recursive: true });
    writeFileSync(join(root, 'requirements/python/quality-cpython313-linux-x64.txt'), 'pytest==8.3.5 --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', 'utf8');
    executable(join(bin, 'uname'), [
      'case "$1" in',
      '  -s) printf "%s\\n" Linux ;;',
      '  -m) printf "%s\\n" x86_64 ;;',
      '  *) exit 2 ;;',
      'esac',
    ].join('\n'));
    executable(python, [
      'if [ "$1" = "-c" ]; then printf "%s\\n" "cpython:3.13.16"; exit 0; fi',
      'printf "%s\\n" "$*" > "$WHATSOUP_TEST_PIP_ARGS"',
    ].join('\n'));

    const result = runPolicy(`whatsoup_install_locked_requirements "${python}" "${root}" quality`, {
      PATH: bin,
      WHATSOUP_TEST_PIP_ARGS: log,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('--require-hashes');
    expect(readFileSync(log, 'utf8')).toContain('--only-binary :all:');
    expect(readFileSync(log, 'utf8')).toContain('--index-url https://pypi.org/simple');
    expect(readFileSync(log, 'utf8')).toContain('quality-cpython313-linux-x64.txt');
  });
});
