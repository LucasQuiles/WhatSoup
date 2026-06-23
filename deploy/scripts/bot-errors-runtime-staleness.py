#!/usr/bin/env python3
"""Runtime code-staleness monitor for WhatSoup instances.

The problem this defends against
---------------------------------
Each WhatSoup instance runs ``node --experimental-strip-types src/bootstrap.ts
<name>``. Node strips types and caches every ESM module in memory at first
import; there is NO hot reload. When a source-level fix lands the long-lived
process keeps running the OLD in-memory code until it is restarted.

This monitor detects instances whose running process is executing stale code
relative to the source tree on disk and emits low-noise BOT ERRORS events.
It is the deployed twin of ``scripts/process-code-staleness.ts``.

Verdict logic (deterministic, conservative)
-------------------------------------------
  STALE  <=>  newest mtime of any ``src/**/*.ts`` file  >  process boot epoch.

For a STALE instance   → emit alert: --severity warning --source runtime_stale
For a FRESH instance   → emit clear: --clear --source runtime_stale
For a not-running (MainPID=0) instance → emit nothing.

Exit codes
----------
  0  Successful monitor run (regardless of staleness).
  1  One or more emit() calls failed.
  2  Probe/configuration error that prevented the run.
"""

from __future__ import annotations

import argparse
import math
import os
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

# Emit-script path. Overridable via env so tests can point at a stub and never
# touch the real outbox, and so a deploy can relocate the emitter if needed.
EMIT_SCRIPT = Path(
    os.environ.get("BOT_ERRORS_STALENESS_EMIT_SCRIPT")
    or (SCRIPT_DIR / "bot-errors-emit.py")
)
EMIT_SOURCE = "runtime_stale"

# Files whose staleness is behaviourally load-bearing. Ported verbatim from
# scripts/process-code-staleness.ts (CRITICAL_SUFFIXES).
CRITICAL_SUFFIXES: list[str] = [
    "src/runtimes/agent/failure-taxonomy.ts",
    "src/runtimes/agent/runtime.ts",
    "src/runtimes/agent/fallback-empty-advance.ts",
    "src/core/health.ts",
]


# ---------------------------------------------------------------------------
# Pure verdict helpers — no subprocess, fully unit-testable.
# ---------------------------------------------------------------------------


def parse_main_pid(systemctl_output: str) -> int | None:
    """Return the MainPID integer, or None when the instance is not running.

    Returns None for output that is empty, non-numeric, or zero.
    """
    text = systemctl_output.strip()
    if not text:
        return None
    try:
        pid = int(text)
    except ValueError:
        return None
    return pid if pid > 0 else None


def parse_etimes(ps_output: str) -> int | None:
    """Return elapsed-seconds from ``ps -o etimes=`` output, or None."""
    text = ps_output.strip()
    try:
        etimes = int(text)
    except ValueError:
        return None
    return etimes if etimes >= 0 else None


def compute_boot_epoch(etimes: int, now_epoch: int) -> int:
    """Compute process boot epoch from elapsed seconds and current wall time."""
    return now_epoch - etimes


def parse_find_output(find_output: str) -> tuple[str | None, int | None]:
    """Parse ``find ... -printf '%T@\t%p\n'`` output; return (file, max_epoch).

    Returns (None, None) when the output is empty or unparseable.
    """
    best_epoch: int = -1
    best_file: str | None = None
    for line in find_output.splitlines():
        tab = line.find("\t")
        if tab < 0:
            continue
        try:
            epoch = math.floor(float(line[:tab]))
        except ValueError:
            continue
        if epoch > best_epoch:
            best_epoch = epoch
            best_file = line[tab + 1 :]
    if best_file is None:
        return None, None
    return best_file, best_epoch


def is_stale(boot_epoch: int | None, newest_src_epoch: int | None) -> bool:
    """Return True when the process is running code older than the source tree."""
    if boot_epoch is None or newest_src_epoch is None:
        return False
    return newest_src_epoch > boot_epoch


def is_critical_stale(
    boot_epoch: int | None,
    newest_src_epoch: int | None,
    repo_root: str,
) -> bool:
    """Return True when any CRITICAL_SUFFIXES file changed since boot."""
    if boot_epoch is None:
        return False
    for suffix in CRITICAL_SUFFIXES:
        abs_path = os.path.join(repo_root, suffix)
        try:
            mtime = math.floor(os.stat(abs_path).st_mtime)
        except OSError:
            continue
        if mtime > boot_epoch:
            return True
    return False


def build_emit_argv(
    *,
    instance: str,
    lag_seconds: int,
    critical: bool,
) -> list[str]:
    """Build ``bot-errors-emit.py`` argv for a STALE instance (pure, no subprocess).

    Returns a list[str] of emit.py flags. Carries only public identifiers —
    no filesystem paths, tokens, or phone numbers.
    """
    summary = (
        f"runtime_stale: whatsoup@{instance} running stale in-memory code "
        f"({lag_seconds}s behind source tree); restart to load current code"
    )
    return [
        "--severity",
        "warning",
        "--source",
        EMIT_SOURCE,
        "--instance",
        instance,
        "--summary",
        summary,
        "--diagnostic",
        f"lag_seconds={lag_seconds}",
        "--diagnostic",
        f"critical={str(critical).lower()}",
    ]


def build_clear_argv(*, instance: str) -> list[str]:
    """Build ``bot-errors-emit.py`` argv to CLEAR a runtime_stale incident (pure).

    Stateless: the dispatcher suppresses a clear with no open incident, so it is
    safe to emit clears for instances that were never stale.
    """
    return [
        "--clear",
        "--source",
        EMIT_SOURCE,
        "--instance",
        instance,
    ]


# ---------------------------------------------------------------------------
# Production I/O glue — thin shell around the pure core.
# ---------------------------------------------------------------------------


def _run(args: list[str], *, timeout: float = 15.0) -> tuple[int, str]:
    """Run a subprocess; return (returncode, stdout). Never raises."""
    try:
        proc = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
        return proc.returncode, proc.stdout
    except (OSError, subprocess.SubprocessError):
        return -1, ""


def discover_instances() -> list[str]:
    """List whatsoup@ instance names via systemctl."""
    _, out = _run(
        [
            "systemctl",
            "--user",
            "list-units",
            "whatsoup@*",
            "--all",
            "--no-legend",
            "--plain",
        ]
    )
    names: list[str] = []
    for line in out.splitlines():
        stripped = line.strip()
        # Match a systemd unit line for a whatsoup instance and take its unit token.
        if stripped.startswith("whatsoup@") and ".service" in stripped:
            token = stripped.split()[0]  # the unit token, e.g. the instance unit
            name = token.removeprefix("whatsoup@").removesuffix(".service")
            if name:
                names.append(name)
    return names


def probe_instance(instance: str) -> dict:
    """Probe one whatsoup@ instance; return a result dict.

    Keys:
      running     : bool  — MainPID > 0
      pid         : int | None
      boot_epoch  : int | None
      repo_root   : str | None
      src_file    : str | None
      src_epoch   : int | None
      stale       : bool
      critical    : bool
      lag_seconds : int | None
      error       : str | None
    """
    now_epoch = math.floor(time.time())

    # 1. MainPID
    _, pid_out = _run(
        [
            "systemctl",
            "--user",
            "show",
            f"whatsoup@{instance}",
            "-p",
            "MainPID",
            "--value",
        ]
    )
    pid = parse_main_pid(pid_out)
    if pid is None:
        return {
            "running": False,
            "pid": None,
            "boot_epoch": None,
            "repo_root": None,
            "src_file": None,
            "src_epoch": None,
            "stale": False,
            "critical": False,
            "lag_seconds": None,
            "error": "not running (MainPID=0)",
        }

    # 2. Boot epoch via elapsed seconds
    _, ps_out = _run(["ps", "-o", "etimes=", "-p", str(pid)])
    etimes = parse_etimes(ps_out)
    boot_epoch = compute_boot_epoch(etimes, now_epoch) if etimes is not None else None

    # 3. Repo root from /proc/<pid>/cmdline, fall back to env var or script anchor.
    repo_root = _repo_root_from_pid(pid)

    # 4. Newest src/*.ts mtime via find
    src_file: str | None = None
    src_epoch: int | None = None
    if repo_root:
        src_dir = os.path.join(repo_root, "src")
        _, find_out = _run(["find", src_dir, "-name", "*.ts", "-printf", "%T@\t%p\n"])
        src_file, src_epoch = parse_find_output(find_out)

    stale = is_stale(boot_epoch, src_epoch)
    critical = (
        is_critical_stale(boot_epoch, src_epoch, repo_root or "") if stale else False
    )
    lag = (
        (src_epoch - boot_epoch)
        if (stale and src_epoch is not None and boot_epoch is not None)
        else None
    )

    return {
        "running": True,
        "pid": pid,
        "boot_epoch": boot_epoch,
        "repo_root": repo_root,
        "src_file": src_file,
        "src_epoch": src_epoch,
        "stale": stale,
        "critical": critical,
        "lag_seconds": lag,
        "error": None,
    }


def _repo_root_from_pid(pid: int) -> str | None:
    """Derive repo root from /proc/<pid>/cmdline (bootstrap.ts -> dirname/..).

    Falls back to BOT_ERRORS_STALENESS_REPO_ROOT env var when /proc is
    unavailable or the cmdline does not contain bootstrap.ts.
    """
    cmdline_path = f"/proc/{pid}/cmdline"
    try:
        with open(cmdline_path, "rb") as fh:
            raw = fh.read().decode("latin-1")
        argv = [a for a in raw.split("\0") if a]
        boot = next((a for a in argv if a.endswith("bootstrap.ts")), None)
        if boot:
            # <root>/src/bootstrap.ts -> <root>
            return str(Path(boot).resolve().parent.parent)
    except OSError:
        pass

    env_root = os.environ.get("BOT_ERRORS_STALENESS_REPO_ROOT", "").strip()
    if env_root:
        return env_root

    # Last resort: derive from this script's location (deploy/scripts/ -> ../..)
    return str(SCRIPT_DIR.parent.parent)


def emit_event(emit_argv: list[str], *, dry_run: bool) -> int:
    """Shell emit.py with the given argv; return exit code."""
    if dry_run:
        import shlex

        print("[dry-run] would emit:", " ".join(shlex.quote(a) for a in emit_argv))
        return 0
    try:
        proc = subprocess.run(
            [sys.executable, str(EMIT_SCRIPT), *emit_argv],
            check=False,
        )
        return proc.returncode
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"emit failed: {exc}", file=sys.stderr)
        return 1


def run_once(*, instances: list[str] | None, dry_run: bool) -> int:
    """Run one monitor cycle; return 0 (success), 1 (emit failure), 2 (probe error)."""
    if instances is None:
        instances = discover_instances()

    if not instances:
        print("runtime-staleness-monitor: no whatsoup@ instances found")
        return 0

    exit_code = 0
    for inst in instances:
        result = probe_instance(inst)

        if not result["running"]:
            print(f"whatsoup@{inst}: not running — skipping (no emit)")
            continue

        if result["stale"]:
            argv = build_emit_argv(
                instance=inst,
                lag_seconds=int(result["lag_seconds"] or 0),
                critical=bool(result["critical"]),
            )
        else:
            argv = build_clear_argv(instance=inst)

        verdict = "STALE" if result["stale"] else "fresh"
        lag_str = f" lag={result['lag_seconds']}s" if result["stale"] else ""
        crit_str = " critical=true" if result.get("critical") else ""
        print(f"whatsoup@{inst}: {verdict}{lag_str}{crit_str}")

        rc = emit_event(argv, dry_run=dry_run)
        if rc != 0:
            print(f"emit failed for whatsoup@{inst} (rc={rc})", file=sys.stderr)
            exit_code = 1

    return exit_code


def config_check() -> int:
    """Validate monitor configuration without probing any instance."""
    if not EMIT_SCRIPT.exists():
        print(f"emit script not found: {EMIT_SCRIPT}", file=sys.stderr)
        return 2
    print(f"runtime-staleness-monitor config ok: emit_script={EMIT_SCRIPT}")
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Detect WhatSoup instances running stale in-memory code and emit BOT ERRORS events."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Probe instances and classify; do not write to the outbox.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single cycle (default; reserved for future loop mode).",
    )
    parser.add_argument(
        "--config-check",
        action="store_true",
        help="Validate monitor configuration only; do not probe instances or emit.",
    )
    parser.add_argument(
        "--instance",
        metavar="NAME",
        help="Monitor a single instance by name instead of auto-discovering all.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if args.config_check:
        return config_check()
    instances = [args.instance] if args.instance else None
    return run_once(instances=instances, dry_run=args.dry_run)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
