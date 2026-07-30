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
It is the canonical runtime-staleness observation engine. Its observation-only
mode provides the supported manual and machine-readable diagnostic surface.

Verdict logic (deterministic, conservative)
-------------------------------------------
  STALE  <=>  newest mtime of any ``src/**/*.ts`` file  >  process boot epoch.

For a STALE instance   → emit alert: --severity warning --source runtime_stale
For a FRESH instance   → emit clear: --clear --source runtime_stale
For a not-running (MainPID=0) instance → emit nothing.

Probe honesty (spec B1)
------------------------
A probe command failing, or returning malformed/empty output, is an UNKNOWN
observation, not a fresh or not-running one. Unknown observations must never
be converted into a --clear (false fresh) or a not-running skip (false
negative) — both would hide a real incident. Every probe step (systemctl
list-units, systemctl show MainPID, ps etimes, find) raises ProbeError on
failure or unparseable output. An affirmative not-running result — MainPID
output that is exactly "0" — is the ONLY skip; everything else is either a
valid observation or a probe error. Successful discovery that finds zero
whatsoup@ instances is also treated as a probe error, not an empty healthy
fleet, since a discovery command that silently stops matching real units
looks identical to zero instances.

Observation-only reports retain bounded failure classes (`missing`,
`malformed`, `timeout`, `permissionError`, and `commandError`) while omitting
raw command output, paths, process identifiers, and instance labels.

Exit codes
----------
  Scheduled emit mode:
    0  Successful monitor run (regardless of staleness).
    1  One or more emit() calls failed.
    2  Probe/configuration error that prevented the run.

  Observation-only mode:
    0  Complete current/not-running observation.
    1  Complete observation with one or more stale instances.
    2  Incomplete or failed observation.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import re
import os
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


class ProbeError(Exception):
    """A probe command failed or returned malformed output; the observation is unknown.

    Unknown observations must never be converted to fresh/stale state (spec B1)."""

    KINDS = {
        "missing",
        "malformed",
        "timeout",
        "permission_error",
        "command_error",
    }

    def __init__(self, kind: str):
        if kind not in self.KINDS:
            raise ValueError("unsupported probe error kind")
        self.kind = kind
        super().__init__(kind)


# Files whose staleness is behaviourally load-bearing.
CRITICAL_SUFFIXES: list[str] = [
    "src/runtimes/agent/failure-taxonomy.ts",
    "src/runtimes/agent/runtime.ts",
    "src/runtimes/agent/fallback-empty-advance.ts",
    "src/core/health.ts",
]
OBSERVATION_SCHEMA_VERSION = 1
OBSERVATION_CHECK = "runtime-code-staleness"


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

    Returns (None, None) when output is empty. Any malformed row makes the
    entire source observation unknown; partial parse success is not evidence
    completeness.
    """
    best_epoch: int = -1
    best_file: str | None = None
    for line in find_output.splitlines():
        if not line:
            continue
        if line.count("\t") != 1:
            raise ProbeError("malformed")
        epoch_text, file_path = line.split("\t", 1)
        if not file_path:
            raise ProbeError("malformed")
        try:
            epoch_float = float(epoch_text)
            if not math.isfinite(epoch_float):
                raise ProbeError("malformed")
            epoch = math.floor(epoch_float)
        except (ValueError, OverflowError) as exc:
            raise ProbeError("malformed") from exc
        if epoch > best_epoch:
            best_epoch = epoch
            best_file = file_path
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
    """Return True when any required critical file changed since boot.

    The complete critical set must be readable. Missing or unreadable entries
    are unknown evidence, never an affirmative non-stale result.
    """
    if boot_epoch is None:
        return False
    critical_stale = False
    for suffix in CRITICAL_SUFFIXES:
        abs_path = os.path.join(repo_root, suffix)
        try:
            with open(abs_path, "rb") as fh:
                fh.read(1)
            mtime = math.floor(os.stat(abs_path).st_mtime)
        except FileNotFoundError as exc:
            raise ProbeError("missing") from exc
        except PermissionError as exc:
            raise ProbeError("permission_error") from exc
        except OSError as exc:
            raise ProbeError("command_error") from exc
        if mtime > boot_epoch:
            critical_stale = True
    return critical_stale


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


def _probe_timeout_seconds() -> float:
    """Return the bounded probe timeout, with a narrow test/deploy override."""
    raw = os.environ.get("BOT_ERRORS_STALENESS_PROBE_TIMEOUT_SECONDS", "15")
    try:
        value = float(raw)
    except ValueError as exc:
        raise ProbeError("malformed") from exc
    if not 0.01 <= value <= 60:
        raise ProbeError("malformed")
    return value


def _run(args: list[str]) -> str:
    """Run a probe command and return stdout or a bounded typed failure."""
    try:
        proc = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=_probe_timeout_seconds(),
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ProbeError("timeout") from exc
    except PermissionError as exc:
        raise ProbeError("permission_error") from exc
    except (OSError, subprocess.SubprocessError) as exc:
        raise ProbeError("command_error") from exc
    if proc.returncode != 0:
        raise ProbeError("command_error")
    return proc.stdout


def discover_instances() -> list[str]:
    """List whatsoup@ instance names via the platform service manager.

    Raises ProbeError when the discovery command itself fails; an empty
    result is returned to the caller, which treats it as a probe error too.
    """
    if sys.platform == "linux":
        out = _run(
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
            if not stripped:
                continue
            token = stripped.split()[0]
            if not token.startswith("whatsoup@") or not token.endswith(".service"):
                raise ProbeError("malformed")
            name = token.removeprefix("whatsoup@").removesuffix(".service")
            if not name:
                raise ProbeError("malformed")
            names.append(name)
        return names
    elif sys.platform == "darwin":
        # Discover com.whatsoup.* user LaunchAgent labels via launchctl list
        out = _run(["launchctl", "list"])
        names = []
        for line in out.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            # launchctl list output: PID	ExitCode	Label
            parts = stripped.split()
            if len(parts) >= 3:
                label = parts[2]
                prefix = "com.whatsoup."
                if label.startswith(prefix) and label.endswith(".service"):
                    name = label[len(prefix):-len(".service")]
                    if name:
                        names.append(name)
        return names
    else:
        raise ProbeError(f"unsupported_platform:{sys.platform}")


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
    if sys.platform == "linux":
        pid_out = _run(
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
    elif sys.platform == "darwin":
        label = f"com.whatsoup.{instance}.service"
        pid_out_raw = _run(["launchctl", "print", f"gui/{os.getuid()}/{label}"])
        # Extract pid from launchctl print output
        m = re.search(r'^[ \t]*pid = (\d+)', pid_out_raw, re.MULTILINE)
        pid_out = m.group(1) if m else "0"
    else:
        raise ProbeError(f"unsupported_platform:{sys.platform}")
    pid_text = pid_out.strip()
    if pid_text == "0":
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
    pid = parse_main_pid(pid_out)
    if pid is None:
        raise ProbeError("missing" if not pid_text else "malformed")

    # 2. Boot epoch via elapsed seconds
    ps_out = _run(["ps", "-o", "etimes=", "-p", str(pid)])
    etimes = parse_etimes(ps_out)
    if etimes is None:
        raise ProbeError("missing" if not ps_out.strip() else "malformed")
    boot_epoch = compute_boot_epoch(etimes, now_epoch)

    # 3. Repo root bound to the target process's own /proc cmdline.
    repo_root = _repo_root_from_pid(pid)
    if repo_root is None:
        raise ProbeError("missing")

    # 4. Newest src/*.ts mtime via find
    src_dir = os.path.join(repo_root, "src")
    find_out = _run(["find", src_dir, "-name", "*.ts", "-printf", "%T@\t%p\n"])
    src_file, src_epoch = parse_find_output(find_out)
    if src_epoch is None:
        raise ProbeError("missing" if not find_out.strip() else "malformed")

    stale = is_stale(boot_epoch, src_epoch)
    critical = is_critical_stale(boot_epoch, src_epoch, repo_root)
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
    """Derive repo root only from the target process's own bootstrap argv."""
    proc_root = os.environ.get("BOT_ERRORS_STALENESS_PROC_ROOT", "/proc")
    cmdline_path = os.path.join(proc_root, str(pid), "cmdline")
    try:
        with open(cmdline_path, "rb") as fh:
            raw = fh.read().decode("latin-1")
        argv = [a for a in raw.split("\0") if a]
        boot = next((a for a in argv if a.endswith("bootstrap.ts")), None)
        if boot and os.path.isabs(boot):
            # <root>/src/bootstrap.ts -> <root>
            return str(Path(boot).resolve().parent.parent)
    except FileNotFoundError:
        return None
    except PermissionError as exc:
        raise ProbeError("permission_error") from exc
    except OSError as exc:
        raise ProbeError("command_error") from exc
    return None


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
        try:
            instances = discover_instances()
        except ProbeError as exc:
            print(f"probe error: {exc}", file=sys.stderr)
            return 2
        if not instances:
            print(
                "probe error: no whatsoup@ instances discovered; "
                "refusing to report an empty fleet as healthy",
                file=sys.stderr,
            )
            return 2

    probe_error = False
    emit_failed = False
    for inst in instances:
        try:
            result = probe_instance(inst)
        except ProbeError as exc:
            print(f"probe error: {exc}", file=sys.stderr)
            probe_error = True
            continue

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
            emit_failed = True

    if probe_error:
        return 2
    if emit_failed:
        return 1
    return 0


def _observation_report(
    *,
    current: int,
    stale: int,
    not_running: int,
    unknown: int,
    total: int,
    inventory_status: str,
    failure_counts: dict[str, int],
    criterion: str,
) -> dict[str, object]:
    """Build the bounded aggregate observation shared by human and JSON output."""
    if current + stale + not_running + unknown != total:
        raise ValueError("observation count invariant violated")
    if inventory_status not in {
        "observed",
        "not_requested",
        "missing",
        "malformed",
        "timeout",
        "permissionError",
        "commandError",
    }:
        raise ValueError("unsupported inventory status")
    if criterion not in {"all_source", "critical"}:
        raise ValueError("unsupported observation criterion")
    evidence_complete = (
        inventory_status in {"observed", "not_requested"}
        and unknown == 0
        and total > 0
    )
    if not evidence_complete:
        status = "unknown"
    elif stale > 0:
        status = "stale"
    elif not_running == total:
        status = "not_running"
    elif current == total:
        status = "current"
    else:
        status = "mixed"
    return {
        "schemaVersion": OBSERVATION_SCHEMA_VERSION,
        "check": OBSERVATION_CHECK,
        "executionStatus": "completed" if evidence_complete else "incomplete",
        "status": status,
        "evidenceComplete": evidence_complete,
        "inventoryStatus": inventory_status,
        "criterion": criterion,
        "counts": {
            "total": total,
            "current": current,
            "stale": stale,
            "notRunning": not_running,
            "unknown": unknown,
        },
        "failureCounts": failure_counts,
    }


def observe_once(
    *,
    instances: list[str] | None,
    json_output: bool,
    critical_only: bool,
) -> int:
    """Probe without emitting and render one privacy-bounded aggregate report."""
    failure_counts = {
        "missing": 0,
        "malformed": 0,
        "timeout": 0,
        "permissionError": 0,
        "commandError": 0,
    }
    failure_keys = {
        "missing": "missing",
        "malformed": "malformed",
        "timeout": "timeout",
        "permission_error": "permissionError",
        "command_error": "commandError",
    }
    inventory_status = "not_requested"
    if instances is None:
        try:
            instances = discover_instances()
            inventory_status = "observed"
        except ProbeError as exc:
            instances = []
            inventory_status = failure_keys[exc.kind]
            failure_counts[failure_keys[exc.kind]] += 1
        if not instances:
            if inventory_status == "observed":
                inventory_status = "missing"
                failure_counts["missing"] += 1

    current = 0
    stale = 0
    not_running = 0
    unknown = 0
    for inst in instances:
        try:
            result = probe_instance(inst)
        except ProbeError as exc:
            unknown += 1
            failure_counts[failure_keys[exc.kind]] += 1
            continue
        if not result["running"]:
            not_running += 1
        elif result["critical"] if critical_only else result["stale"]:
            stale += 1
        else:
            current += 1

    report = _observation_report(
        current=current,
        stale=stale,
        not_running=not_running,
        unknown=unknown,
        total=len(instances),
        inventory_status=inventory_status,
        failure_counts=failure_counts,
        criterion="critical" if critical_only else "all_source",
    )
    if json_output:
        print(json.dumps(report, separators=(",", ":"), sort_keys=True))
    else:
        counts = report["counts"]
        assert isinstance(counts, dict)
        print(
            f"{OBSERVATION_CHECK}: status={report['status']} "
            f"execution_status={report['executionStatus']} "
            f"evidence_complete={str(report['evidenceComplete']).lower()} "
            f"inventory_status={report['inventoryStatus']} "
            f"criterion={report['criterion']} "
            f"total={counts['total']} current={counts['current']} "
            f"stale={counts['stale']} not_running={counts['notRunning']} "
            f"unknown={counts['unknown']}"
        )

    if not report["evidenceComplete"]:
        return 2
    return 1 if stale > 0 else 0


def config_check() -> int:
    """Validate monitor configuration without probing any instance."""
    if not EMIT_SCRIPT.exists():
        print("runtime-staleness-monitor config error: emit_script_missing", file=sys.stderr)
        return 2
    print("runtime-staleness-monitor config ok")
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
    parser.add_argument(
        "--observe-only",
        action="store_true",
        help="Probe and report without emitting any alert or clear.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="With --observe-only, emit the versioned aggregate JSON report.",
    )
    parser.add_argument(
        "--critical",
        action="store_true",
        help="With --observe-only, classify against the complete critical-file set.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if args.json and not args.observe_only:
        print("configuration error: --json requires --observe-only", file=sys.stderr)
        return 2
    if args.critical and not args.observe_only:
        print("configuration error: --critical requires --observe-only", file=sys.stderr)
        return 2
    if args.config_check and (
        args.observe_only
        or args.json
        or args.critical
        or args.instance
        or args.dry_run
        or args.once
    ):
        print("configuration error: --config-check cannot be combined", file=sys.stderr)
        return 2
    if args.observe_only and args.dry_run:
        print("configuration error: --observe-only cannot combine with --dry-run", file=sys.stderr)
        return 2
    if args.config_check:
        return config_check()
    instances = [args.instance] if args.instance else None
    if args.observe_only:
        return observe_once(
            instances=instances,
            json_output=args.json,
            critical_only=args.critical,
        )
    return run_once(instances=instances, dry_run=args.dry_run)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
