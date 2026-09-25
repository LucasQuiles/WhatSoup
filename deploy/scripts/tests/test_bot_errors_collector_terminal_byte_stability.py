"""#2427 A3: a terminal refusal record survives the full acknowledgement-retry
storm byte-for-byte.

Structural guarantee under test: no collector code path writes INTO a
terminal directory on a dedupe hit or an ack-phase reconcile — the dedupe
returns a phantom path and the reconcile only logs. This pins that guarantee
explicitly across the enumerated axes: dedupe-hit reoffer, ack failure with
requeue, restart (fresh module load), and eventual acknowledgement.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from unittest.mock import patch

_CONFTEST_PATH = Path(__file__).resolve().parent / "conftest.py"
_conftest_spec = importlib.util.spec_from_file_location("bot_errors_collector_test_conftest", _CONFTEST_PATH)
_conftest = importlib.util.module_from_spec(_conftest_spec)  # type: ignore[arg-type]
_conftest_spec.loader.exec_module(_conftest)  # type: ignore[union-attr]

_load_mod_with_dirs = _conftest._load_mod_with_dirs
_env = _conftest._env
_run_once_defaults = _conftest._run_once_defaults

REMOTE = "rhost:/srv/whatsoup/bot-errors"


def test_testleak_refusal_record_is_byte_stable_across_ack_retry_storm(tmp_state):
    state_dir, outbox_dir = tmp_state
    event = {
        "id": "leaked-stable-1",
        "createdAt": "2026-08-01T12:00:00.000Z",
        "source": "test_fixture_leak",
        "summary": "terminal refusal record",
    }
    testleak_dir = state_dir / "testleak"
    testleak_dir.mkdir(mode=0o700)
    refusal = testleak_dir / "leaked-stable-1.testleak.json"
    refusal.write_text(json.dumps(event), encoding="utf-8")
    original_bytes = refusal.read_bytes()
    record = {
        "name": "leaked-stable-1.json",
        "claim": "/srv/whatsoup/bot-errors/relay-processing/leaked-stable-1.json.9.relay",
        "payload": json.dumps(event),
    }

    def drive(mod, *, ack_raises: bool, claim_exists: bool):
        def fake_ssh_json_lines(h, script, args, timeout):
            return [dict(record)] if script == mod.REMOTE_CLAIM_SCRIPT else []

        def fake_remote_ack(host, claim, remote_root, action, timeout):
            if ack_raises and action == "ack":
                raise RuntimeError("connection reset")
            return "ok"

        with _env(state_dir, outbox_dir), \
             patch.object(mod, "ssh_json_lines", side_effect=fake_ssh_json_lines), \
             patch.object(mod, "remote_ack", side_effect=fake_remote_ack), \
             patch.object(mod, "remote_failure_context", return_value=([], {})), \
             patch.object(mod, "remote_claim_exists", return_value=claim_exists):
            _run_once_defaults(mod, [REMOTE])

    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    # Axis 1: dedupe-hit reoffer with a clean acknowledgement.
    drive(mod, ack_raises=False, claim_exists=True)
    # Axis 2: ack failure, claim still present (requeue path).
    drive(mod, ack_raises=True, claim_exists=True)
    # Axis 3: ack failure, claim absent (reconcile path).
    drive(mod, ack_raises=True, claim_exists=False)
    # Axis 4: restart — fresh module load, then eventual acknowledgement.
    mod2 = _load_mod_with_dirs(state_dir, outbox_dir)
    drive(mod2, ack_raises=False, claim_exists=True)

    assert refusal.read_bytes() == original_bytes
    siblings = [p for p in testleak_dir.glob("*") if p.is_file()]
    assert siblings == [refusal]
    # The refusal never re-enters delivery: no outbox lifecycle file carries
    # the leaked event's identity. (Collector META alerts about the induced
    # relay failures — remote-relay-failed and its recovery — are legitimate
    # outbox residents and are not the refusal event.)
    for outbox_file in outbox_dir.glob("*"):
        if not outbox_file.is_file() or outbox_file.name.startswith("."):
            continue
        loaded = json.loads(outbox_file.read_text(encoding="utf-8"))
        assert loaded.get("id") != "leaked-stable-1"
        assert "leaked-stable-1" not in outbox_file.name
