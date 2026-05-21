#!/usr/bin/env python3
"""Render the token-budget watchdog launchd plist."""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path
from string import Template
from xml.sax.saxutils import escape


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_PATH = PLUGIN_ROOT / "launchd" / "com.tokenomics.token-budget-watchdog.plist.tmpl"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bot", required=True)
    parser.add_argument("--plugin-root", required=True)
    parser.add_argument("--home", required=True)
    parser.add_argument("--instance-path", required=True)
    parser.add_argument("--ceiling", required=True)
    parser.add_argument("--cooldown", required=True)
    parser.add_argument("--whatsoup-repo", required=True)
    parser.add_argument("--out", required=True)
    return parser.parse_args(argv)


def render(args: argparse.Namespace) -> str:
    template = Template(TEMPLATE_PATH.read_text(encoding="utf-8"))
    values = {
        "BOT": args.bot,
        "PLUGIN_ROOT": args.plugin_root,
        "HOME": args.home,
        "INSTANCE_PATH": args.instance_path,
        "CEILING": args.ceiling,
        "COOLDOWN": args.cooldown,
        "WHATSOUP_REPO": args.whatsoup_repo,
    }
    return template.substitute(
        {key: escape(value) for key, value in values.items()}
    )


def write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_name: str | None = None
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=str(path.parent), delete=False) as handle:
        tmp_name = handle.name
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        os.replace(tmp_name, path)
    except Exception:
        if tmp_name:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
        raise


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    rendered = render(args)
    out_path = Path(args.out)
    write_text_atomic(out_path, rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
