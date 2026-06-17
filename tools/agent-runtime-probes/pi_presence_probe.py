#!/usr/bin/env python3
"""Check whether Pi is locally installed/active without installing anything."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

from probelib import run


HOME = Path.home()


def du(path: Path) -> str | None:
    if not path.exists():
        return None
    out = run(["du", "-sh", str(path)], timeout=10)
    return str(out["stdout"]).split("\t", 1)[0] if out["rc"] == 0 else None


def main() -> int:
    path = shutil.which("pi")
    report = {
        "schema": "agent-runtime-pi-presence",
        "schema_version": "0.1",
        "redaction": "metadata-only; reports executable/config path presence and directory sizes, not auth values or file contents",
        "pi_on_path": path,
        "version": run(["pi", "--version"], timeout=10) if path else None,
        "known_paths": {
            "~/.pi": (HOME / ".pi").exists(),
            "~/.pi/agent": (HOME / ".pi/agent").exists(),
            "~/.pi/agent/settings.json": (HOME / ".pi/agent/settings.json").exists(),
            "~/.pi/agent/auth.json": (HOME / ".pi/agent/auth.json").exists(),
            "~/.config/pi": (HOME / ".config/pi").exists(),
        },
        "sizes": {
            "~/.pi": du(HOME / ".pi"),
            "~/.config/pi": du(HOME / ".config/pi"),
        },
        "verdict": "not locally callable" if not path else "callable on PATH",
    }
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
