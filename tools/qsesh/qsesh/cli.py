"""qSesh CLI entry surface.

T01 scaffold: argument surface grows per task; the JSON/exit envelope contract
is implemented at T26 and commands are wired at T27-T29.
"""

from __future__ import annotations

import argparse

from . import __version__


def build_parser() -> argparse.ArgumentParser:
    return argparse.ArgumentParser(
        prog="qsesh",
        description=(
            "qSesh: deterministic, local-first, read-only index of Claude, "
            "Codex, and OpenCode sessions."
        ),
        epilog=f"qsesh {__version__}",
    )


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    parser.parse_args(argv)
    parser.print_help()
    return 0
