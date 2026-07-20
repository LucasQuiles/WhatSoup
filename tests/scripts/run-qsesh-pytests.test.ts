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
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = process.cwd();
let tmpRoot = "";

/**
 * A stand-in interpreter that satisfies the runner's `import pytest` probe and
 * appends a marker when asked to run the suite.
 */
function writeFakePython(
  path: string,
  marker: string,
  log: string,
  exitCode = 0,
  identity = `/env/${marker} 3.0.0`,
): void {
  mkdirSync(join(path, ".."), { recursive: true });
  // Models the real contract: the runner probes for an environment identity and
  // for pytest before running the suite. Each fake reports a DISTINCT sys.prefix
  // so the runner treats them as separate environments.
  writeFileSync(
    path,
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    'import pytest') exit 0 ;;
    *sys.prefix*) echo "${identity}"; exit 0 ;;
  esac
done
echo "${marker}" >> "${log}"
exit ${exitCode}
`,
    "utf8",
  );
  chmodSync(path, 0o755);
}

function writePrefixSensitivePython(path: string, log: string): void {
  writeFileSync(
    path,
    `#!/bin/sh
case "$2" in
  'import pytest') exit 0 ;;
  *sys.prefix*)
    case "$0" in
      *qsesh-runtimes*) echo "/env/managed 3.14.6" ;;
      *) echo "/env/system 3.12.13" ;;
    esac
    exit 0
    ;;
esac
case "$0" in
  *qsesh-runtimes*) echo "MANAGED314" >> "${log}" ;;
  *) echo "PY312" >> "${log}" ;;
esac
exit 0
`,
    "utf8",
  );
  chmodSync(path, 0o755);
}

function runRunner(env: NodeJS.ProcessEnv) {
  return spawnSync("/bin/bash", ["scripts/run-qsesh-pytests.sh"], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

afterEach(() => {
  if (tmpRoot && existsSync(tmpRoot))
    rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = "";
});

describe("run-qsesh-pytests.sh interpreter selection", () => {
  it("invokes both the managed 3.14 runtime and python3.12, not just the first", () => {
    tmpRoot = mkdtempSync("/tmp/qsesh-runner-");
    const log = join(tmpRoot, "invocations.log");
    const binDir = join(tmpRoot, "bin");
    const managed = join(
      tmpRoot,
      ".local/share/qsesh-runtimes/py314/bin/python",
    );

    writeFakePython(managed, "MANAGED314", log);
    writeFakePython(join(binDir, "python3.12"), "PY312", log);

    const result = runRunner({
      HOME: tmpRoot,
      PATH: binDir,
      QSESH_PYTHON: "",
    });

    expect(result.status).toBe(0);
    const invoked = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(invoked).toContain("PY312");
    expect(invoked).toContain("MANAGED314");
  });

  it("continues after an early runtime failure and returns nonzero", () => {
    tmpRoot = mkdtempSync("/tmp/qsesh-runner-");
    const log = join(tmpRoot, "invocations.log");
    const binDir = join(tmpRoot, "bin");
    const managed = join(
      tmpRoot,
      ".local/share/qsesh-runtimes/py314/bin/python",
    );

    // 3.12 green, managed 3.14 red — exactly the cross-runtime defect shape.
    writeFakePython(join(binDir, "python3.12"), "PY312", log);
    writeFakePython(managed, "MANAGED314-FAILED", log, 1);

    const result = runRunner({
      HOME: tmpRoot,
      PATH: binDir,
      QSESH_PYTHON: "",
    });

    expect(result.status).not.toBe(0);
    const invoked = readFileSync(log, "utf8");
    expect(invoked).toContain("MANAGED314-FAILED");
    expect(invoked).toContain("PY312");
  });

  it("keeps a later runtime failure nonzero after an earlier runtime passes", () => {
    tmpRoot = mkdtempSync("/tmp/qsesh-runner-");
    const log = join(tmpRoot, "invocations.log");
    const binDir = join(tmpRoot, "bin");
    const managed = join(
      tmpRoot,
      ".local/share/qsesh-runtimes/py314/bin/python",
    );

    writeFakePython(managed, "MANAGED314", log);
    writeFakePython(join(binDir, "python3.12"), "PY312-FAILED", log, 1);

    const result = runRunner({
      HOME: tmpRoot,
      PATH: binDir,
      QSESH_PYTHON: "",
    });

    expect(result.status).not.toBe(0);
    const invoked = readFileSync(log, "utf8");
    expect(invoked).toContain("MANAGED314");
    expect(invoked).toContain("PY312-FAILED");
  });

  it("runs aliases with the same environment identity once", () => {
    tmpRoot = mkdtempSync("/tmp/qsesh-runner-");
    const log = join(tmpRoot, "invocations.log");
    const binDir = join(tmpRoot, "bin");
    const managed = join(
      tmpRoot,
      ".local/share/qsesh-runtimes/py314/bin/python",
    );
    const identity = "/env/shared 3.14.6";

    writeFakePython(managed, "MANAGED314", log, 0, identity);
    writeFakePython(join(binDir, "python3.12"), "PY312", log, 0, identity);

    const result = runRunner({
      HOME: tmpRoot,
      PATH: binDir,
      QSESH_PYTHON: "",
    });

    expect(result.status).toBe(0);
    const invoked = readFileSync(log, "utf8");
    expect(invoked).toContain("MANAGED314");
    expect(invoked).not.toContain("PY312");
  });

  it("runs one executable twice when each symlink resolves to a distinct environment", () => {
    tmpRoot = mkdtempSync("/tmp/qsesh-runner-");
    const log = join(tmpRoot, "invocations.log");
    const binDir = join(tmpRoot, "bin");
    const managed = join(
      tmpRoot,
      ".local/share/qsesh-runtimes/py314/bin/python",
    );
    const python312 = join(binDir, "python3.12");
    const shared = join(tmpRoot, "shared-python");

    writePrefixSensitivePython(shared, log);
    mkdirSync(join(managed, ".."), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    symlinkSync(shared, managed);
    symlinkSync(shared, python312);

    const result = runRunner({
      HOME: tmpRoot,
      PATH: binDir,
      QSESH_PYTHON: "",
    });

    expect(result.status).toBe(0);
    const invoked = readFileSync(log, "utf8");
    expect(invoked).toContain("MANAGED314");
    expect(invoked).toContain("PY312");
  });

  it("honours an explicit QSESH_PYTHON override as the sole interpreter", () => {
    tmpRoot = mkdtempSync("/tmp/qsesh-runner-");
    const log = join(tmpRoot, "invocations.log");
    const binDir = join(tmpRoot, "bin");
    const chosen = join(binDir, "chosen-python");

    writeFakePython(chosen, "CHOSEN", log);
    writeFakePython(join(binDir, "python3.12"), "PY312", log);

    const result = runRunner({
      HOME: tmpRoot,
      PATH: binDir,
      QSESH_PYTHON: chosen,
    });

    expect(result.status).toBe(0);
    const invoked = readFileSync(log, "utf8");
    expect(invoked).toContain("CHOSEN");
    expect(invoked).not.toContain("PY312");
  });

  it("still exits 2 when no interpreter has pytest", () => {
    tmpRoot = mkdtempSync("/tmp/qsesh-runner-");
    const binDir = join(tmpRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const noPytest = join(binDir, "python3.12");
    writeFileSync(noPytest, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(noPytest, 0o755);

    const result = runRunner({
      HOME: tmpRoot,
      PATH: binDir,
      QSESH_PYTHON: "",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("pytest is required");
  });
});
