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


# #2358 C9/C10 fixture: the observer and the target resolve to different
# release commits while each side stays internally consistent.
_OBSERVER_RELEASE_SHA = "1450192837" * 4
_TARGET_RELEASE_SHA = "8675309124" * 4
_TARGET_MANIFEST_DIGEST = "9078451236" * 6 + "abcd"
_TARGET_CWD = "/srv/release"


def _new_block_keys() -> set[str]:
    return {"observerProvenance", "targetProvenance", "releaseDivergence"}


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


def test_runner_envelope_names_the_target_when_releases_diverge(tmp_path, monkeypatch):
    """#2358 C10: the originating defect. The producer ran from a different
    checkout than the service it inspected, and the envelope has to say so --
    naming the TARGET as the differing party, never the observer."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    mod = _load("bot_errors_runner_2358_divergence", _RUNNER)
    tp = sys.modules["lib.target_provenance"]

    def commit_for(cwd):
        return _TARGET_RELEASE_SHA if cwd == _TARGET_CWD else _OBSERVER_RELEASE_SHA

    monkeypatch.setattr(
        tp, "default_probes",
        lambda platform: tp.TargetProbes(
            platform=platform,
            service_state=lambda unit: "active",
            service_pids=lambda unit: [4242],
            process_started_epoch=lambda pid: 1_750_000_000,
            process_cwd=lambda pid: _TARGET_CWD,
            release_receipt=lambda cwd: {
                "manifestDigest": _TARGET_MANIFEST_DIGEST,
                "sourceCommit": commit_for(cwd),
            },
            git_head=commit_for,
            now_iso=lambda: "2026-08-26T00:00:00Z",
        ),
    )
    event = mod.build_failure_event(_runner_args("probe-instance"), ["true"], 1, 5, "", "boom", "nonzero_exit")

    observer = event["observerProvenance"]
    target = event["targetProvenance"]
    # Precondition, so this cannot pass vacuously if both sides ever resolve
    # to the same commit: the two releases really do differ, and each block
    # agrees with itself, so only the cross-block axis is under test.
    assert observer["release"]["sourceCommit"] == _OBSERVER_RELEASE_SHA
    assert target["release"]["sourceCommit"] == _TARGET_RELEASE_SHA
    assert observer["release"]["sourceCommit"] != target["release"]["sourceCommit"]
    assert observer["release"]["agreement"] == "agree"
    assert target["release"]["agreement"] == "agree"

    divergence = event["releaseDivergence"]
    assert divergence["classification"] == "diverged"
    assert divergence["divergentParty"] == "target"


def test_health_outbox_event_names_the_target_when_releases_diverge(tmp_path, monkeypatch):
    """The health check attaches the verdict through redact_json_value, which
    the runner path does not. Redaction must not disturb the classification."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(tmp_path / "outbox"))
    mod = _load("bot_errors_health_2358_divergence", _HEALTH)
    tp = sys.modules["lib.target_provenance"]

    def commit_for(cwd):
        return _TARGET_RELEASE_SHA if cwd == _TARGET_CWD else _OBSERVER_RELEASE_SHA

    monkeypatch.setattr(
        tp, "default_probes",
        lambda platform: tp.TargetProbes(
            platform=platform,
            service_state=lambda unit: "active",
            service_pids=lambda unit: [4242],
            process_started_epoch=lambda pid: 1_750_000_000,
            process_cwd=lambda pid: _TARGET_CWD,
            release_receipt=lambda cwd: {
                "manifestDigest": _TARGET_MANIFEST_DIGEST,
                "sourceCommit": commit_for(cwd),
            },
            git_head=commit_for,
            now_iso=lambda: "2026-08-26T00:00:00Z",
        ),
    )
    path = mod.outbox_event(
        "probe summary",
        "FAIL auth_bond probe-line: physical_intervention_required",
        severity="critical",
        source="daily-health",
    )
    event = json.loads(Path(path).read_text())

    assert event["instance"] == "probe-line"
    # Precondition: the two releases really differ once redaction has run.
    assert event["observerProvenance"]["release"]["sourceCommit"] == _OBSERVER_RELEASE_SHA
    assert event["targetProvenance"]["release"]["sourceCommit"] == _TARGET_RELEASE_SHA

    divergence = event["releaseDivergence"]
    assert divergence["classification"] == "diverged"
    assert divergence["divergentParty"] == "target"


def test_health_self_event_has_no_divergence_verdict(tmp_path, monkeypatch):
    """A producer-self event carries no target block, so there is nothing to
    diverge from and no verdict to attach -- rather than a vacuous one."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(tmp_path / "outbox"))
    mod = _load("bot_errors_health_2358_self_divergence", _HEALTH)
    path = mod.outbox_event(
        "probe summary",
        "FAIL outbox: queue write latency",
        severity="warning",
        source="daily-health",
    )
    event = json.loads(Path(path).read_text())

    assert event["instance"] == "bot-errors-health"
    assert "targetProvenance" not in event
    assert "releaseDivergence" not in event


def _raise_classifier_defect(observer, target):
    raise RuntimeError("classifier defect")


def _break_the_classifier(monkeypatch, producer_module):
    """Break every binding a producer could reach the classifier through.

    The producer imports its wrapper by name, and the wrapper resolves the
    classifier through module globals, so patching the library binding is what
    exercises the wrapper. The producer-local binding is patched too, with
    raising=False, so this test cannot pass merely because a producer stopped
    calling the classifier under that name.
    """
    tp = sys.modules["lib.target_provenance"]
    monkeypatch.setattr(tp, "classify_release_divergence", _raise_classifier_defect)
    monkeypatch.setattr(
        producer_module, "classify_release_divergence", _raise_classifier_defect, raising=False
    )


def test_runner_event_survives_a_classifier_defect(tmp_path, monkeypatch):
    """build_failure_event is called outside the alert-preserving try, so a
    raise in the classifier would lose the alert entirely rather than degrade
    it. The verdict must fail closed instead."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(tmp_path / "outbox"))
    mod = _load("bot_errors_runner_2358_defect", _RUNNER)
    _break_the_classifier(monkeypatch, mod)

    event = mod.build_failure_event(_runner_args("probe-instance"), ["true"], 1, 5, "", "boom", "nonzero_exit")
    written = mod.write_event(event)

    assert Path(written).is_file()
    assert event["targetProvenance"]["role"] == "target"
    divergence = event["releaseDivergence"]
    assert divergence["classification"] == "not_comparable"
    assert divergence["notes"] == ["classifier_error"]


def test_health_outbox_event_survives_a_classifier_defect(tmp_path, monkeypatch):
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("BOT_ERRORS_OUTBOX_DIR", str(tmp_path / "outbox"))
    mod = _load("bot_errors_health_2358_defect", _HEALTH)
    _break_the_classifier(monkeypatch, mod)

    path = mod.outbox_event(
        "probe summary",
        "FAIL auth_bond probe-line: physical_intervention_required",
        severity="critical",
        source="daily-health",
    )
    event = json.loads(Path(path).read_text())

    assert event["instance"] == "probe-line"
    divergence = event["releaseDivergence"]
    assert divergence["classification"] == "not_comparable"
    assert divergence["notes"] == ["classifier_error"]


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
