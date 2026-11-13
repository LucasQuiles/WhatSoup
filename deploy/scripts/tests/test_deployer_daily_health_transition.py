"""Exercise additive helper upgrades and rollbacks at completed-copy boundaries.

The new consumers are the actual deployed scripts. Legacy consumers model the
previous import contract; they do not stand in for a full historical runtime.
These checks do not cover an import during an individual cp write.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

import pytest

REPO = Path(__file__).resolve().parents[3]
DEPLOYER = REPO / "deploy/scripts/whatsoup-bot-errors-deploy.sh"
HELPER = "deploy/scripts/lib/bot_errors_daily_health.py"
CONSUMERS = [
    "deploy/scripts/bot-errors-dispatcher.py",
    "deploy/scripts/bot-errors-health-check.py",
]
EXPORT = "daily_health_instance_from_fail_line"

PROBE = """
import runpy
import sys
from pathlib import Path

root = Path(sys.argv[1])
sys.path.insert(0, str(root / "deploy/scripts"))
for name in ["bot-errors-dispatcher.py", "bot-errors-health-check.py"]:
    runpy.run_path(str(root / "deploy/scripts" / name))
"""

COPY_WRAPPER = """#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import sys

subprocess.run([os.environ["BOUNDARY_REAL_CP"], *sys.argv[1:]], check=True, timeout=10)
root = Path(os.environ["BOUNDARY_ROOT"])
destination = Path(sys.argv[-1])
watched = json.loads(os.environ["BOUNDARY_WATCHED"])
if destination in [root / relative for relative in watched]:
    relative = str(destination.relative_to(root))
    result = subprocess.run(
        [sys.executable, "-B", os.environ["BOUNDARY_PROBE"], str(root)],
        timeout=10,
    )
    with open(os.environ["BOUNDARY_LOG"], "a") as log:
        log.write(json.dumps({"path": relative, "returncode": result.returncode}) + "\\n")
    if result.returncode:
        sys.exit(result.returncode)
    if relative == os.environ.get("BOUNDARY_INTERRUPT_AFTER"):
        sys.exit(77)
"""


@dataclass
class Transition:
    root: Path
    env: dict[str, str] = field(repr=False)
    original: dict[str, bytes] = field(repr=False)


@pytest.fixture
def transition():
    with tempfile.TemporaryDirectory(prefix="deployer-transition-") as directory:
        scratch = Path(directory)
        root = scratch / "runtime"
        match = re.search(r"FILES=\(\n(.*?)\n\)", DEPLOYER.read_text(), re.S)
        assert match, "deployer FILES array could not be read"
        paths = [line.strip().strip('"') for line in match.group(1).splitlines()
                 if line.strip().startswith('"')]
        assert {HELPER, *CONSUMERS}.issubset(paths)
        for relative in paths:
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPO / relative, destination)

        # Preserve the old helper API while removing the newly introduced export.
        helper_text = (root / HELPER).read_text()
        function = next(node for node in ast.parse(helper_text).body
                        if isinstance(node, ast.FunctionDef) and node.name == EXPORT)
        lines = helper_text.splitlines(keepends=True)
        del lines[function.lineno - 1:function.end_lineno]
        (root / HELPER).write_text("".join(lines))
        legacy = """from lib.bot_errors_daily_health import (
    daily_health_host_from_payload, daily_health_line_is_failure,
    daily_health_line_is_warning,
)
assert daily_health_line_is_failure("FAIL service line-a: down")
assert daily_health_line_is_warning("WARN service line-a: stale")
assert daily_health_host_from_payload({"diagnostics": {"relay": {"remoteHost": "host-a"}}}) == "host-a"
"""
        for relative in CONSUMERS:
            (root / relative).write_text(legacy)
        original = {relative: (root / relative).read_bytes() for relative in [HELPER, *CONSUMERS]}

        probe = scratch / "probe.py"
        probe.write_text(PROBE)
        bin_dir = scratch / "bin"
        bin_dir.mkdir()
        copy = bin_dir / "cp"
        copy.write_text(COPY_WRAPPER)
        copy.chmod(0o755)
        real_cp = shutil.which("cp")
        assert real_cp
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", TMPDIR=str(scratch),
                   PATH=str(bin_dir) + os.pathsep + os.environ["PATH"],
                   BOUNDARY_REAL_CP=real_cp, BOUNDARY_ROOT=str(root),
                   BOUNDARY_WATCHED=json.dumps([HELPER, *CONSUMERS]),
                   BOUNDARY_PROBE=str(probe), BOUNDARY_LOG=str(scratch / "copies.jsonl"),
                   BOT_ERRORS_STATE_DIR=str(scratch / "state"),
                   BOT_ERRORS_OUTBOX_DIR=str(scratch / "outbox"))
        control = subprocess.run([sys.executable, "-B", str(probe), str(root)], env=env,
                                 capture_output=True, text=True, timeout=15)
        assert control.returncode == 0, control.stderr
        yield Transition(root, env, original)


def _run(mode, root, source, env):
    return subprocess.run(["bash", str(DEPLOYER), mode, str(root), str(source)],
                          cwd=REPO, env=env, capture_output=True, text=True, timeout=60)


@pytest.mark.parametrize("interrupt_after", [None, HELPER, *CONSUMERS])
def test_upgrade_and_rollback_keep_consumers_importable(transition, interrupt_after):
    root, env, original = transition.root, transition.env, transition.original
    if interrupt_after:
        env["BOUNDARY_INTERRUPT_AFTER"] = interrupt_after
    upgrade = _run("deploy", root, REPO, env)
    assert upgrade.returncode == (77 if interrupt_after else 0), upgrade.stdout + upgrade.stderr
    backup_lines = [line for line in upgrade.stdout.splitlines() if line.startswith("BACKUP=")]
    assert len(backup_lines) == 1
    backup = Path(backup_lines[0].removeprefix("BACKUP="))
    assert backup.is_dir() and not backup.is_relative_to(root)
    events = [json.loads(line) for line in Path(env["BOUNDARY_LOG"]).read_text().splitlines()]
    assert events and all(event["returncode"] == 0 for event in events)
    if not interrupt_after:
        assert {event["path"] for event in events} == {HELPER, *CONSUMERS}
        for relative in [HELPER, *CONSUMERS]:
            assert (root / relative).read_bytes() == (REPO / relative).read_bytes()
    else:
        assert events[-1]["path"] == interrupt_after

    env.pop("BOUNDARY_INTERRUPT_AFTER", None)
    rollback = _run("rollback", root, backup, env)
    assert rollback.returncode == 0, rollback.stdout + rollback.stderr
    assert "ROLLBACK_OK" in rollback.stdout
    restored_events = [json.loads(line) for line in Path(env["BOUNDARY_LOG"]).read_text().splitlines()][len(events):]
    assert len(restored_events) == 3
    assert all(event["returncode"] == 0 for event in restored_events)
    for relative, content in original.items():
        assert (root / relative).read_bytes() == content


@pytest.mark.parametrize("interrupt_after", CONSUMERS)
def test_interrupted_rollback_can_resume(transition, interrupt_after):
    root, env = transition.root, transition.env
    upgrade = _run("deploy", root, REPO, env)
    assert upgrade.returncode == 0, upgrade.stdout + upgrade.stderr
    backup = next(line.removeprefix("BACKUP=") for line in upgrade.stdout.splitlines()
                  if line.startswith("BACKUP="))
    env["BOUNDARY_INTERRUPT_AFTER"] = interrupt_after
    interrupted = _run("rollback", root, backup, env)
    assert interrupted.returncode == 77, interrupted.stdout + interrupted.stderr
    assert (root / HELPER).read_bytes() == (REPO / HELPER).read_bytes()
    env.pop("BOUNDARY_INTERRUPT_AFTER")
    resumed = _run("rollback", root, backup, env)
    assert resumed.returncode == 0, resumed.stdout + resumed.stderr
    assert "ROLLBACK_OK" in resumed.stdout
    events = [json.loads(line) for line in Path(env["BOUNDARY_LOG"]).read_text().splitlines()]
    assert all(event["returncode"] == 0 for event in events)
    for relative, content in transition.original.items():
        assert (root / relative).read_bytes() == content
