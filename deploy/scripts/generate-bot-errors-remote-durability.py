#!/usr/bin/env python3
"""Deterministically embed the remote durability subset into the collector."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys


BEGIN = "# BEGIN GENERATED REMOTE DURABLE JSON SOURCE"
END = "# END GENERATED REMOTE DURABLE JSON SOURCE"


def rendered_block(source: str) -> str:
    if not source.endswith("\n"):
        source += "\n"
    fragments = "".join(f"    {line!r}\n" for line in source.splitlines(keepends=True))
    return (
        f"{BEGIN}\n"
        "REMOTE_DURABLE_JSON_SOURCE = (\n"
        f"{fragments}"
        ")\n"
        f"{END}"
    )


def generated_collector(collector: str, source: str) -> str:
    start = collector.find(BEGIN)
    finish = collector.find(END)
    if start < 0 or finish < 0 or finish < start:
        raise ValueError("collector remote durability markers are missing or invalid")
    finish += len(END)
    return collector[:start] + rendered_block(source) + collector[finish:]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    scripts = Path(__file__).resolve().parent
    collector_path = scripts / "bot-errors-collector.py"
    helper_path = scripts / "lib" / "durable_json_remote.py"
    collector = collector_path.read_text(encoding="utf-8")
    source = helper_path.read_text(encoding="utf-8")
    generated = generated_collector(collector, source)
    if args.check:
        if generated != collector:
            print("embedded remote durability source is stale", file=sys.stderr)
            return 1
        return 0
    collector_path.write_text(generated, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
