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
function runWithHelpers(body: string, extraPath?: string): { status: number; stdout: string; stderr: string } {
  const helpers = ['sha256_of', 'resolve_python']
    .map((fn) => {
      const start = scriptSource.indexOf(`${fn}() {`);
      if (start === -1) throw new Error(`helper ${fn}() not found in install-transcription-deps.sh`);
      const end = scriptSource.indexOf('\n}\n', start);
      if (end === -1) throw new Error(`helper ${fn}() has no terminating brace`);
      return scriptSource.slice(start, end + 3);
    })
    .join('\n');
  const pathPrefix = extraPath ? `export PATH="${extraPath}:$PATH"\n` : '';
  const result = spawnSync('bash', ['-c', `set -uo pipefail\n${pathPrefix}${helpers}\n${body}`], {
    encoding: 'utf8',
    cwd: repoRoot,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('install-transcription-deps.sh — source-level portability invariants', () => {
  it('does not hardcode an absolute Homebrew python path', () => {
    // The original defect: PYTHON_BIN="/opt/homebrew/bin/python3.12", which does
    // not exist on Linux, Intel macOS, or a Mac without the python@3.12 formula.
    expect(scriptSource).not.toMatch(/PYTHON_BIN\s*=\s*"?\/opt\/homebrew/);
  });

  it('does not invoke brew unconditionally', () => {
    // `brew install …` at top level died under `set -e` on any machine without
    // Homebrew, before reaching a single actionable message.
    const brewLines = scriptSource
      .split('\n')
      .filter((line) => /^\s*brew\s+install/.test(line));
    for (const line of brewLines) {
      expect(scriptSource).toMatch(/command -v brew/);
      expect(line.startsWith('  ')).toBe(true);
    }
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
    writeExecutable(shim, 'shasum', '#!/bin/sh\nexit 127\n');
    const root = makeTempRoot('itd-sha2-');
    fs.writeFileSync(path.join(root, 'f'), 'hello', 'utf8');
    const res = runWithHelpers(`sha256_of "${path.join(root, 'f')}"`, shim);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
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
    writeExecutable(shim, 'python3.12', '#!/bin/sh\nexit 1\n');
    const res = runWithHelpers('resolve_python', shim);
    // Either it finds a working interpreter elsewhere on PATH, or it fails —
    // but it must never hand back the one that cannot import venv.
    if (res.status === 0) {
      expect(res.stdout.trim()).not.toBe(path.join(shim, 'python3.12'));
    }
  });

  it('honours WHATSOUP_TRANSCRIPTION_PYTHON when it is usable', () => {
    const res = runWithHelpers(
      'WHATSOUP_TRANSCRIPTION_PYTHON="$(command -v python3)" resolve_python',
    );
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).not.toBe('');
  });

  it('falls through a broken override instead of failing outright', () => {
    const res = runWithHelpers(
      'WHATSOUP_TRANSCRIPTION_PYTHON=/nonexistent/python resolve_python',
    );
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).not.toBe('/nonexistent/python');
  });
});
