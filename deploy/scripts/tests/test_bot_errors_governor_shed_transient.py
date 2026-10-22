"""#3480: an outbound-governor shed is a transient transport failure.

The outbound governor rejects a send locally, before the provider call, with a
stable text. The dispatcher must classify that text as transient, so a shed
spends the large transient budget and never the small permanent dead-letter
budget of the alert the system itself chose to hold back.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
from pathlib import Path
from unittest.mock import patch

import pytest

_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"
_REPO_ROOT = Path(__file__).resolve().parents[3]
_TS_SHED_SOURCE = _REPO_ROOT / "src" / "core" / "outbound-governor-shed.ts"

SHED_TEXT = "outbound governor ceiling exceeded"
# The shape send_whatsapp raises when the tool call returns an error payload.
WRAPPED_SHED_TEXT = f"send_message returned error: {{'error': '{SHED_TEXT}'}}"
PERMANENT_FAILURES = (
    "send_message returned error: chat not found",
    "database connection ECONNREFUSED 127.0.0.1:5432",
)

SOURCE = "agent_turn_admission_rejected"
INSTANCE = "instance-x"
MACHINE = "unknown"
QUEUED_STATUS = "queued"
# One below the permanent cap (BOT_ERRORS_DELIVERY_MAX_ATTEMPTS defaults to 10):
# a shed classified as permanent would push this event into dead-letter.
SEEDED_ATTEMPTS = 9
PERMANENT_CAP = 10

_ENV_KEYS = [
    "BOT_ERRORS_STATE_DIR",
    "BOT_ERRORS_DELIVERY_MAX_ATTEMPTS",
    "BOT_ERRORS_TRANSIENT_MAX_ATTEMPTS",
]


@pytest.fixture(autouse=True)
def _clean_env():
    saved = {k: os.environ.get(k) for k in _ENV_KEYS}
    for k in _ENV_KEYS:
        os.environ.pop(k, None)
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def _load(state_dir: Path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(state_dir)
    (state_dir / "logs").mkdir(parents=True, exist_ok=True)
    spec = importlib.util.spec_from_file_location(
        f"bot_errors_dispatcher_governor_shed_{state_dir.name}", _SCRIPT
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def _event(event_id: str) -> dict:
    return {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "warning",
        "machine": MACHINE,
        "instance": INSTANCE,
        "source": SOURCE,
        "id": event_id,
        "createdAt": "2026-09-02T02:33:05.995Z",
        "summary": {"failureClass": "unknown", "length": 44, "correlationDigest": "de" * 32},
        "evidence": {"failureClass": "Error", "length": 88, "correlationDigest": "00" * 32},
        "delivery": {
            "attempts": SEEDED_ATTEMPTS,
            "status": QUEUED_STATUS,
            "nextAttemptAtEpoch": 0,
            "lastError": None,
        },
    }


def _dispatch_records(paths) -> list[dict]:
    log = paths["logs"] / "dispatch.jsonl"
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text().splitlines() if line.strip()]


@pytest.mark.parametrize("error", [SHED_TEXT, WRAPPED_SHED_TEXT])
def test_a_governor_shed_is_classified_transient(tmp_path, error):
    mod = _load(tmp_path / "classify")
    assert mod.is_transient_transport_failure(error) is True, error


@pytest.mark.parametrize("error", PERMANENT_FAILURES)
def test_permanent_failures_stay_permanent(tmp_path, error):
    mod = _load(tmp_path / "permanent")
    assert mod.is_transient_transport_failure(error) is False, error


def test_the_shed_text_matches_the_typescript_governor_constant(tmp_path):
    mod = _load(tmp_path / "parity")
    source = _TS_SHED_SOURCE.read_text(encoding="utf-8")
    match = re.search(
        r"export const OUTBOUND_GOVERNOR_SHED_LOG\s*=\s*'([^']*)';", source
    )
    assert match is not None, "OUTBOUND_GOVERNOR_SHED_LOG is no longer a single-quoted literal"
    assert mod.OUTBOUND_GOVERNOR_SHED_SIGNATURE == match.group(1)
    assert mod.OUTBOUND_GOVERNOR_SHED_SIGNATURE in mod._TRANSIENT_TRANSPORT_SIGNATURES


def test_a_shed_at_the_last_permanent_attempt_is_requeued_not_dead_lettered(tmp_path):
    mod = _load(tmp_path / "cycle")
    paths = mod.setup_dirs()
    # No incident state is seeded: a fresh event is due, so the cycle reaches the
    # send instead of suppressing the event as a recent duplicate.
    event = _event("evt-3480-shed")
    queued = paths["outbox"] / f"20260902.{INSTANCE}.{SOURCE}.{event['id']}.json"
    queued.write_text(json.dumps(event, indent=2))
    queued.chmod(0o600)

    with patch.object(mod, "send_whatsapp", side_effect=RuntimeError(WRAPPED_SHED_TEXT)) as sender:
        for candidate in sorted(paths["outbox"].glob("*.json")):
            if mod.ready(candidate, paths["quarantine"]):
                mod.process_one(candidate, paths)

    assert sender.call_count == 1, "the cycle must reach the send"
    # Hidden files are lock artifacts, not dead-lettered events.
    dead_lettered = [p.name for p in paths["dead_letter"].iterdir() if not p.name.startswith(".")]
    assert dead_lettered == [], dead_lettered
    requeued = list(paths["outbox"].glob("*.json"))
    assert len(requeued) == 1, requeued
    delivery = json.loads(requeued[0].read_text())["delivery"]
    assert delivery["status"] == QUEUED_STATUS, delivery
    assert int(delivery["attempts"]) < PERMANENT_CAP, delivery
    assert int(delivery.get("transientAttempts") or 0) >= 1, delivery
    kinds = [record.get("recordKind") for record in _dispatch_records(paths)]
    assert "send_deferred_transient" in kinds, kinds
