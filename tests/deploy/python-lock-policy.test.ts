import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveTestPython } from '../helpers/python-interpreter.ts';

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


describe('managed Python environment replacement', () => {
  function existingEnvironment(root: string, python = resolveTestPython()): { python: string; target: string; hook: string; marker: string } {
    const target = join(root, 'managed-venv');
    const created = spawnSync(python, ['-m', 'venv', '--without-pip', target], { encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);
    const site = spawnSync(join(target, 'bin/python'), ['-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'], { encoding: 'utf8' });
    expect(site.status, site.stderr).toBe(0);
    const marker = join(root, 'old-hook-executed');
    const hook = join(site.stdout.trim(), 'old-unlocked.pth');
    writeFileSync(hook, `import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text("executed")\n`);
    return { python, target, hook, marker };
  }

  it('replaces real CPython 3.12 launchers with the locked 3.13.16 runtime and retains prior artifacts', () => {
    const root = tempRoot();
    const legacy = process.env.WHATSOUP_TEST_LEGACY_PYTHON || 'python3.12';
    const replacement = process.env.WHATSOUP_TEST_LOCKED_PYTHON || 'python3.13';
    const legacyProbe = spawnSync(legacy, ['-I', '-c', 'import sys; print(f"{sys.implementation.name}:{sys.version_info.major}.{sys.version_info.minor}")'], { encoding: 'utf8' });
    expect(legacyProbe.status, legacyProbe.stderr).toBe(0);
    expect(legacyProbe.stdout.trim()).toBe('cpython:3.12');
    const { target, hook, marker } = existingEnvironment(root, legacy);
    const priorHook = readFileSync(hook);
    const priorConfig = readFileSync(join(target, 'pyvenv.cfg'));
    const result = runPolicy('whatsoup_create_managed_venv "$BASE_PYTHON" "$TARGET_VENV"', {
      BASE_PYTHON: replacement,
      TARGET_VENV: target,
    });
    expect(result.status, result.stderr).toBe(0);
    for (const launcher of ['python', 'python3']) {
      const probe = spawnSync(join(target, 'bin', launcher), ['-I', '-c', 'import json, sys; print(json.dumps({"implementation": sys.implementation.name, "version": list(sys.version_info[:3]), "prefix": sys.prefix}))'], { encoding: 'utf8' });
      expect(probe.status, probe.stderr).toBe(0);
      expect(JSON.parse(probe.stdout)).toEqual({ implementation: 'cpython', version: [3, 13, 16], prefix: target });
    }
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(hook)).toBe(false);
    const backups = readdirSync(root).filter((name) => name.startsWith('managed-venv.previous.'));
    expect(backups).toHaveLength(1);
    const retained = join(root, backups[0]!, 'environment');
    expect(readFileSync(join(retained, hook.slice(target.length + 1)))).toEqual(priorHook);
    expect(readFileSync(join(retained, 'pyvenv.cfg'))).toEqual(priorConfig);
  }, 20_000);

  it('restores the previous environment and retains partial creation after a creation failure', () => {
    const root = tempRoot();
    const { python, target, hook, marker } = existingEnvironment(root);
    const failing = join(root, 'failing-python');
    executable(failing, `if [ "$1" = "-c" ]; then exec "$REAL_PYTHON" "$@"; fi
mkdir -p "$3"
printf partial > "$3/partial"
exit 7`);
    const prior = readFileSync(hook);
    const result = runPolicy(`
WHATSOUP_LOCKED_PYTHON_VERSION="$($REAL_PYTHON -c 'import platform; print(platform.python_version())')"
whatsoup_create_managed_venv "$BASE_PYTHON" "$TARGET_VENV"
`, { BASE_PYTHON: failing, REAL_PYTHON: python, TARGET_VENV: target });
    expect(result.status).not.toBe(0);
    expect(readFileSync(hook)).toEqual(prior);
    expect(existsSync(marker)).toBe(false);
    const backups = readdirSync(root).filter((name) => name.startsWith('managed-venv.previous.'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(root, backups[0]!, 'failed-environment', 'partial'), 'utf8')).toBe('partial');
  });

  it('refuses a symlink to a recognized environment without moving it', () => {
    const root = tempRoot();
    const { python, target, hook } = existingEnvironment(root);
    const link = join(root, 'linked-venv');
    symlinkSync(target, link);
    const result = runPolicy('whatsoup_create_managed_venv "$BASE_PYTHON" "$TARGET_VENV"', { BASE_PYTHON: python, TARGET_VENV: link });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing unrecognized managed environment');
    expect(readFileSync(join(link, hook.slice(target.length + 1)))).toEqual(readFileSync(hook));
    expect(readdirSync(root).filter((name) => name.includes('.previous.'))).toEqual([]);
  });

  it('retains an unrecognized nonempty directory without running the interpreter', () => {
    const root = tempRoot();
    const target = join(root, 'not-a-venv');
    mkdirSync(target);
    writeFileSync(join(target, 'unique-work'), 'retain');
    const result = runPolicy('whatsoup_create_managed_venv /nonexistent/python "$TARGET_VENV"', { TARGET_VENV: target });
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(target, 'unique-work'), 'utf8')).toBe('retain');
    expect(readdirSync(root)).toEqual(['not-a-venv']);
  });
});
