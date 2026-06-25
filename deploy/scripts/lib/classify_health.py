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


def classify(d: object) -> str:
    if not isinstance(d, dict):
        return "parse"
    status = d.get("status")
    tc = d.get("turn_capability")
    if status is None or not isinstance(tc, dict) or "model_usable" not in tc:
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
