"""#2358 envelope wiring: producer envelopes carry separated observer/target
provenance blocks (shadow mode — existing fields untouched).

Red-first fingerprint on pre-fix main: KeyError 'targetProvenance' /
'observerProvenance' — the envelopes only carry the generic producer
``process`` block, so target evidence points at the observer.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from support import dispatcher_fixtures  # noqa: E402

_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
if str(_SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_ROOT))

_HEALTH = _SCRIPT_ROOT / "bot-errors-health-check.py"
_RUNNER = _SCRIPT_ROOT / "bot-errors-runner.py"


_load = dispatcher_fixtures.load_module_from_path


def _runner_args(instance: str) -> argparse.Namespace:
    return argparse.Namespace(
        instance=instance,
        source="process-exit",
        summary="probe summary",
        severity="critical",
        event_id=None,
        cwd=None,
        timeout=None,
        capture_limit=12_000,
        log_hint=None,
        diagnostic=None,
        command=["true"],
    )


def _new_block_keys() -> set[str]:
    return {"observerProvenance", "targetProvenance"}


def test_runner_failure_event_carries_separated_provenance_blocks(tmp_path, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    mod = _load("bot_errors_runner_2358", _RUNNER)
    event = mod.build_failure_event(_runner_args("probe-instance"), ["true"], 1, 5, "", "boom", "nonzero_exit")

    target = event["targetProvenance"]
    observer = event["observerProvenance"]
    assert target["role"] == "target"
    assert target["schemaVersion"] == 1
    assert observer["role"] == "observer"
    assert observer["producer"] == "bot-errors-runner"
    # Shadow mode: the legacy producer block is untouched.
    assert event["process"]["pid"] == os.getpid()


def test_health_outbox_event_carries_separated_provenance_blocks(tmp_path, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(tmp_path / "outbox"))
    mod = _load("bot_errors_health_2358", _HEALTH)
    path = mod.outbox_event(
        "probe summary",
        "FAIL auth_bond probe-line: physical_intervention_required",
        severity="critical",
        source="daily-health",
    )
    event = json.loads(Path(path).read_text())

    assert event["instance"] == "probe-line"
    observer = event["observerProvenance"]
    assert observer["role"] == "observer"
    assert observer["producer"] == "bot-errors-health-check"
    # This envelope names a target instance distinct from the producer, so the
    # target block must exist and must not be a copy of producer identity.
    target = event["targetProvenance"]
    assert target["role"] == "target"
    assert target["schemaVersion"] == 1


def test_health_self_event_has_observer_but_no_target_block(tmp_path, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(tmp_path / "outbox"))
    mod = _load("bot_errors_health_2358_self", _HEALTH)
    path = mod.outbox_event(
        "probe summary",
        "FAIL outbox: queue write latency",
        severity="warning",
        source="daily-health",
    )
    event = json.loads(Path(path).read_text())

    assert event["instance"] == "bot-errors-health"
    assert "observerProvenance" in event
    # A producer-self event has no distinct serving target to attribute.
    assert "targetProvenance" not in event


def test_new_blocks_are_content_free(tmp_path, monkeypatch):
    """No PID, cwd, argv, or path may appear in the new blocks (issue #2358:
    exact process identifiers stay in the legacy private ``process`` block)."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    mod = _load("bot_errors_runner_2358_privacy", _RUNNER)
    event = mod.build_failure_event(_runner_args("probe-instance"), ["true"], 1, 5, "", "boom", "nonzero_exit")

    for key in _new_block_keys():
        serialized = json.dumps(event[key])
        assert '"pid"' not in serialized
        assert '"cwd"' not in serialized
        assert '"argv"' not in serialized
        assert str(os.getpid()) not in serialized
        assert os.getcwd() not in serialized
        assert sys.executable not in serialized


def test_target_block_never_copies_producer_values(tmp_path, monkeypatch):
    """Fail-closed rule: an unresolvable target yields unknown fields — the
    producer's own release digests must not leak into target fields."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    mod = _load("bot_errors_runner_2358_nocopy", _RUNNER)
    tp = sys.modules["lib.target_provenance"]
    # The observer's own checkout receipt stays resolvable; every TARGET probe
    # fails. The target block must come out all-unknown, not observer-shaped.
    monkeypatch.setattr(
        tp, "default_probes",
        lambda platform: tp.TargetProbes(
            platform=platform,
            service_state=lambda unit: None,
            service_pids=lambda unit: None,
            process_started_epoch=lambda pid: None,
            process_cwd=lambda pid: None,
            release_receipt=lambda cwd: {"manifestDigest": "d" * 64, "sourceCommit": None},
            git_head=lambda cwd: None,
            now_iso=lambda: "2026-08-26T00:00:00Z",
        ),
    )
    event = mod.build_failure_event(_runner_args("probe-instance"), ["true"], 1, 5, "", "boom", "nonzero_exit")

    target = event["targetProvenance"]
    observer = event["observerProvenance"]
    assert target["state"] == "unknown"
    assert target["resolution"] == "unknown"
    assert target["release"]["manifestDigest"] is None
    assert target["release"]["sourceCommit"] is None
    assert target["release"]["gitHead"] is None
    # The observer's own release evidence exists (repo checkout) yet none of it
    # was copied into the unresolved target block.
    assert observer["release"]["manifestDigest"] is not None
    assert target["release"] != observer["release"]
