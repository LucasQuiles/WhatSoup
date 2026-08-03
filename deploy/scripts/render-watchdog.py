#!/usr/bin/env python3
"""render-watchdog.py — deterministic render + verify for the per-host WhatSoup
launchd watchdog (deploy/templates/watchdog-script.sh).

Replaces the ad-hoc `sed`/here-doc rendering done by hand on each host. Two
host-free modes (NO ssh, NO host mutation, NO secret access):

  render  --template T --bot-name N --bot-port P --fleet-port F --home H
          [--username U] [--out FILE] [--json]
      Substitute the host tokens, FAIL CLOSED if any known placeholder survives
      (the exact bug that churned mini7/8/9: literal BOT_PORT/FLEET_PORT), reject
      non-numeric/out-of-range ports AND shell-unsafe identity values (the
      substitution is raw text replacement, so an unvalidated bot name, home, or
      username would become executable fragments in the rendered script), and
      emit the rendered script + its sha256.

  verify  --script FILE [--json]
      Report any surviving placeholder tokens + sha256 for an already-installed
      script (the caller fetches it separately, e.g. over ssh). Lets a future
      audit prove an installed watchdog is fully substituted without a hand grep.

Exit codes (typed failure classes):
  0 OK
  2 UNSUBSTITUTED_PLACEHOLDER  (a known token survived render / found by verify)
  3 BAD_PORT                   (bot/fleet port not an integer in 1..65535)
  4 BAD_INPUT                  (missing arg / unreadable template)
  5 IO_ERROR                   (write failed)
  6 UNSAFE_VALUE               (bot name / home / username outside the safe charset)

The tool never reads credentials and never contacts a host. Installation
(backup + checksum transfer + launchctl) stays an explicit owner-gated step.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

# The exact tokens the watchdog template carries. Order: longest/disjoint first;
# all are mutually non-substring so order does not affect correctness.
PLACEHOLDER_TOKENS = ("__HOME__", "FLEET_PORT", "BOT_PORT", "BOT_NAME", "USERNAME")

EXIT_OK = 0
EXIT_UNSUBSTITUTED = 2
EXIT_BAD_PORT = 3
EXIT_BAD_INPUT = 4
EXIT_IO_ERROR = 5
EXIT_UNSAFE_VALUE = 6

# The substitution below is raw text replacement into a zsh script (and its
# embedded Python heredoc), so identity values must stay inside charsets that
# cannot terminate a quote, expand, or comment. Conservative on purpose.
_BOT_NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
_USERNAME_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._-]{0,31}\Z")
_HOME_RE = re.compile(r"/[A-Za-z0-9._/-]*\Z")


def _unsafe_value(*, bot_name: str, home: str, username: str) -> tuple[str, str] | None:
    """Return (field, reason) for the first unsafe identity value, else None."""
    if not _BOT_NAME_RE.fullmatch(bot_name):
        return ("--bot-name", "must match [a-z0-9][a-z0-9-]* (max 64 chars)")
    if (
        not _HOME_RE.fullmatch(home)
        or ".." in home.split("/")
        or (len(home) > 1 and home.endswith("/"))
    ):
        return ("--home", "must be an absolute [A-Za-z0-9._/-] path without .. segments")
    if username and not _USERNAME_RE.fullmatch(username):
        return ("--username", "must match [A-Za-z0-9_][A-Za-z0-9._-]* (max 32 chars)")
    return None


def _valid_port(value: str) -> bool:
    # Reject non-numeric, out-of-range, AND leading-zero forms ("00009"): curl
    # would treat :00009 as a live port and the watchdog would restart-loop on an
    # unreachable URL. Canonical decimal only.
    return (
        bool(re.fullmatch(r"[0-9]{1,5}", value))
        and 1 <= int(value) <= 65535
        and str(int(value)) == value
    )


def render(template_text: str, *, bot_name: str, bot_port: str, fleet_port: str,
           home: str, username: str) -> str:
    """Substitute host tokens into the template. Pure; no I/O."""
    out = template_text
    for token, value in (
        ("__HOME__", home),
        ("FLEET_PORT", fleet_port),
        ("BOT_PORT", bot_port),
        ("BOT_NAME", bot_name),
        ("USERNAME", username),
    ):
        out = out.replace(token, value)
    return out


def find_placeholders(text: str) -> list[str]:
    """Return the known placeholder tokens still present in text (sorted, unique).

    Word-boundary match (no surrounding word char) so a token that is a substring
    of a legit identifier — e.g. USERNAME inside FLEET_USERNAME_SUFFIX — is NOT a
    false positive. Underscored tokens (__HOME__) still match when quoted/spaced.
    """
    return sorted({t for t in PLACEHOLDER_TOKENS
                   if re.search(rf"(?<!\w){re.escape(t)}(?!\w)", text)})


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _emit(payload: dict, *, as_json: bool, human: str) -> None:
    if as_json:
        print(json.dumps(payload, sort_keys=True))
    else:
        print(human)


def cmd_render(args: argparse.Namespace) -> int:
    for label, value in (("--bot-port", args.bot_port), ("--fleet-port", args.fleet_port)):
        if not _valid_port(value):
            _emit({"mode": "render", "status": "bad_port", "field": label, "value": value},
                  as_json=args.json, human=f"BAD_PORT: {label}={value!r} is not an integer in 1..65535")
            return EXIT_BAD_PORT
    unsafe = _unsafe_value(bot_name=args.bot_name, home=args.home, username=args.username)
    if unsafe is not None:
        field, reason = unsafe
        _emit({"mode": "render", "status": "unsafe_value", "field": field, "reason": reason},
              as_json=args.json, human=f"UNSAFE_VALUE: {field} {reason}")
        return EXIT_UNSAFE_VALUE
    try:
        template_text = Path(args.template).read_text(encoding="utf-8")
    except OSError as err:
        _emit({"mode": "render", "status": "bad_input", "error": str(err)},
              as_json=args.json, human=f"BAD_INPUT: cannot read template: {err}")
        return EXIT_BAD_INPUT

    rendered = render(template_text, bot_name=args.bot_name, bot_port=args.bot_port,
                      fleet_port=args.fleet_port, home=args.home, username=args.username)
    remaining = find_placeholders(rendered)
    digest = sha256(rendered)
    payload = {
        "mode": "render", "bot_name": args.bot_name, "bot_port": args.bot_port,
        "fleet_port": args.fleet_port, "home": args.home, "sha256": digest,
        "bytes": len(rendered.encode("utf-8")), "placeholders_remaining": remaining,
        "status": "ok" if not remaining else "unsubstituted",
    }
    if remaining:
        _emit(payload, as_json=args.json,
              human=f"UNSUBSTITUTED_PLACEHOLDER: {', '.join(remaining)} survived render")
        return EXIT_UNSUBSTITUTED

    if args.out:
        try:
            Path(args.out).write_text(rendered, encoding="utf-8")
        except OSError as err:
            _emit({"mode": "render", "status": "io_error", "error": str(err)},
                  as_json=args.json, human=f"IO_ERROR: cannot write --out: {err}")
            return EXIT_IO_ERROR
        payload["out"] = args.out
        _emit(payload, as_json=args.json,
              human=f"OK rendered {args.bot_name} (bot:{args.bot_port} fleet:{args.fleet_port}) "
                    f"sha256={digest} -> {args.out}")
    elif args.json:
        print(json.dumps(payload, sort_keys=True))
    else:
        # Default: emit the rendered script to stdout so it can be piped/checksummed.
        sys.stdout.write(rendered)
    return EXIT_OK


def cmd_verify(args: argparse.Namespace) -> int:
    try:
        text = Path(args.script).read_text(encoding="utf-8")
    except OSError as err:
        _emit({"mode": "verify", "status": "bad_input", "error": str(err)},
              as_json=args.json, human=f"BAD_INPUT: cannot read script: {err}")
        return EXIT_BAD_INPUT
    remaining = find_placeholders(text)
    payload = {
        "mode": "verify", "script": args.script, "sha256": sha256(text),
        "placeholders_remaining": remaining,
        "status": "ok" if not remaining else "unsubstituted",
    }
    if remaining:
        _emit(payload, as_json=args.json,
              human=f"UNSUBSTITUTED_PLACEHOLDER in {args.script}: {', '.join(remaining)}")
        return EXIT_UNSUBSTITUTED
    _emit(payload, as_json=args.json,
          human=f"OK {args.script} fully substituted sha256={payload['sha256']}")
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="render-watchdog", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)

    r = sub.add_parser("render", help="render the watchdog template for a host")
    r.add_argument("--template", required=True)
    r.add_argument("--bot-name", required=True)
    r.add_argument("--bot-port", required=True)
    r.add_argument("--fleet-port", required=True)
    r.add_argument("--home", required=True)
    r.add_argument("--username", default="")
    r.add_argument("--out", default=None)
    r.add_argument("--json", action="store_true")
    r.set_defaults(func=cmd_render)

    v = sub.add_parser("verify", help="report surviving placeholders in a script")
    v.add_argument("--script", required=True)
    v.add_argument("--json", action="store_true")
    v.set_defaults(func=cmd_verify)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
