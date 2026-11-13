#!/usr/bin/env python3
"""Read bounded delivery receipts from the existing BOT ERRORS dispatcher."""

from contextlib import closing, contextmanager
import errno
import json
import os
from pathlib import Path
import re
import stat
import sys
import time


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
MAX_LOOKUP_ENTRIES = 4096
MAX_LOOKUP_BYTES = 8 * 1024 * 1024
MAX_LOOKUP_SECONDS = 5
# Include print's newline in the consumer's strictly-less-than-64-KiB contract.
MAX_RESPONSE_BYTES = 65535


class _LookupBudget:
    def __init__(self):
        self.deadline = time.monotonic() + MAX_LOOKUP_SECONDS
        self.entries = 0
        self.bytes_read = 0

    def check(self):
        if (
            time.monotonic() >= self.deadline
            or self.entries > MAX_LOOKUP_ENTRIES
            or self.bytes_read > MAX_LOOKUP_BYTES
        ):
            raise RuntimeError("delivery_lookup_limit")


def _check_response(output, budget):
    size = 1
    for chunk in json.JSONEncoder(sort_keys=True).iterencode(output):
        budget.check()
        size += len(chunk.encode("ascii"))
        if size > MAX_RESPONSE_BYTES:
            raise RuntimeError("delivery_lookup_limit")


@contextmanager
def _directory(name, *, dir_fd=None):
    try:
        descriptor = os.open(
            name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd
        )
    except OSError as error:
        if error.errno not in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
            raise RuntimeError("delivery_observation_failed") from None
        yield None
        return
    try:
        yield descriptor
    finally:
        os.close(descriptor)


def _read_receipt(directory_fd, name, budget):
    budget.check()
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
        raw = bytearray()
        # Disable read-ahead so the shared byte budget covers filesystem reads.
        with os.fdopen(descriptor, "rb", buffering=0, closefd=False) as stream:
            while len(raw) <= MAX_RECEIPT_BYTES:
                budget.check()
                chunk = stream.read(min(
                    65536, MAX_RECEIPT_BYTES - len(raw) + 1,
                    MAX_LOOKUP_BYTES - budget.bytes_read + 1,
                ))
                budget.bytes_read += len(chunk)
                budget.check()
                if not chunk:
                    break
                raw.extend(chunk)
        if len(raw) > MAX_RECEIPT_BYTES:
            return None
        event = json.loads(raw)
        budget.check()
        return event if isinstance(event, dict) else None
    except (OSError, ValueError, RecursionError):
        return None
    finally:
        os.close(descriptor)


def _stage_events(root_fd, stage, identifiers, budget):
    budget.check()
    with _directory(stage, dir_fd=root_fd) as stage_fd:
        if stage_fd is None:
            return
        try:
            with os.scandir(stage_fd) as entries:
                matches = dict.fromkeys(identifiers, 0)
                for entry in entries:
                    budget.entries += 1
                    budget.check()
                    candidates = [identifier for identifier in identifiers if identifier in entry.name]
                    if not candidates:
                        continue
                    for identifier in candidates:
                        matches[identifier] += 1
                        if matches[identifier] > 32:
                            raise RuntimeError("delivery_lookup_limit")
                    event = _read_receipt(stage_fd, entry.name, budget)
                    if event is not None and event.get("id") in candidates:
                        yield event
        except OSError:
            raise RuntimeError("delivery_observation_failed") from None
    budget.check()


def delivery_receipts(root, identifiers):
    if len(identifiers) > 128 or any(
        not re.fullmatch(r"[0-9a-f-]{36}", value) for value in identifiers
    ):
        raise ValueError("event_identifiers_invalid")
    output = {identifier: {"status": "unobserved"} for identifier in identifiers}
    if not output:
        return output
    budget = _LookupBudget()
    with _directory(Path(root)) as root_fd:
        budget.check()
        if root_fd is None:
            return output
        for stage in ("sent", *STAGES):
            with closing(_stage_events(root_fd, stage, output, budget)) as events:
                for event in events:
                    identifier = event["id"]
                    delivery = event.get("delivery", {})
                    if not isinstance(delivery, dict):
                        continue
                    status = delivery.get("status")
                    audit_receipt = delivery.get("auditReceipt")
                    if (
                        stage == "sent"
                        and status in ("sent", "email_delivered")
                        and isinstance(audit_receipt, str)
                        and audit_receipt.strip()
                    ):
                        if output[identifier]["status"] in ("sent", "email_delivered"):
                            continue
                        output[identifier] = {
                            "status": status,
                            "sent_at": delivery.get("sentAt"),
                            "audit_receipt": audit_receipt,
                        }
                        _check_response(output, budget)
                        continue
                    current = output[identifier]["status"]
                    # A sent/ file without a valid audit receipt is still pending.
                    disposition = STAGES.get(stage, "pending")
                    if current == "unobserved" or (
                        current in RANK and RANK.index(disposition) < RANK.index(current)
                    ):
                        output[identifier] = {"status": disposition}
    _check_response(output, budget)
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
