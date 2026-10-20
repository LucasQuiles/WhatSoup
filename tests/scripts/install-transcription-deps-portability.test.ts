/**
 * Portability tests for scripts/install-transcription-deps.sh (#2256).
 *
 * The script previously assumed macOS-Homebrew-on-Apple-Silicon in four places
 * and aborted on Linux under `set -e`. These tests pin the two helpers that
 * carry the portability contract by executing them with a controlled PATH, so a
 * regression fails here rather than on an operator's Linux box.
 *
 * Shape follows tests/deploy/setup-platform.test.ts, which tests deploy/setup.sh
 * the same way — fake executables written into a temp dir that is prepended to
 * PATH, then the real shell source is sourced and the helper invoked.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'install-transcription-deps.sh');
const scriptSource = fs.readFileSync(scriptPath, 'utf8');
const lockPolicyPath = path.join(repoRoot, 'deploy', 'lib', 'python-lock-policy.sh');
const boundedSource = fs.readFileSync(path.join(repoRoot, 'deploy', 'lib', 'bounded-exec.sh'), 'utf8');
const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeExecutable(dir: string, name: string, body: string): void {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  fs.chmodSync(file, 0o755);
}

/**
 * Extract a shell function from the real script and run `body` against it.
 *
 * Extracting from the shipped source (rather than restating the function in the
 * test) is what makes these assertions able to fail: a change to the script is
 * seen here directly.
 */
function runWithHelpers(body: string, extraPath?: string, inheritPath = true): { status: number; stdout: string; stderr: string } {
  const helpers = ['sha256_of', 'resolve_python']
    .map((fn) => {
      const start = scriptSource.indexOf(`${fn}() {`);
      if (start === -1) throw new Error(`helper ${fn}() not found in install-transcription-deps.sh`);
      const end = scriptSource.indexOf('\n}\n', start);
      if (end === -1) throw new Error(`helper ${fn}() has no terminating brace`);
      return scriptSource.slice(start, end + 3);
    })
    .join('\n');
  const pathPrefix = extraPath ? `export PATH="${extraPath}${inheritPath ? ':$PATH' : ''}"\n` : '';
  const result = spawnSync('bash', ['-c', `set -uo pipefail\n${pathPrefix}. "${lockPolicyPath}"\n${helpers}\n${body}`], {
    encoding: 'utf8',
    cwd: repoRoot,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runVenvPreparationSnippet(): { status: number; marker: string; stderr: string } {
  const start = scriptSource.indexOf('if ! PYTHON_BIN="$(resolve_python)"; then');
  const end = scriptSource.indexOf('\n\nif ! sha256_matches', start);
  if (start === -1 || end === -1) throw new Error('venv preparation block not found');

  const root = makeTempRoot('itd-venv-upgrade-');
  const venv = path.join(root, 'transcription-venv');
  const marker = path.join(root, 'refreshed');
  const hostPython = path.join(root, 'python3.13');
  fs.mkdirSync(path.join(venv, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), 'home = legacy-runtime\n');
  writeExecutable(
    path.join(venv, 'bin'),
    'python',
    '#!/bin/sh\nif [ "$1" = "-c" ]; then printf \'%s\\n\' \'cpython:3.12.9\'; exit 0; fi\nexit 0\n',
  );
  writeExecutable(root, 'python3.13', `#!/bin/sh
if [ "$1" = "-c" ]; then printf '%s\n' 'cpython:3.13.16'; exit 0; fi
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  target="$3"
  mkdir -p "$target/bin"
  cat > "$target/bin/python" <<'PYTHON'
#!/bin/sh
if [ "$1" = "-c" ]; then printf '%s\\n' 'cpython:3.13.16'; exit 0; fi
exit 0
PYTHON
  chmod 755 "$target/bin/python"
  printf '%s\\n' refreshed > "$REFRESH_MARKER"
  exit 0
fi
exit 1
`);

  const snippet = scriptSource.slice(start, end);
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
HOST_PYTHON="$1"
VENV="$2"
REPO_ROOT="$3"
. "${lockPolicyPath}"
${scriptSource.slice(scriptSource.indexOf('install_transcription_requirements() {'), scriptSource.indexOf('\n}\n', scriptSource.indexOf('install_transcription_requirements() {')) + 3)}
resolve_python() { printf '%s\\n' "$HOST_PYTHON"; }
whatsoup_install_locked_requirements() { whatsoup_require_locked_python "$1"; }
${snippet}`,
      'venv-preparation-test',
      hostPython,
      venv,
      repoRoot,
    ],
    {
      encoding: 'utf8',
      cwd: repoRoot,
      env: { ...process.env, REFRESH_MARKER: marker },
    },
  );
  return { status: result.status ?? -1, marker, stderr: result.stderr ?? '' };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('install-transcription-deps.sh — source-level portability invariants', () => {
  it('does not hardcode an absolute Homebrew python path', () => {
    // The original defect: PYTHON_BIN="/opt/homebrew/bin/python@…", which does
    // not exist on Linux, Intel macOS, or a Mac without the matching formula.
    expect(scriptSource).not.toMatch(/PYTHON_BIN\s*=\s*"?\/opt\/homebrew/);
  });

  it.each([
    { budget: '0', brewStatus: 0, expectedStatus: 124, called: false },
    { budget: '10', brewStatus: 17, expectedStatus: 17, called: true },
  ])('bounds Homebrew with budget $budget and preserves its outcome', ({ budget, brewStatus, expectedStatus, called }) => {
    const root = makeTempRoot('itd-brew-bound-');
    const marker = path.join(root, 'brew-arguments');
    writeExecutable(root, 'brew', `#!/bin/sh\nprintf '%s\\n' "$@" > "$BREW_MARKER"\nexit ${brewStatus}\n`);
    const start = scriptSource.indexOf('if command -v brew >/dev/null 2>&1; then');
    const end = scriptSource.indexOf('\nif ! PYTHON_BIN=', start);
    if (start === -1 || end === -1) throw new Error('system dependency block not found');

    const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail\n${boundedSource}\n${scriptSource.slice(start, end)}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${root}:/usr/bin:/bin`,
        WHATSOUP_PKG_INSTALL_TIMEOUT: budget,
        BREW_MARKER: marker,
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(expectedStatus);
    expect(fs.existsSync(marker)).toBe(called);
    if (called) expect(fs.readFileSync(marker, 'utf8')).toBe('install\nffmpeg\nwhisper-cpp\npython@3.13\n');
  });

  it('prepends Homebrew bin dirs only when they exist', () => {
    expect(scriptSource).toMatch(/\[ -d "\$brew_bin" \]/);
  });
});

describe('install-transcription-deps.sh — sha256_of', () => {
  it('computes the same digest the platform tool does', () => {
    const root = makeTempRoot('itd-sha-');
    fs.writeFileSync(path.join(root, 'f'), 'hello', 'utf8');
    // sha256("hello"), assembled as a literal constant — this is a digest, not a
    // credential, and it is the whole point of the assertion.
    const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    const res = runWithHelpers(`sha256_of "${path.join(root, 'f')}"`);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(expected);
  });

  it('works on a system with NO shasum (the Linux/Alpine condition)', () => {
    // The original code called `shasum -a 256` unconditionally. shasum is a Perl
    // utility shipped with macOS and absent from minimal Linux images.
    const shim = makeTempRoot('itd-noshasum-');
    writeExecutable(shim, 'sha256sum', `#!${process.execPath}
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
process.stdout.write(createHash('sha256').update(readFileSync(process.argv[2])).digest('hex') + '  ' + process.argv[2] + '\\n');
`);
    const root = makeTempRoot('itd-sha2-');
    fs.writeFileSync(path.join(root, 'f'), 'hello', 'utf8');
    const res = runWithHelpers(`sha256_of "${path.join(root, 'f')}"`, shim, false);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('fails closed when the only available hash tool fails', () => {
    const shim = makeTempRoot('itd-broken-shasum-');
    writeExecutable(shim, 'shasum', '#!/bin/sh\nexit 127\n');
    const root = makeTempRoot('itd-broken-sha-');
    fs.writeFileSync(path.join(root, 'f'), 'hello', 'utf8');
    const res = runWithHelpers(`sha256_of "${path.join(root, 'f')}"`, shim, false);
    expect(res.status).not.toBe(0);
    expect(res.stdout.trim()).toBe('');
  });

  it('fails closed when neither hash tool is available', () => {
    const shim = makeTempRoot('itd-no-hash-tools-');
    const root = makeTempRoot('itd-no-hash-');
    fs.writeFileSync(path.join(root, 'f'), 'hello', 'utf8');
    const res = runWithHelpers(`sha256_of "${path.join(root, 'f')}"`, shim, false);
    expect(res.status).not.toBe(0);
    expect(res.stdout.trim()).toBe('');
    expect(res.stderr).toContain('Neither sha256sum nor shasum is available');
  });

  it('fails closed on a missing file rather than emitting an empty digest', () => {
    // An empty digest would compare unequal to every expected hash, so the model
    // would be deleted and re-downloaded on every run, forever, silently.
    const res = runWithHelpers('sha256_of /nonexistent/file');
    expect(res.status).not.toBe(0);
    expect(res.stdout.trim()).toBe('');
  });
});

describe('install-transcription-deps.sh — resolve_python', () => {
  it('skips an interpreter that cannot build a venv', () => {
    const shim = makeTempRoot('itd-badpy-');
    writeExecutable(shim, 'python3.13', '#!/bin/sh\nexit 1\n');
    const res = runWithHelpers('resolve_python', shim);
    // Either it finds a qualified runtime elsewhere on PATH, or it fails — but
    // it must never hand back the candidate that could not build a venv.
    if (res.status === 0) {
      expect(res.stdout.trim()).not.toBe(path.join(shim, 'python3.13'));
    }
  });

  it('honours a qualified WHATSOUP_TRANSCRIPTION_PYTHON override', () => {
    const shim = makeTempRoot('itd-qualified-py-');
    writeExecutable(shim, 'python3.13', [
      '#!/bin/sh',
      'case "$1" in',
      "  -c) case \"$2\" in *implementation*) printf '%s\\n' 'cpython:3.13.16' ;; *) exit 0 ;; esac ;;",
      'esac',
    ].join('\n'));
    const res = runWithHelpers(
      `WHATSOUP_TRANSCRIPTION_PYTHON="${path.join(shim, 'python3.13')}" resolve_python`,
      shim,
    );
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(path.join(shim, 'python3.13'));
  });

  it('fails closed when no candidate has the locked CPython identity', () => {
    const shim = makeTempRoot('itd-unqualified-py-');
    const unqualifiedPython = [
      '#!/bin/sh',
      'case "$1" in',
      "  -c) case \"$2\" in *implementation*) printf '%s\\n' 'cpython:3.13.15' ;; *) exit 0 ;; esac ;;",
      'esac',
    ].join('\n');
    writeExecutable(shim, 'python3.13', unqualifiedPython);
    writeExecutable(shim, 'python3', unqualifiedPython);
    const res = runWithHelpers(
      'WHATSOUP_TRANSCRIPTION_PYTHON=/nonexistent/python resolve_python',
      shim,
      false,
    );
    expect(res.status).not.toBe(0);
    expect(res.stdout.trim()).toBe('');
  });
});

describe('install-transcription-deps.sh — managed venv upgrades', () => {
  it('refreshes an existing venv with the qualified interpreter before the locked install', () => {
    const res = runVenvPreparationSnippet();
    expect(res.status, res.stderr).toBe(0);
    expect(fs.readFileSync(res.marker, 'utf8').trim()).toBe('refreshed');
  });
});

describe('install-transcription-deps.sh — network bounds', () => {
  function runNetworkHelper(name: string, body: string, env: NodeJS.ProcessEnv = {}) {
    const start = scriptSource.indexOf(`${name}() {`);
    expect(start, `${name} must be provided by the installer`).toBeGreaterThanOrEqual(0);
    const end = scriptSource.indexOf('\n}\n', start);
    expect(end).toBeGreaterThan(start);
    return spawnSync('/bin/bash', ['-c', `${boundedSource}\n${scriptSource.slice(start, end + 3)}\n${body}`], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 15_000,
    });
  }

  it('terminates a stalled locked pip install and preserves its timeout status', () => {
    const result = runNetworkHelper('install_transcription_requirements', `
whatsoup_install_locked_requirements() { sleep 30; }
VENV=/unused REPO_ROOT=/unused WHATSOUP_PIP_INSTALL_TIMEOUT=1
install_transcription_requirements
`);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(124);
  }, 20_000);

  it('bounds curl time, redirects, protocols and bytes while disabling inherited curl configuration', () => {
    const root = makeTempRoot('itd-curl-bounds-');
    writeExecutable(root, 'curl', '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    const result = runNetworkHelper('download_ggml_model', `
GGML_SMALL_URL=https://example.invalid/model GGML_SMALL_PATH="$TEST_MODEL"
download_ggml_model
`, { PATH: `${root}:${process.env.PATH}`, TEST_MODEL: path.join(root, 'model') });
    expect(result.status, result.stderr).toBe(0);
    const args = result.stdout.trim().split('\n');
    expect(args[0]).toBe('--disable');
    for (const [option, value] of [
      ['--connect-timeout', '15'], ['--max-time', '600'], ['--max-redirs', '3'],
      ['--max-filesize', '536870912'], ['--proto', '=https'], ['--proto-redir', '=https'],
    ]) {
      expect(args.indexOf(option)).toBeGreaterThanOrEqual(0);
      expect(args[args.indexOf(option) + 1]).toBe(value);
    }
  });

  it('enforces a kernel file limit even when a downloader ignores its byte limit', () => {
    const root = makeTempRoot('itd-curl-file-limit-');
    const model = path.join(root, 'model');
    writeExecutable(root, 'curl', `#!${process.execPath}
const fs = require('node:fs');
fs.closeSync(fs.openSync(process.env.TEST_MODEL, 'w'));
fs.truncateSync(process.env.TEST_MODEL, 2 * 1024 * 1024 * 1024);
`);
    const result = runNetworkHelper('download_ggml_model', `
GGML_SMALL_URL=https://example.invalid/model GGML_SMALL_PATH="$TEST_MODEL"
download_ggml_model
`, { PATH: `${root}:${process.env.PATH}`, TEST_MODEL: model });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(fs.statSync(model).size).toBeLessThanOrEqual(1024 * 1024 * 1024);
  });

  it('terminates a stalled downloader and preserves its timeout status', () => {
    const root = makeTempRoot('itd-curl-stall-');
    writeExecutable(root, 'curl', '#!/bin/sh\nexec sleep 30\n');
    const result = runNetworkHelper('download_ggml_model', `
GGML_SMALL_URL=https://example.invalid/model GGML_SMALL_PATH=/unused
WHATSOUP_MODEL_DOWNLOAD_TIMEOUT=1
download_ggml_model
`, { PATH: `${root}:${process.env.PATH}` });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(124);
  }, 20_000);
});
