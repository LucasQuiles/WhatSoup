"""Typed durable-outcome consumption for collector publications."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from deploy.scripts.lib import durable_json


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-collector.py"


def _load_collector():
    spec = importlib.util.spec_from_file_location("bot_errors_collector_durable", _SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _unproven(component: str, *, generation: int | None) -> durable_json.PublicationResult:
    return durable_json.PublicationResult(
        component=component,
        durability=durable_json.DurabilityProof.UNPROVEN,
        confinement=durable_json.ConfinementProof.PROVEN,
        cleanup=durable_json.CleanupState.NOT_REQUIRED,
        authority=durable_json.AuthorityState.UNKNOWN,
        stage=durable_json.WriteStage.PARENT_SYNC,
        error_class=durable_json.ErrorClass.IO,
        generation=generation,
        private_operation_id="private-operation",
        private_content_sha256="private-digest",
    )


def test_collector_state_rejects_unproven_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load_collector()
    monkeypatch.setattr(module, "state_root", lambda: tmp_path / "state")
    monkeypatch.setattr(
        module,
        "publish_state_json",
        lambda *_args, **_kwargs: _unproven("collector.state", generation=1),
        raising=False,
    )

    with pytest.raises(RuntimeError) as raised:
        module.save_state({"remotes": {}})

    assert type(raised.value).__name__ == "DurableWriteError"
    assert not module.state_path().exists()


def test_collector_event_rejects_unproven_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load_collector()
    monkeypatch.setattr(module, "state_root", lambda: tmp_path / "state")
    monkeypatch.setattr(
        module,
        "publish_event_json",
        lambda *_args, **_kwargs: _unproven(
            "collector.local_outbox_event",
            generation=None,
        ),
        raising=False,
    )

    with pytest.raises(RuntimeError) as raised:
        module._emit_collector_outbox_event(
            "host-a:/state",
            "relay-state",
            "alert",
            "critical",
            "summary",
            "evidence",
            "fixture",
        )

    assert type(raised.value).__name__ == "DurableWriteError"
    assert list((tmp_path / "state" / "outbox").glob("*.json")) == []


def test_collector_diagnostic_state_reports_unproven_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load_collector()
    monkeypatch.setattr(module, "state_root", lambda: tmp_path / "state")
    monkeypatch.setattr(
        module,
        "publish_state_json",
        lambda *_args, **_kwargs: _unproven(
            "collector.controller_log_health",
            generation=1,
        ),
        raising=False,
    )

    with pytest.raises(RuntimeError) as raised:
        module.persist_controller_log_health({"state": "degraded"})

    assert type(raised.value).__name__ == "DurableWriteError"
