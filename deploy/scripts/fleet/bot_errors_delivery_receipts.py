#!/usr/bin/env python3
"""Read bounded delivery receipts from the existing BOT ERRORS dispatcher."""

from contextlib import closing, contextmanager
import json
import os
from pathlib import Path
import re
import stat
import sys


# Where the dispatcher leaves an event, and the status reported for it. An event
# can briefly sit in more than one stage; the highest-ranked status wins.
STAGES = {
    "suppressed": "suppressed",
    # Rolled into a storm digest that the dispatcher sends in its place.
    "storm-collapsed": "storm_collapsed",
    # Rejected events; the dispatcher pages for only some of these.
    "quarantine": "quarantined",
    "writefail-quarantine": "quarantined",
    # Dropped as a test fixture: never shown to anyone.
    "testleak": "test_leak_dropped",
    # Delivery gave up; not retried.
    "dead-letter": "dead_lettered",
    "processing": "pending",
    "outbox": "pending",
}
RANK = (
    "suppressed",
    "storm_collapsed",
    "quarantined",
    "test_leak_dropped",
    "dead_lettered",
    "pending",
)
MAX_RECEIPT_BYTES = 1024 * 1024


@contextmanager
def _directory(name, *, dir_fd=None):
    try:
        descriptor = os.open(
            name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd
        )
    except OSError:
        yield None
        return
    try:
        yield descriptor
    finally:
        os.close(descriptor)


def _read_receipt(directory_fd, name):
    try:
        descriptor = os.open(
            name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd
        )
    except OSError:
        return None
    try:
        observed = os.fstat(descriptor)
        if not stat.S_ISREG(observed.st_mode) or observed.st_size > MAX_RECEIPT_BYTES:
            return None
        # Read the verified descriptor; a pathname replacement must not change the input.
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            raw = stream.read(MAX_RECEIPT_BYTES + 1)
        if len(raw) > MAX_RECEIPT_BYTES:
            return None
        event = json.loads(raw)
        return event if isinstance(event, dict) else None
    except (OSError, ValueError, RecursionError):
        return None
    finally:
        os.close(descriptor)


def _stage_events(root_fd, stage, identifier):
    with _directory(stage, dir_fd=root_fd) as stage_fd:
        if stage_fd is None:
            return
        try:
            with os.scandir(stage_fd) as entries:
                matches = 0
                for entry in entries:
                    if identifier not in entry.name:
                        continue
                    if matches >= 32:
                        break
                    matches += 1
                    event = _read_receipt(stage_fd, entry.name)
                    if event is not None:
                        yield event
        except OSError:
            return


def delivery_receipts(root, identifiers):
    if len(identifiers) > 128 or any(
        not re.fullmatch(r"[0-9a-f-]{36}", value) for value in identifiers
    ):
        raise ValueError("event_identifiers_invalid")
    output = {identifier: {"status": "unobserved"} for identifier in identifiers}
    with _directory(Path(root)) as root_fd:
        if root_fd is None:
            return output
        for identifier in identifiers:
            for stage in ("sent", *STAGES):
                with closing(_stage_events(root_fd, stage, identifier)) as events:
                    for event in events:
                        if event.get("id") != identifier:
                            continue
                        delivery = event.get("delivery", {})
                        if not isinstance(delivery, dict):
                            continue
                        status = delivery.get("status")
                        if (
                            stage == "sent"
                            and status in ("sent", "email_delivered")
                            and isinstance(delivery.get("auditReceipt"), str)
                        ):
                            output[identifier] = {
                                "status": status,
                                "sent_at": delivery.get("sentAt"),
                                "audit_receipt": delivery["auditReceipt"],
                            }
                            break
                        current = output[identifier]["status"]
                        # A sent/ file without a valid audit receipt is still pending.
                        disposition = STAGES.get(stage, "pending")
                        if current == "unobserved" or (
                            current in RANK and RANK.index(disposition) < RANK.index(current)
                        ):
                            output[identifier] = {"status": disposition}
    return output


if __name__ == "__main__":
    try:
        print(
            json.dumps(
                delivery_receipts(
                    Path.home() / ".local/state/bot-errors", sys.argv[1:]
                ),
                sort_keys=True,
            )
        )
    except Exception:
        print(json.dumps({"code": "delivery_observation_failed"}))
        raise SystemExit(1)
