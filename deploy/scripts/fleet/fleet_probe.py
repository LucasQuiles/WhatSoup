#!/usr/bin/env python3
"""Run one portable fleet probe from an explicitly supplied private inventory.

The inventory remains outside the repository.  This wrapper embeds the current
shared health reader in the remote process so the host uses the same reader as
the rest of the deployed BOT ERRORS runtime.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shlex
import subprocess
import sys
import time
from typing import Any


ROOT = Path(__file__).resolve().parent
HEALTH_READER = ROOT.parent / "lib" / "health_reader.py"


def load_target(targets_path: Path, target_name: str) -> dict[str, Any]:
    """Read one target from an explicit absolute private inventory path."""
    if not targets_path.is_absolute():
        raise ValueError("fleet targets path must be absolute")
    raw = json.loads(targets_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("fleet targets must be an object")
    if "schema_version" in raw:
        if raw["schema_version"] != 1 or not isinstance(raw.get("hosts"), dict):
            raise ValueError("fleet targets must be a schema_version 1 hosts object")
        hosts = raw["hosts"]
    else:
        hosts = raw
    target = hosts.get(target_name)
    if not isinstance(target, dict):
        raise ValueError("requested fleet target is not configured")
    request = dict(target)
    request["name"] = target_name
    if request.get("local") is not True:
        target = request.get("target")
        if (
            not isinstance(target, str)
            or not target
            or target.startswith("-")
            or any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in target)
        ):
            raise ValueError("fleet target must name a transport target")
    if not isinstance(request.get("instances", []), list) or not all(
        isinstance(item, str) for item in request.get("instances", [])
    ):
        raise ValueError("fleet target instances must be strings")
    return request


def failure_payload() -> dict[str, Any]:
    return {
        "checked_at": time.time(),
        "checks": {"ssh_reachable": False},
        "codes": ["probe_transport_or_execution_failed"],
    }


def run_target(request: dict[str, Any]) -> dict[str, Any]:
    remote_code = (ROOT / "fleet_probe_remote.py").read_text(encoding="utf-8")
    request = {
        **request,
        "health_reader_code": HEALTH_READER.read_text(encoding="utf-8"),
        "mcp_code": (ROOT / "mcp_probe_remote.py").read_text(encoding="utf-8"),
    }
    encoded = json.dumps(request, separators=(",", ":"))
    if request.get("local") is True:
        command = [sys.executable, "-c", remote_code, encoded]
    else:
        remote = "python3 -c " + shlex.quote(remote_code) + " " + shlex.quote(encoded)
        command = [
            "/usr/bin/ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=8",
            "-o",
            "ServerAliveInterval=5",
            "-o",
            "ServerAliveCountMax=2",
            "--",
            request["target"],
            remote,
        ]
    try:
        result = subprocess.run(command, capture_output=True, timeout=80, check=False)
        if result.returncode == 0 and len(result.stdout) <= 64 * 1024:
            value = json.loads(result.stdout)
            if isinstance(value, dict):
                # The observer compares samples in its own clock domain.
                value["checked_at"] = time.time()
                return value
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return failure_payload()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--targets", type=Path, required=True)
    parser.add_argument("--target", required=True)
    args = parser.parse_args(argv)
    try:
        print(json.dumps(run_target(load_target(args.targets, args.target)), sort_keys=True))
        return 0
    except (OSError, ValueError, TypeError):
        print(json.dumps(failure_payload(), sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
