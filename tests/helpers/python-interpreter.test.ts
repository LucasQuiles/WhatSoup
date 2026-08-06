import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTmpDirs } from './tmp-dir.ts';
import { resolveTestPython } from './python-interpreter.ts';

const tmp = trackTmpDirs('test-python-');

function python(path: string, version: string, exitCode = 0): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\nexit ${exitCode}\n`, 'utf8');
  chmodSync(path, 0o755);
  return path;
}

function baseEnv(home: string, bin: string): NodeJS.ProcessEnv {
  return { HOME: home, PATH: bin };
}

describe('resolveTestPython', () => {
  it('uses an explicit override before every managed or PATH candidate', () => {
    const home = tmp.make('explicit');
    const bin = join(home, 'bin');
    const override = python(join(home, 'override-python'), '3.13');
    python(join(bin, 'python3.12'), '3.12');

    expect(resolveTestPython({
      env: { ...baseEnv(home, bin), WHATSOUP_TEST_PYTHON: override },
    })).toBe(override);
  });

  it('prefers WHATSOUP_QUALITY_VENV before the default managed venv', () => {
    const home = tmp.make('managed');
    const bin = join(home, 'bin');
    const selectedRoot = join(home, 'selected-venv');
    const selected = python(join(selectedRoot, 'bin/python'), '3.12');
    python(join(home, '.local/share/whatsoup/quality-venv/bin/python'), '3.14');

    expect(resolveTestPython({
      env: { ...baseEnv(home, bin), WHATSOUP_QUALITY_VENV: selectedRoot },
    })).toBe(selected);
  });

  it('uses the XDG managed venv before PATH python commands', () => {
    const home = tmp.make('xdg');
    const bin = join(home, 'bin');
    const dataHome = join(home, 'data');
    const managed = python(join(dataHome, 'whatsoup/quality-venv/bin/python'), '3.12');
    python(join(bin, 'python3.12'), '3.13');

    expect(resolveTestPython({
      env: { ...baseEnv(home, bin), XDG_DATA_HOME: dataHome },
    })).toBe(managed);
  });

  it('falls through an absent python3.12 command to a valid python3', () => {
    const home = tmp.make('path');
    const bin = join(home, 'bin');
    python(join(bin, 'python3'), '3.12');

    expect(resolveTestPython({ env: baseEnv(home, bin) })).toBe('python3');
  });

  it('fails an invalid explicit override without widening', () => {
    const home = tmp.make('strict');
    const bin = join(home, 'bin');
    python(join(bin, 'python3.12'), '3.12');

    expect(() => resolveTestPython({
      env: { ...baseEnv(home, bin), WHATSOUP_TEST_PYTHON: join(home, 'missing') },
    })).toThrowError(expect.objectContaining({ code: 'python-missing' }));
  });

  it('distinguishes a below-minimum interpreter from a failed probe', () => {
    const oldHome = tmp.make('old');
    const oldBin = join(oldHome, 'bin');
    const oldPython = python(join(oldHome, 'python'), '3.11');
    expect(() => resolveTestPython({
      env: { ...baseEnv(oldHome, oldBin), WHATSOUP_TEST_PYTHON: oldPython },
    })).toThrowError(expect.objectContaining({ code: 'python-version' }));

    const failedHome = tmp.make('failed');
    const failedBin = join(failedHome, 'bin');
    const failedPython = python(join(failedHome, 'python'), '3.12', 9);
    expect(() => resolveTestPython({
      env: { ...baseEnv(failedHome, failedBin), WHATSOUP_TEST_PYTHON: failedPython },
    })).toThrowError(expect.objectContaining({ code: 'python-probe-failed' }));
  });
});
