#!/usr/bin/env python3
"""Read bounded delivery receipts from the existing BOT ERRORS dispatcher."""

import json
from pathlib import Path
import re
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


def delivery_receipts(root, identifiers):
    if len(identifiers) > 128 or any(
        not re.fullmatch(r"[0-9a-f-]{36}", value) for value in identifiers
    ):
        raise ValueError("event_identifiers_invalid")
    output = {}
    for identifier in identifiers:
        output[identifier] = {"status": "unobserved"}
        for stage in ("sent", *STAGES):
            for index, path in enumerate(
                (Path(root) / stage).glob("*" + identifier + "*")
            ):
                if index >= 32:
                    break
                if (
                    path.is_symlink()
                    or not path.is_file()
                    or path.stat().st_size > 1024 * 1024
                ):
                    continue
                try:
                    event = json.loads(path.read_text())
                except (OSError, ValueError):
                    continue
                if event.get("id") != identifier:
                    continue
                delivery = event.get("delivery", {})
                status = delivery.get("status")
                if (
                    stage == "sent"
                    and status in {"sent", "email_delivered"}
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
