/**
 * The qSesh runner must exercise EVERY available target interpreter, not just
 * the first one it finds.
 *
 * Regression: the candidate list was `(python3.12 python3)` and the loop
 * `exec`d on the first hit, so the managed CPython 3.14 runtime under
 * $HOME/.local/share/qsesh-runtimes was never invoked. Every "N passed" the
 * pre-commit hook reported was single-runtime, while the qSesh metric contract
 * requires cross-runtime determinism — a class of defect (interpreter-dependent
 * Unicode word/token counts) that only a 3.14 run can surface.
 *
 * These tests assert invocation, using fake interpreters that record their
 * argv. They deliberately do not run real pytest.
 *
 * test-integrity: source-string-ok
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = process.cwd();
let tmpRoot = '';

/**
 * A stand-in interpreter that satisfies the runner's `import pytest` probe and
 * appends a marker when asked to run the suite.
 */
function writeFakePython(path: string, marker: string, log: string, exitCode = 0): void {
  mkdirSync(join(path, '..'), { recursive: true });
  // Models the real contract: the runner probes for an environment identity and
  // for pytest before running the suite. Each fake reports a DISTINCT sys.prefix
  // so the runner treats them as separate environments.
  writeFileSync(
    path,
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    'import pytest') exit 0 ;;
    *sys.prefix*) echo "/env/${marker} 3.0.0"; exit 0 ;;
  esac
done
echo "${marker}" >> "${log}"
exit ${exitCode}
`,
    'utf8',
  );
  chmodSync(path, 0o755);
}

function runRunner(env: NodeJS.ProcessEnv) {
  return spawnSync('bash', ['scripts/run-qsesh-pytests.sh'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

afterEach(() => {
  if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

describe('run-qsesh-pytests.sh interpreter selection', () => {
  it('invokes both the managed 3.14 runtime and python3.12, not just the first', () => {
    tmpRoot = mkdtempSync('/tmp/qsesh-runner-');
    const log = join(tmpRoot, 'invocations.log');
    const binDir = join(tmpRoot, 'bin');
    const managed = join(tmpRoot, '.local/share/qsesh-runtimes/py314/bin/python');

    writeFakePython(managed, 'MANAGED314', log);
    writeFakePython(join(binDir, 'python3.12'), 'PY312', log);

    const result = runRunner({
      HOME: tmpRoot,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      QSESH_PYTHON: '',
    });

    expect(result.status).toBe(0);
    const invoked = existsSync(log) ? readFileSync(log, 'utf8') : '';
    expect(invoked).toContain('PY312');
    expect(invoked).toContain('MANAGED314');
  });

  it('fails when any available interpreter fails, rather than passing on the first green one', () => {
    tmpRoot = mkdtempSync('/tmp/qsesh-runner-');
    const log = join(tmpRoot, 'invocations.log');
    const binDir = join(tmpRoot, 'bin');
    const managed = join(tmpRoot, '.local/share/qsesh-runtimes/py314/bin/python');

    // 3.12 green, managed 3.14 red — exactly the cross-runtime defect shape.
    writeFakePython(join(binDir, 'python3.12'), 'PY312', log);
    writeFakePython(managed, 'MANAGED314-FAILED', log, 1);

    const result = runRunner({
      HOME: tmpRoot,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      QSESH_PYTHON: '',
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('MANAGED314-FAILED');
  });

  it('honours an explicit QSESH_PYTHON override as the sole interpreter', () => {
    tmpRoot = mkdtempSync('/tmp/qsesh-runner-');
    const log = join(tmpRoot, 'invocations.log');
    const binDir = join(tmpRoot, 'bin');
    const chosen = join(binDir, 'chosen-python');

    writeFakePython(chosen, 'CHOSEN', log);
    writeFakePython(join(binDir, 'python3.12'), 'PY312', log);

    const result = runRunner({
      HOME: tmpRoot,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      QSESH_PYTHON: chosen,
    });

    expect(result.status).toBe(0);
    const invoked = readFileSync(log, 'utf8');
    expect(invoked).toContain('CHOSEN');
    expect(invoked).not.toContain('PY312');
  });

  it('still exits 2 when no interpreter has pytest', () => {
    tmpRoot = mkdtempSync('/tmp/qsesh-runner-');
    const binDir = join(tmpRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    const noPytest = join(binDir, 'python3.12');
    writeFileSync(noPytest, '#!/bin/sh\nexit 1\n', 'utf8');
    chmodSync(noPytest, 0o755);

    // Keep the system bin dirs so `bash` itself still resolves; only the
    // interpreters are stubbed out.
    const result = runRunner({
      HOME: tmpRoot,
      PATH: `${binDir}:/usr/bin:/bin`,
      QSESH_PYTHON: '',
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('pytest is required');
  });
});
