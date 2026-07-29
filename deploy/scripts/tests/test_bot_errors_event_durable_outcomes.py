"""Fail-closed durable-outcome consumption for event producers."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest

from deploy.scripts.lib import durable_json


_SCRIPT_ROOT = Path(__file__).resolve().parents[1]


def _load_script(file_name: str, module_name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(module_name, _SCRIPT_ROOT / file_name)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _event() -> dict[str, object]:
    return {
        "id": "event-1",
        "createdAt": "2026-07-28T00:00:00Z",
        "instance": "fixture",
        "source": "durability-test",
    }


def _unproven(component: str) -> durable_json.PublicationResult:
    return durable_json.PublicationResult(
        component=component,
        durability=durable_json.DurabilityProof.UNPROVEN,
        confinement=durable_json.ConfinementProof.PROVEN,
        cleanup=durable_json.CleanupState.NOT_REQUIRED,
        authority=durable_json.AuthorityState.UNKNOWN,
        stage=durable_json.WriteStage.PARENT_SYNC,
        error_class=durable_json.ErrorClass.IO,
        generation=None,
        private_operation_id="private-operation",
        private_content_sha256="private-digest",
    )


@pytest.mark.parametrize(
    ("file_name", "module_name", "component"),
    [
        ("bot-errors-emit.py", "bot_errors_emit_durable", "emit.event"),
        ("bot-errors-runner.py", "bot_errors_runner_durable", "runner.event"),
    ],
)
def test_event_writer_rejects_unproven_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    file_name: str,
    module_name: str,
    component: str,
) -> None:
    module = _load_script(file_name, module_name)
    outbox = tmp_path / "outbox"
    monkeypatch.setattr(module, "outbox_dir", lambda: outbox)
    monkeypatch.setattr(
        module,
        "publish_event_json",
        lambda *_args, **_kwargs: _unproven(component),
    )

    with pytest.raises(RuntimeError) as raised:
        module.write_event(_event())

    assert type(raised.value).__name__ == "DurableWriteError"
    assert list(outbox.glob("*")) == []


@pytest.mark.parametrize(
    ("file_name", "module_name", "component"),
    [
        ("bot-errors-emit.py", "bot_errors_emit_writefail", "emit.writefail"),
        ("bot-errors-runner.py", "bot_errors_runner_writefail", "runner.writefail"),
    ],
)
def test_writefail_breadcrumb_does_not_report_unproven_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    file_name: str,
    module_name: str,
    component: str,
) -> None:
    module = _load_script(file_name, module_name)
    fallback = tmp_path / "writefail"
    monkeypatch.setattr(module, "writefail_dirs", lambda: [fallback])
    monkeypatch.setattr(
        module,
        "publish_event_json",
        lambda *_args, **_kwargs: _unproven(component),
    )

    written = module.record_writefail(
        _event(),
        OSError("injected primary failure"),
        tmp_path / "outbox",
    )

    assert written is None
    assert list(fallback.glob("*")) == []


def test_evidence_sidecar_rejects_unproven_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = _load_script("bot-errors-emit.py", "bot_errors_emit_sidecar_durable")
    evidence = tmp_path / "evidence"
    monkeypatch.setattr(module, "evidence_sidecar_dir", lambda: evidence)
    monkeypatch.setattr(
        module,
        "publish_event_json",
        lambda *_args, **_kwargs: _unproven("emit.evidence_sidecar"),
    )

    with pytest.raises(RuntimeError) as raised:
        module.write_evidence_sidecar("event-1", "redacted evidence")

    assert type(raised.value).__name__ == "DurableWriteError"
    assert list(evidence.glob("*")) == []
