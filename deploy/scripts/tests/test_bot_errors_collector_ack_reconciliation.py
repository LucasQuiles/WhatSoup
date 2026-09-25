"""#2427 ack-retry reconciliation: a lost acknowledgement response must not
requeue, re-alert, or resurrect an event that already landed.

The relay loop writes the local record durably BEFORE acknowledging the
remote claim. When remote_ack("ack") raises AFTER the remote side already
archived the claim (response loss), the pre-fix loop requeued a claim that
no longer existed, counted the record failed, and minted a spurious
remote-relay-failed alert — while the local record stood. The fix probes the
remote claim's existence on an ack-phase failure: claim ABSENT means the ack
landed (reconcile as processed, no requeue, no alert); claim PRESENT or an
unreachable probe keeps today's conservative requeue + alert path. Stateless
by design — the probe reads remote truth, no local ledger (#2429 boundary).
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


def _claim_record(event_id: str = "evt-ack-1") -> dict:
    event = {
        "id": event_id,
        "createdAt": "2026-08-01T12:00:00.000Z",
        "instance": "x-bot",
        "source": "test_source",
        "summary": "ack reconciliation test",
        "severity": "warning",
    }
    return {
        "name": f"{event_id}.json",
        "claim": f"/srv/whatsoup/bot-errors/relay-processing/{event_id}.json.123.relay",
        "payload": json.dumps(event),
    }


def _outbox_events(outbox_dir: Path) -> list[Path]:
    return [p for p in outbox_dir.glob("*") if p.is_file() and not p.name.startswith(".")]


def _drive(mod, state_dir, outbox_dir, *, records, ack_effects, claim_exists):
    """Run one cycle with scripted claim records, remote_ack effects, and a
    remote_claim_exists behavior. Returns (result, ack_actions)."""
    ack_actions: list[str] = []

    def fake_ssh_json_lines(h, script, args, timeout):
        if script == mod.REMOTE_CLAIM_SCRIPT:
            return list(records)
        return []

    def fake_remote_ack(host, claim, remote_root, action, timeout):
        ack_actions.append(action)
        effect = ack_effects.get(action, "ok")
        if effect == "raise":
            raise RuntimeError(f"ssh ack {host} failed rc=255: connection reset")
        return f"/remote/{action}/{Path(claim).name}"

    patches = [
        patch.object(mod, "ssh_json_lines", side_effect=fake_ssh_json_lines),
        patch.object(mod, "remote_ack", side_effect=fake_remote_ack),
        patch.object(mod, "remote_failure_context", return_value=([], {})),
    ]
    if claim_exists == "raise":
        patches.append(patch.object(
            mod, "remote_claim_exists",
            side_effect=RuntimeError("probe unreachable"), create=True,
        ))
    else:
        patches.append(patch.object(
            mod, "remote_claim_exists", return_value=claim_exists, create=True,
        ))
    with _env(state_dir, outbox_dir):
        with patches[0], patches[1], patches[2], patches[3]:
            result = _run_once_defaults(mod, [REMOTE])
    return result, ack_actions


def _log_text(state_dir: Path) -> str:
    log = state_dir / "logs" / "collector.jsonl"
    return log.read_text(encoding="utf-8") if log.exists() else ""


def test_ack_success_green_control(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    result, ack_actions = _drive(
        mod, state_dir, outbox_dir,
        records=[_claim_record()], ack_effects={}, claim_exists=True,
    )
    assert result.get("processed") == 1
    assert result.get("failed") == 0
    assert ack_actions == ["ack"]
    assert len(_outbox_events(outbox_dir)) == 1
    assert '"type": "relayed"' in _log_text(state_dir)


def test_lost_ack_response_with_absent_claim_reconciles_as_processed(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    result, ack_actions = _drive(
        mod, state_dir, outbox_dir,
        records=[_claim_record()], ack_effects={"ack": "raise"}, claim_exists=False,
    )
    assert result.get("processed") == 1
    assert result.get("failed") == 0
    # No requeue of a claim that no longer exists.
    assert ack_actions == ["ack"]
    assert len(_outbox_events(outbox_dir)) == 1
    log = _log_text(state_dir)
    assert '"type": "ack_response_lost_claim_absent"' in log
    assert '"type": "relay_failed"' not in log
    # No spurious remote-relay-failed meta alert queued locally.
    assert "remote-relay-failed" not in log


def test_ack_failure_with_present_claim_keeps_requeue_and_alert(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    result, ack_actions = _drive(
        mod, state_dir, outbox_dir,
        records=[_claim_record()], ack_effects={"ack": "raise"}, claim_exists=True,
    )
    assert result.get("failed") == 1
    assert ack_actions == ["ack", "requeue"]
    assert '"type": "relay_failed"' in _log_text(state_dir)


def test_ack_failure_with_unreachable_probe_stays_conservative(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    result, ack_actions = _drive(
        mod, state_dir, outbox_dir,
        records=[_claim_record()], ack_effects={"ack": "raise"}, claim_exists="raise",
    )
    assert result.get("failed") == 1
    assert ack_actions == ["ack", "requeue"]
    assert '"type": "relay_failed"' in _log_text(state_dir)


def test_reoffered_claim_after_reconciliation_converges_to_one_record(tmp_state):
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    record = _claim_record("evt-ack-converge")
    _drive(
        mod, state_dir, outbox_dir,
        records=[record], ack_effects={"ack": "raise"}, claim_exists=False,
    )
    assert len(_outbox_events(outbox_dir)) == 1
    # Lease recovery reoffers the same claim on a later cycle (fresh module
    # load = collector restart); dedupe must converge on the existing record
    # and ack the reoffered claim without a second lifecycle file.
    mod2 = _load_mod_with_dirs(state_dir, outbox_dir)
    result2, ack_actions2 = _drive(
        mod2, state_dir, outbox_dir,
        records=[record], ack_effects={}, claim_exists=True,
    )
    assert result2.get("processed") == 1
    assert ack_actions2 == ["ack"]
    assert len(_outbox_events(outbox_dir)) == 1


def test_relay_event_failure_still_requeues_without_probe(tmp_state):
    """Negative control: a LOCAL write failure means the claim was never
    consumed — requeue is correct and the probe must not run."""
    state_dir, outbox_dir = tmp_state
    mod = _load_mod_with_dirs(state_dir, outbox_dir)
    probe_calls: list[str] = []

    def fake_ssh_json_lines(h, script, args, timeout):
        if script == mod.REMOTE_CLAIM_SCRIPT:
            return [_claim_record("evt-local-fail")]
        return []

    ack_actions: list[str] = []

    def fake_remote_ack(host, claim, remote_root, action, timeout):
        ack_actions.append(action)
        return "ok"

    with _env(state_dir, outbox_dir):
        with patch.object(mod, "ssh_json_lines", side_effect=fake_ssh_json_lines), \
             patch.object(mod, "remote_ack", side_effect=fake_remote_ack), \
             patch.object(mod, "remote_failure_context", return_value=([], {})), \
             patch.object(mod, "relay_event", side_effect=RuntimeError("disk full")), \
             patch.object(mod, "remote_claim_exists",
                          side_effect=lambda *a, **k: probe_calls.append("probe") or True,
                          create=True):
            result = _run_once_defaults(mod, [REMOTE])
    assert result.get("failed") == 1
    assert ack_actions == ["requeue"]
    assert probe_calls == []
    assert '"type": "relay_failed"' in _log_text(state_dir)
