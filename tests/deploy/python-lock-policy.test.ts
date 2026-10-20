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
  it.each(['lock', 'host'])('ignores ambient startup hooks during the %s identity check', (surface) => {
    const root = tempRoot();
    const marker = join(root, 'startup-ran');
    const python = process.env.WHATSOUP_TEST_LOCKED_PYTHON || 'python3.13';
    writeFileSync(join(root, 'sitecustomize.py'), `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("executed")\n`);

    const command = surface === 'lock' ? 'whatsoup_require_locked_python "$LOCK_PYTHON"' : `
. "${join(repoRoot, 'deploy/lib/host-capabilities.sh')}"
CAP_PATH="$LOCK_PYTHON"
whatsoup_probe_python exact-cpython:3.13.16
test "$CAP_VERSION" = 3.13.16`;
    const result = runPolicy(command, {
      LOCK_PYTHON: python, PYTHONPATH: root,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('creates the managed environment without importing an ambient venv module', () => {
    const root = tempRoot();
    const marker = join(root, 'venv-module-ran');
    const target = join(root, 'managed');
    const python = process.env.WHATSOUP_TEST_LOCKED_PYTHON || 'python3.13';
    writeFileSync(join(root, 'venv.py'), `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("executed")\nraise RuntimeError("ambient venv")\n`);

    const result = runPolicy('whatsoup_create_managed_venv "$LOCK_PYTHON" "$TARGET_VENV"', {
      LOCK_PYTHON: python, TARGET_VENV: target, PYTHONPATH: root,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(target, 'pyvenv.cfg'))).toBe(true);
  });

  it('rejects an empty lock without importing an ambient pip module', () => {
    const root = tempRoot();
    const marker = join(root, 'pip-module-ran');
    const target = join(root, 'managed');
    const python = process.env.WHATSOUP_TEST_LOCKED_PYTHON || 'python3.13';
    const created = spawnSync(python, ['-I', '-m', 'venv', target], { encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);
    const managed = join(target, 'bin/python');
    mkdirSync(join(root, 'requirements/python'), { recursive: true });
    for (const platform of ['linux', 'darwin']) {
      for (const arch of ['x64', 'arm64']) {
        writeFileSync(join(root, `requirements/python/quality-cpython313-${platform}-${arch}.txt`), '# no packages\n');
      }
    }
    writeFileSync(join(root, 'pip.py'), `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("executed")\n`);

    const result = runPolicy('whatsoup_install_locked_requirements "$LOCK_PYTHON" "$LOCK_ROOT" quality', {
      LOCK_PYTHON: managed, LOCK_ROOT: root, PYTHONPATH: root,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('declared lock has no packages');
    expect(existsSync(marker)).toBe(false);
  });

  it('accepts only the qualified CPython 3.13.16 runtime', () => {
    const root = tempRoot();
    const python = join(root, 'python');
    executable(python, [
      '[ "$1" = "-I" ] || exit 2; shift',
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
      '[ "$1" = "-I" ] || exit 2; shift',
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

    const python = join(bin, 'python');
    executable(python, '[ "$1" != "-I" ] || shift; [ "$1" = "-c" ] || exit 2; printf arm64');
    const result = runPolicy(`whatsoup_python_lock_path "${root}" transcription "${python}"`, { PATH: `${bin}:/usr/bin:/bin` });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`${root}/requirements/python/transcription-cpython313-darwin-arm64.txt`);
  });

  it('installs from the selected lock with hashes, binary-only artifacts, and the controlled index', () => {
    const root = tempRoot();
    const bin = join(root, 'bin');
    const python = join(bin, 'python');
    const log = join(root, 'pip-args');
    const snapshot = join(root, 'validated-bytes');
    const lock = join(root, 'requirements/python/quality-cpython313-linux-x64.txt');
    const valid = 'pytest==8.3.5 --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n';
    mkdirSync(join(root, 'requirements/python'), { recursive: true });
    writeFileSync(lock, valid, 'utf8');
    executable(join(bin, 'uname'), [
      'case "$1" in',
      '  -s) printf "%s\\n" Linux ;;',
      '  -m) printf "%s\\n" x86_64 ;;',
      '  *) exit 2 ;;',
      'esac',
    ].join('\n'));
    executable(python, [
      '[ "$1" != "-I" ] || shift',
      'if [ "$1" = "-c" ]; then case "$2" in *platform.machine*) printf x86_64 ;; *sys.implementation*) printf "%s\\n" "cpython:3.13.16" ;; *) exec "$REAL_PYTHON" -I "$@" ;; esac; exit 0; fi',
      'printf "%s\\n" "$*" > "$WHATSOUP_TEST_PIP_ARGS"',
      'while [ "$1" != "-r" ]; do shift; done',
      'printf "%s\\n" "--extra-index-url https://changed.invalid/simple" > "$SOURCE_LOCK"',
      'cat "$2" > "$VALIDATED_BYTES"',
    ].join('\n'));

    const result = runPolicy(`whatsoup_install_locked_requirements "${python}" "${root}" quality`, {
      PATH: `${bin}:${process.env.PATH}`,
      WHATSOUP_TEST_PIP_ARGS: log,
      REAL_PYTHON: resolveTestPython(), SOURCE_LOCK: lock, VALIDATED_BYTES: snapshot,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('--require-hashes');
    expect(readFileSync(log, 'utf8')).toContain('--only-binary :all:');
    expect(readFileSync(log, 'utf8')).toContain('--index-url https://pypi.org/simple');
    expect(readFileSync(log, 'utf8')).toContain('quality-cpython313-linux-x64.txt');
    expect(readFileSync(snapshot, 'utf8')).toBe(valid);
    expect(readFileSync(lock, 'utf8')).toContain('https://changed.invalid/simple');
    expect(existsSync(readFileSync(log, 'utf8').trim().split(' -r ')[1]!)).toBe(false);
  });

  it.each([
    ['external index', '--extra-index-url https://packages.invalid/simple\n'],
    ['nested requirements', '-r other.txt\n'],
    ['direct URL', 'pytest @ https://packages.invalid/pytest.whl\n'],
    ['missing hash', 'pytest==8.3.5\n'],
    ['empty lock', '# no packages\n'],
    ['lock symlink', 'symlink'],
    ['parent symlink', 'parent-symlink'],
  ])('rejects %s before pip starts', (_name, content) => {
    const root = tempRoot();
    const lockDirectory = join(root, 'requirements/python');
    const lock = join(lockDirectory, 'quality-cpython313-linux-x64.txt');
    const bin = join(root, 'bin');
    const marker = join(root, 'pip-started');
    const python = join(bin, 'python');
    const realPython = process.env.WHATSOUP_TEST_LOCKED_PYTHON || 'python3.13';
    const valid = `pytest==8.3.5 --hash=sha256:${'a'.repeat(64)}\n`;
    mkdirSync(dirname(lockDirectory), { recursive: true });
    if (content === 'parent-symlink') {
      const outside = join(root, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, lockDirectory);
    } else {
      mkdirSync(lockDirectory);
    }
    if (content === 'symlink') {
      const outside = join(root, 'outside.txt');
      writeFileSync(outside, valid);
      symlinkSync(outside, lock);
    } else {
      writeFileSync(lock, content === 'parent-symlink' ? valid : content);
    }
    executable(join(bin, 'uname'), 'case "$1" in -s) printf Linux ;; *) exit 2 ;; esac');
    executable(python, `[ "$1" = "-I" ] || exit 2
shift
if [ "$1" = "-c" ]; then
  case "$2" in
    *sys.implementation*) printf '%s\\n' cpython:3.13.16 ;;
    *platform.machine*) printf x86_64 ;;
    *) exec "$REAL_PYTHON" -I "$@" ;;
  esac
  exit 0
fi
printf started > "$PIP_MARKER"`);
    const result = runPolicy('whatsoup_install_locked_requirements "$LOCK_PYTHON" "$LOCK_ROOT" quality', {
      PATH: `${bin}:${process.env.PATH}`, LOCK_PYTHON: python, LOCK_ROOT: root,
      REAL_PYTHON: realPython, PIP_MARKER: marker,
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe(content === 'symlink' || content === 'parent-symlink' ? valid : content);
  });

  it.each([
    { architecture: 'x86_64', target: 'x64' },
    { architecture: 'arm64', target: 'arm64' },
  ])('uses the $architecture interpreter lock on an ARM-capable Mac', ({ architecture, target }) => {
    const root = tempRoot();
    const bin = join(root, 'bin');
    const python = join(bin, 'python');
    const log = join(root, 'pip-args');
    mkdirSync(join(root, 'requirements/python'), { recursive: true });
    for (const arch of ['x64', 'arm64']) {
      writeFileSync(join(root, `requirements/python/quality-cpython313-darwin-${arch}.txt`), `pytest==8.3.5 --hash=sha256:${'a'.repeat(64)}\n`);
    }
    executable(join(bin, 'uname'), 'case "$1" in -s) printf Darwin ;; -m) printf x86_64 ;; *) exit 2 ;; esac');
    executable(join(bin, 'sysctl'), 'printf 1');
    executable(python, `
[ "$1" != "-I" ] || shift
if [ "$1" = "-c" ]; then
  case "$2" in
    *platform.machine*) printf '%s\\n' "$TEST_PYTHON_ARCH" ;;
    *sys.implementation*) printf '%s\\n' 'cpython:3.13.16' ;;
    *) exec "$REAL_PYTHON" -I "$@" ;;
  esac
  exit 0
fi
[ "$1" = "-m" ] && [ "$2" = pip ] || exit 2
printf '%s\\n' "$*" > "$WHATSOUP_TEST_PIP_ARGS"
`);

    const result = runPolicy(`whatsoup_install_locked_requirements "${python}" "${root}" quality`, {
      PATH: `${bin}:${process.env.PATH}`, TEST_PYTHON_ARCH: architecture, WHATSOUP_TEST_PIP_ARGS: log,
      REAL_PYTHON: resolveTestPython(),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain(`quality-cpython313-darwin-${target}.txt`);
  });

  it.each(['unsupported', 'probe-failed'])('refuses pip when interpreter architecture is %s', (condition) => {
    const root = tempRoot();
    const bin = join(root, 'bin');
    const python = join(bin, 'python');
    const log = join(root, 'pip-args');
    mkdirSync(join(root, 'requirements/python'), { recursive: true });
    writeFileSync(join(root, 'requirements/python/quality-cpython313-linux-x64.txt'), '# fixture lock\n');
    executable(join(bin, 'uname'), 'case "$1" in -s) printf Linux ;; -m) printf x86_64 ;; *) exit 2 ;; esac');
    executable(python, `
[ "$1" != "-I" ] || shift
if [ "$1" = "-c" ]; then
  case "$2" in
    *platform.machine*) [ "$TEST_PYTHON_ARCH" != probe-failed ] || exit 7; printf '%s\\n' riscv64 ;;
    *sys.implementation*) printf '%s\\n' 'cpython:3.13.16' ;;
    *) exit 2 ;;
  esac
  exit 0
fi
printf '%s\\n' "$*" > "$WHATSOUP_TEST_PIP_ARGS"
`);

    const result = runPolicy(`whatsoup_install_locked_requirements "${python}" "${root}" quality`, {
      PATH: `${bin}:/usr/bin:/bin`, TEST_PYTHON_ARCH: condition, WHATSOUP_TEST_PIP_ARGS: log,
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(log)).toBe(false);
  });

  it('does not execute an ambient platform module while selecting the interpreter lock', () => {
    const root = tempRoot();
    const marker = join(root, 'ambient-module-ran');
    const python = process.env.WHATSOUP_TEST_LOCKED_PYTHON || 'python3.13';
    writeFileSync(join(root, 'platform.py'), `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("executed")\nraise RuntimeError("ambient module must not run")\n`);

    const result = runPolicy('whatsoup_python_lock_path "$LOCK_ROOT" quality "$LOCK_PYTHON"', {
      LOCK_ROOT: repoRoot, LOCK_PYTHON: python, PYTHONPATH: root,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(result.stdout.trim())).toBe(true);
  });

  it.each([
    { name: 'lock identity', command: 'whatsoup_require_locked_python "$HANG_PYTHON"', status: 1, output: '' },
    { name: 'lock architecture', command: 'whatsoup_python_lock_target "$HANG_PYTHON"', status: 1, output: '' },
    {
      name: 'host identity',
      command: `. "${join(repoRoot, 'deploy/lib/host-capabilities.sh')}"
CAP_PATH="$HANG_PYTHON"
whatsoup_probe_python exact-cpython:3.13.16
printf '%s:%s' "$CAP_STATUS" "$CAP_DETAIL"`,
      status: 0,
      output: 'inconclusive:python-identity-probe-failed',
    },
  ])('bounds the $name probe and reaps its hung interpreter', ({ command, status, output }) => {
    const root = tempRoot();
    const python = join(root, 'hung-python');
    const pidFile = join(root, 'interpreter-pid');
    executable(python, 'printf "%s" "$$" > "$HANG_PID_FILE"\nexec /bin/sleep 8');

    const result = spawnSync('/bin/bash', ['-c', `. "${policyPath}"\n${command}`], {
      cwd: repoRoot,
      env: { ...process.env, HANG_PYTHON: python, HANG_PID_FILE: pidFile, WHATSOUP_PYTHON_PROBE_TIMEOUT: '1' },
      encoding: 'utf8',
      timeout: 4500,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(status);
    expect(result.stdout.trim()).toBe(output);
    const pid = readFileSync(pidFile, 'utf8').trim();
    expect(pid).toMatch(/^[0-9]+$/);
    expect(spawnSync('/bin/kill', ['-0', pid]).status).not.toBe(0);
  });

  it.each([false, true])('excludes pip configuration with inherited environment options=%s using the real pip parser', (withEnvironment) => {
    const root = tempRoot();
    const python = process.env.WHATSOUP_TEST_LOCKED_PYTHON || 'python3.13';
    const shim = join(root, 'python');
    const config = join(root, 'pip.conf');
    const parser = join(root, 'parse-pip.py');
    writeFileSync(config, '[global]\nextra-index-url = https://config.invalid/simple\nfind-links = /config-wheels\n');
    writeFileSync(parser, `
import ensurepip, glob, json, os, pathlib, sys
sys.path.insert(0, glob.glob(str(pathlib.Path(ensurepip.__file__).parent / "_bundled/pip-*.whl"))[0])
from pip._internal.cli.main_parser import parse_command
from pip._internal.commands import create_command
name, args = parse_command(sys.argv[1:])
command = create_command(name, isolated="--isolated" in args)
options, _ = command.parse_args(args)
print(json.dumps({"index": options.index_url, "extra": options.extra_index_urls, "links": options.find_links, "config": os.environ.get("PIP_CONFIG_FILE"), "isolated": "--isolated" in args}))
`);
    executable(shim, `[ "$1" = "-I" ] || exit 2
shift
if [ "$1" = "-c" ]; then exec "$REAL_PYTHON" -I "$@"; fi
if [ "$1" != "-m" ] || [ "$2" != "pip" ]; then exit 2; fi
shift 2
exec "$REAL_PYTHON" -I "$PIP_PARSER" "$@"`);
    const result = runPolicy(`whatsoup_install_locked_requirements "${shim}" "${repoRoot}" quality`, {
      REAL_PYTHON: python,
      PIP_PARSER: parser,
      PIP_CONFIG_FILE: config,
      PIP_EXTRA_INDEX_URL: withEnvironment ? 'https://environment.invalid/simple' : '',
      PIP_FIND_LINKS: withEnvironment ? '/environment-wheels' : '',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      index: 'https://pypi.org/simple', extra: [], links: [], config: '/dev/null', isolated: true,
    });
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
    executable(failing, `[ "$1" != "-I" ] || shift
if [ "$1" = "-c" ]; then exec "$REAL_PYTHON" -I "$@"; fi
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
