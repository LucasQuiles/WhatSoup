#!/usr/bin/env python3
"""Acknowledge a bot's dead-credential condition so its owner pages pause for 24 hours.

The dispatcher pages the owner every four hours while a bot's provider
credential is dead (lib/credential_repage.py). An acknowledgement tells it
that a human has the condition in hand: no page for that bot for 24 hours
from the acknowledgement, then the pages resume if the condition is still
open. It does not close the condition and it silences no group alert.

    bot-errors-credential-ack.py <instance> [--machine <host>]

Run on the dispatcher host as the dispatcher's service user, so the state
directory is the dispatcher's own (``BOT_ERRORS_STATE_DIR`` honored).

The key written is the open condition's own key, read from the incident
state: the command never builds one from what was typed. It refuses, and
writes nothing, when the instance has no open condition, when several open
conditions carry that instance name and ``--machine`` does not select one,
and when the incident state is absent or cannot be read. So an
acknowledgement that could not hold is never written silently.

State lives in ``credential-ack.json`` beside the maintenance file, keyed by
the condition's scope: ``{"<host>|<instance>": {"ackedAt": <epoch seconds>,
"by": "<login name>"}}``. The write is predecessor-fenced and fails closed;
each write drops the entries that are older than 24 hours.
"""

from __future__ import annotations

import argparse
import getpass
import json
import sys
import time
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib import credential_repage
from lib.durable_json import (
    DurableWriteError,
    durable_json_target,
    observe_json,
    operation_id,
    publish_state_json,
    require_advance,
)
from lib.state_files import CREDENTIAL_ACK, INCIDENT_STATE
from lib.state_root import state_root

BY_MAX_CHARS = 64


class Refused(Exception):
    """The command writes nothing; the text says why."""


def open_conditions(instance: str, machine: str | None) -> list[str]:
    """The keys of the open conditions of this instance name, read from the incident state."""
    root = state_root()
    path = root / INCIDENT_STATE
    try:
        state = credential_repage.read_state_object(path)
    except (OSError, DurableWriteError) as exc:
        raise Refused(f"the incident state under {root} cannot be read ({type(exc).__name__})") from None
    if state is None:
        raise Refused(f"no incident state under {root}; is this the dispatcher's state directory?")
    section = state.get(credential_repage.SECTION)
    section = section if isinstance(section, dict) else {}
    wanted = credential_repage.safe_segment(instance)
    host = credential_repage.safe_segment(machine.lower()) if machine else None
    found = []
    for key, entry in section.items():
        # Only an open condition: an acknowledgement of a pending or latent entry could never hold.
        if not isinstance(key, str) or credential_repage.phase(entry) != "open":
            continue
        entry_host, _, entry_instance = key.partition("|")
        if entry_instance == wanted and host in (None, entry_host):
            found.append(key)
    return sorted(found)


def _private_state_target():
    path = state_root() / CREDENTIAL_ACK
    if path.parent.is_symlink() or not path.parent.is_dir():
        raise DurableWriteError("identity_type")
    target = durable_json_target(
        trusted_root=path.parent.resolve(strict=True),
        relative_path=path.name,
    )
    return target, observe_json(target)


def _kept_entries(payload: Any, now: int) -> dict[str, Any]:
    """The stored acknowledgements that can still hold: a usable time, under 24 hours old."""
    if not isinstance(payload, dict):
        return {}
    kept = {}
    for key, value in payload.items():
        acked = credential_repage.acknowledged_at(value, now)
        if acked is not None and now - acked < credential_repage.ACK_HOLD_SECONDS:
            kept[key] = value
    return kept


def _login_name() -> str:
    try:
        name = getpass.getuser()
    except Exception:  # noqa: BLE001 - no login name is no reason to refuse
        name = ""
    return credential_repage.safe_segment(name)[:BY_MAX_CHARS]


def acknowledge(instance: str, machine: str | None) -> int:
    try:
        keys = open_conditions(instance, machine)
    except Refused as refusal:
        print(f"error: {refusal}", file=sys.stderr)
        return 1
    if not keys:
        print(f"error: no open condition for {instance}; nothing written", file=sys.stderr)
        return 1
    if len(keys) > 1:
        print(
            f"error: more than one open condition for {instance}: {', '.join(keys)}; "
            "nothing written (choose one with --machine <host>)",
            file=sys.stderr,
        )
        return 1
    key = keys[0]
    now = int(time.time())
    try:
        target, observation = _private_state_target()
    except DurableWriteError as exc:
        print(f"error: durable acknowledge state unavailable: {exc}", file=sys.stderr)
        return 1
    entries = _kept_entries(observation.payload, now)
    record = {"ackedAt": now, "by": _login_name()}
    entries[key] = record
    generation = (observation.version.generation or 0) + 1
    publication_operation = operation_id(
        target,
        entries,
        component="credential_ack.write_state",
        predecessor=observation.version,
    )
    publication = publish_state_json(
        target,
        entries,
        component="credential_ack.write_state",
        operation_id=publication_operation,
        expected=observation.version,
        generation=generation,
    )
    try:
        require_advance(publication)
    except DurableWriteError as exc:
        print(f"error: durable acknowledge state not committed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({key: record}, indent=2, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="bot-errors-credential-ack",
        description="Acknowledge a bot's dead-credential condition: no owner page for it for 24 hours.",
    )
    parser.add_argument("instance", help="the bot's instance name, as the page shows it")
    parser.add_argument("--machine", default=None,
                        help="the bot's host, when several open conditions carry this instance name")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return acknowledge(args.instance, args.machine)


if __name__ == "__main__":
    raise SystemExit(main())
