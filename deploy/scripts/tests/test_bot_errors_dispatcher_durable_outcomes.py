"""Typed durable-outcome consumption for dispatcher publications."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from deploy.scripts.lib import durable_json


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load_dispatcher():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_dispatcher_durable",
        _SCRIPT,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _unproven(
    component: str,
    *,
    generation: int | None,
) -> durable_json.PublicationResult:
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


def _paths(module, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state"))
    return module.setup_dirs()


def test_dispatcher_state_rejects_unproven_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load_dispatcher()
    paths = _paths(module, tmp_path, monkeypatch)
    monkeypatch.setattr(
        module,
        "publish_state_json",
        lambda *_args, **_kwargs: _unproven("dispatcher.state", generation=1),
        raising=False,
    )

    with pytest.raises(RuntimeError) as raised:
        module.record_state(paths, status="fixture")

    assert type(raised.value).__name__ == "DurableWriteError"
    assert not paths["state"].exists()


def test_dead_letter_does_not_retire_source_when_publication_is_unproven(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load_dispatcher()
    paths = _paths(module, tmp_path, monkeypatch)
    claimed = paths["processing"] / "event.processing"
    claimed.write_text('{"id":"fixture"}\n', encoding="utf-8")
    claimed.chmod(0o600)
    monkeypatch.setattr(
        module,
        "publish_event_json",
        lambda *_args, **_kwargs: _unproven(
            "dispatcher.dead_letter_record",
            generation=None,
        ),
        raising=False,
    )

    with pytest.raises(RuntimeError) as raised:
        module.move_to_dead_letter(
            claimed,
            paths,
            {"id": "fixture", "delivery": {}},
            "fixture.json",
        )

    assert type(raised.value).__name__ == "DurableWriteError"
    assert claimed.exists()
    assert list(paths["dead_letter"].glob("*.json")) == []


def test_dead_letter_meta_alert_does_not_advance_state_when_event_is_unproven(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load_dispatcher()
    paths = _paths(module, tmp_path, monkeypatch)
    dead = paths["dead_letter"] / "fixture.json"
    dead.write_text(
        '{"event":{"summary":"fixture"}}\n',
        encoding="utf-8",
    )
    dead.chmod(0o600)
    monkeypatch.setattr(
        module,
        "publish_event_json",
        lambda *_args, **_kwargs: _unproven(
            "dispatcher.dead_letter_meta_alert",
            generation=None,
        ),
        raising=False,
    )

    with pytest.raises(RuntimeError) as raised:
        module.queue_dead_letter_meta_alert(paths, now=1_700_000_000)

    assert type(raised.value).__name__ == "DurableWriteError"
    assert not paths["meta_state"].exists()
    assert list(paths["outbox"].glob("*.json")) == []


def test_reclaim_processing_ignores_durable_internal_entries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load_dispatcher()
    paths = _paths(module, tmp_path, monkeypatch)
    lock_entry = paths["processing"] / ".durable-json.lock"
    lock_entry.write_text("", encoding="utf-8")
    lock_entry.chmod(0o600)
    temp_entry = paths["processing"] / ".durable-json.fixture.tmp"
    temp_entry.write_text('{"id":"internal"}\n', encoding="utf-8")
    temp_entry.chmod(0o600)

    reclaimed = module.reclaim_processing(paths)

    assert reclaimed == 0
    assert lock_entry.exists()
    assert temp_entry.exists()
    assert list(paths["outbox"].iterdir()) == []
