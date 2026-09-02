"""Tests for #3070: poison-quarantine email fallback must be TERMINAL.

fails-before:  send_whatsapp raises -> email_fallback returns True -> the
               quarantine log payload is stamped
               emailFallback="accepted_unconfirmed" with NO emailFallbackAt,
               i.e. a delivered poison alert is classified as unconfirmed /
               retry-eligible (the #2435 remainder the #3024 delivery-site
               fix left behind at this call site).
passes-after:  an accepted fallback is classified "email_delivered" (terminal,
               mirroring the #3024 delivery-site semantics) and stamped with
               emailFallbackAt; a failing fallback stays "failed".

The assertions read the payload handed to append_dispatch_log (captured via a
pass-through wrapper) rather than the on-disk details: write_controller_log
projects details through metadata_only_controller_details(), whose bounded
string-enum allowlist drops free-text and unregistered enum values, so the
classification is not observable in dispatch.jsonl. The on-disk record's
existence (type="quarantine") is still asserted end-to-end.

All tests exercise the REAL dispatcher module (importlib load + quarantine_poison).
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import dispatcher_fixtures  # noqa: E402

TEST_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS",
    "BOT_ERRORS_OUTBOX_DIR",
]


_clean_test_env = dispatcher_fixtures.make_env_scrub_fixture(TEST_ENV_KEYS)


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load_module(state_dir: Path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_3070", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def _quarantine_log_records(log_path: Path) -> list[dict[str, object]]:
    """Return all dispatch.jsonl records whose type is 'quarantine'."""
    assert log_path.exists(), "dispatch log must exist"
    records: list[dict[str, object]] = []
    for line in log_path.read_text().splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        if record.get("type") == "quarantine":
            records.append(record)
    return records


def _run_quarantine(mod, paths, *, fallback_accepted: bool, reason: str):
    """Drive quarantine_poison with a failing WhatsApp send, capturing the
    pre-projection payload handed to append_dispatch_log."""
    source = paths["processing"] / "bad.json"
    source.write_text("{not valid json}", encoding="utf-8")
    captured: list[dict[str, object]] = []
    real_append = mod.append_dispatch_log

    def capturing_append(append_paths, payload, **kwargs):
        captured.append(dict(payload))
        return real_append(append_paths, payload, **kwargs)

    with (
        patch.object(mod, "send_whatsapp", side_effect=RuntimeError("whatsapp down")),
        patch.object(mod, "email_fallback", return_value=fallback_accepted),
        patch.object(mod, "append_dispatch_log", side_effect=capturing_append),
    ):
        dest = mod.quarantine_poison(source, paths["quarantine"], reason)
    payloads = [p for p in captured if p.get("type") == "quarantine"]
    return dest, payloads


def test_poison_quarantine_accepted_fallback_is_terminal(tmp_path):
    """RED-on-main: an accepted fallback must be terminal (email_delivered).

    On main the quarantine payload carries emailFallback="accepted_unconfirmed"
    and no emailFallbackAt, so both assertions below fail there; after the
    #3070 fix the classification is terminal and stamped.
    """
    mod = _load_module(tmp_path / "state")
    paths = mod.setup_dirs()
    dest, payloads = _run_quarantine(
        mod, paths, fallback_accepted=True, reason="test poison #3070"
    )

    assert dest.exists(), "poison file must be moved to quarantine"
    assert payloads, "a quarantine dispatch-log payload must be produced"
    payload = payloads[-1]
    # Discriminating assertion #1: terminal classification (main yields accepted_unconfirmed).
    assert payload["emailFallback"] == "email_delivered", (
        f"accepted fallback must be TERMINAL (email_delivered), got {payload['emailFallback']!r}"
    )
    # Discriminating assertion #2: stamp semantics consistent with the #3024 delivery site.
    assert "emailFallbackAt" in payload, (
        "terminal acceptance must be stamped with emailFallbackAt"
    )
    # End-to-end: the record itself still lands in dispatch.jsonl (projected).
    quarantine_records = _quarantine_log_records(paths["logs"] / "dispatch.jsonl")
    assert quarantine_records, "a quarantine dispatch-log record must be written"


def test_poison_quarantine_failed_fallback_stays_failed(tmp_path):
    """No regression: a failing fallback stays 'failed', never terminal."""
    mod = _load_module(tmp_path / "state")
    paths = mod.setup_dirs()
    _dest, payloads = _run_quarantine(
        mod, paths, fallback_accepted=False, reason="test poison #3070 fail path"
    )

    assert payloads, "a quarantine dispatch-log payload must be produced"
    payload = payloads[-1]
    assert payload["emailFallback"] == "failed", (
        f"failed fallback must stay 'failed', got {payload['emailFallback']!r}"
    )
    assert payload["emailFallback"] != "email_delivered", (
        "failed fallback must never be terminal"
    )
