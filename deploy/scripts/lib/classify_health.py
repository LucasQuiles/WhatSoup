#!/usr/bin/env python3
"""Classify a WhatSoup /health body into a keychain-heal verdict token.

Extracted from whatsoup-keychain-heal.sh so the classification logic is unit
testable. Reads the /health JSON on stdin, prints exactly one token:

    ok | degraded | parse | fields

The acceptance signal for a healthy agent is a FRESH usable model: status
"healthy" AND turn_capability.model_usable is True AND not stale. The freshness
guard (model_usable_stale) closes the #1392 stale-green blind spot — see
FLEET-MATRIX F1. (With deriveModelUsable feeding the runtime value, model_usable
is already null when stale, so this is defense-in-depth, not the sole guard.)
"""
import json
import sys
from datetime import datetime
from typing import Optional


RECOVERY_DEBT_REASON_ORDER = (
    "continuity_gap_unreadable",
    "continuity_gap_open",
    "recovery_evidence_unreadable",
    "delivery_evidence_unreadable",
    "turn_finalization_active",
    "turn_recovery_actionable",
    "turn_recovery_integrity",
    "turn_recovery_unclassified",
    "completed_delivery_identity_unclassified",
    "uncorroborated_delivery_ambiguity",
    "turn_recovery_terminal",
    "turn_recovery_quarantined",
    "historical_turn_catchup",
    "corroborated_delivery_retained",
    "completed_delivery_identity_fresh_inbound",
    "completed_delivery_identity_operator",
)
RECOVERY_DEBT_BLOCKING_REASONS = {
    "continuity_gap_unreadable",
    "recovery_evidence_unreadable",
    "delivery_evidence_unreadable",
    "turn_finalization_active",
    "turn_recovery_actionable",
    "turn_recovery_integrity",
    "turn_recovery_unclassified",
    "completed_delivery_identity_unclassified",
}
MAX_SAFE_INTEGER = 9_007_199_254_740_991


def _recovery_count(value: object) -> Optional[int]:
    return value if type(value) is int and 0 <= value <= MAX_SAFE_INTEGER else None


def recovery_debt_issue(d: object) -> Optional[str]:
    """Validate the bounded recovery-debt fields used by operational gates."""
    if not isinstance(d, dict) or "recovery_debt" not in d:
        return None
    debt = d.get("recovery_debt")
    if not isinstance(debt, dict):
        return "recovery_debt_invalid"
    if "reason" not in debt:
        return "recovery_debt_invalid"
    open_debt = debt.get("open")
    service_blocking = debt.get("service_blocking")
    attention = debt.get("attention")
    if type(open_debt) is not bool or type(service_blocking) is not bool:
        return "recovery_debt_invalid"
    if attention not in ("none", "routine", "urgent"):
        return "recovery_debt_invalid"
    reasons = debt.get("reasons")
    if (
        not isinstance(reasons, list)
        or len(reasons) > 32
        or any(not isinstance(reason, str) or reason not in RECOVERY_DEBT_REASON_ORDER for reason in reasons)
        or len(set(reasons)) != len(reasons)
        or reasons != sorted(reasons, key=RECOVERY_DEBT_REASON_ORDER.index)
    ):
        return "recovery_debt_invalid"
    continuity = debt.get("continuity")
    turn_recovery = debt.get("turn_recovery")
    identity = debt.get("completed_delivery_identity")
    delivery = debt.get("delivery")
    if not all(isinstance(value, dict) for value in (continuity, turn_recovery, identity, delivery)):
        return "recovery_debt_invalid"
    sections = (continuity, turn_recovery, identity, delivery)
    if any(type(section.get("readable")) is not bool for section in sections):
        return "recovery_debt_invalid"
    count_fields = (
        (continuity, "open"),
        (continuity, "unresolved"),
        (continuity, "ambiguous"),
        (turn_recovery, "blocking_outstanding"),
        (turn_recovery, "retained_terminal"),
        (turn_recovery, "open_catchups"),
        (turn_recovery, "corroborated_retained"),
        (identity, "blocking"),
        (identity, "retained"),
        (delivery, "blocking_ambiguous"),
        (delivery, "uncorroborated_ambiguous"),
        (delivery, "corroborated_retained"),
    )
    counts = [_recovery_count(section.get(field)) for section, field in count_fields]
    if any(value is None for value in counts):
        return "recovery_debt_invalid"
    if "next_action" not in identity or "oldest_uncorroborated_at" not in delivery:
        return "recovery_debt_invalid"
    next_action = identity.get("next_action")
    if next_action not in (None, "fresh_inbound", "operator"):
        return "recovery_debt_invalid"
    oldest = delivery.get("oldest_uncorroborated_at")
    oldest_valid = False
    if isinstance(oldest, str):
        try:
            datetime.fromisoformat(oldest.replace("Z", "+00:00"))
            oldest_valid = True
        except ValueError:
            pass
    if (counts[10] > 0 and not oldest_valid) or (counts[10] == 0 and oldest is not None):
        return "recovery_debt_invalid"
    if counts[9] > counts[10]:
        return "recovery_debt_invalid"
    reason = debt.get("reason")
    expected_reason = "continuity_gap_unreadable" if not continuity["readable"] else (
        "continuity_gap_open" if counts[0] > 0 else None
    )
    if reason != expected_reason:
        return "recovery_debt_invalid"
    blocking_evidence = (
        any(not section["readable"] for section in sections)
        or counts[3] > 0
        or counts[7] > 0
        or counts[9] > 0
        or any(reason_value in RECOVERY_DEBT_BLOCKING_REASONS for reason_value in reasons)
    )
    gauge_total = sum(value for index, value in enumerate(counts) if index != 9)
    if gauge_total > MAX_SAFE_INTEGER:
        return "recovery_debt_invalid"
    expected_open = gauge_total > 0 or bool(reasons) or service_blocking
    expected_attention = "urgent" if service_blocking else "routine" if open_debt else "none"
    if (
        attention != expected_attention
        or open_debt != expected_open
        or service_blocking != blocking_evidence
    ):
        return "recovery_debt_invalid"
    if d.get("status") == "healthy" and service_blocking:
        return "recovery_debt_status_contradiction"
    return None


def classify(d: object) -> str:
    if not isinstance(d, dict):
        return "parse"
    status = d.get("status")
    tc = d.get("turn_capability")
    if status is None or not isinstance(tc, dict) or "model_usable" not in tc:
        return "fields"
    if recovery_debt_issue(d) is not None:
        return "fields"
    fresh_usable = tc.get("model_usable") is True and tc.get("model_usable_stale") is not True
    return "ok" if (status == "healthy" and fresh_usable) else "degraded"


def main() -> None:
    raw = sys.stdin.read()
    try:
        d = json.loads(raw)
    except Exception:
        print("parse")
        return
    print(classify(d))


if __name__ == "__main__":
    main()
