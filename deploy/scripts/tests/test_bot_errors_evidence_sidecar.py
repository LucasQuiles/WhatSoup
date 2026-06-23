"""B2 — evidence sidecar on truncation.

When evidence exceeds MAX_EVIDENCE_CHARS, the full (redacted) evidence is written
to a private sidecar file (reusing the existing private-dir / atomic-write
helpers) and the truncated text + a new event field ``evidenceSidecarRef``
reference its path. Fail-open: a sidecar write error falls back to plain
truncation and never loses the alert.

Evidence within the cap produces no sidecar and no ref.
"""
from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path

import pytest

_SCRIPT_ROOT = Path(__file__).resolve().parents[1]


def _load_emit():
    spec = importlib.util.spec_from_file_location("bot_errors_emit", _SCRIPT_ROOT / "bot-errors-emit.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _args(evidence: str) -> argparse.Namespace:
    return argparse.Namespace(
        event_type="alert",
        clear=False,
        event_id="fixed-id",
        severity="critical",
        instance="whatsoup-prod",
        source="big_evidence",
        summary="too much evidence",
        evidence=evidence,
        evidence_file=None,
        log_hint=None,
        diagnostic=None,
        critical_asset_json=None,
        print_path=False,
    )


def _isolate(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("PYTEST_CURRENT_TEST", "sidecar")  # keep test-isolation paths


def test_evidence_under_cap_has_no_sidecar(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    emit = _load_emit()
    _isolate(monkeypatch, tmp_path)
    event = emit.build_event(_args("short evidence"))
    assert "evidenceSidecarRef" not in event
    assert event["evidence"] == "short evidence"


def test_evidence_over_cap_writes_sidecar_and_ref(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    emit = _load_emit()
    _isolate(monkeypatch, tmp_path)
    big = "A" * (emit.MAX_EVIDENCE_CHARS + 5000)
    event = emit.build_event(_args(big))

    ref = event.get("evidenceSidecarRef")
    assert ref, "expected evidenceSidecarRef on truncated event"
    sidecar = Path(ref)
    assert sidecar.exists(), "sidecar file should be written"
    # Full evidence preserved in the sidecar.
    assert sidecar.read_text(encoding="utf-8").count("A") >= emit.MAX_EVIDENCE_CHARS
    # Truncated evidence references the sidecar path so it is reachable.
    assert len(event["evidence"]) <= emit.MAX_EVIDENCE_CHARS
    assert ref in event["evidence"]


def test_sidecar_write_failure_falls_back_to_plain_truncation(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    emit = _load_emit()
    _isolate(monkeypatch, tmp_path)

    def boom(*_a, **_k):
        raise OSError("sidecar disk full")

    monkeypatch.setattr(emit, "write_evidence_sidecar", boom)
    big = "B" * (emit.MAX_EVIDENCE_CHARS + 5000)
    event = emit.build_event(_args(big))

    # Fail-open: the alert is still built, evidence still truncated, no ref.
    assert "evidenceSidecarRef" not in event
    assert len(event["evidence"]) <= emit.MAX_EVIDENCE_CHARS
    assert "[truncated" in event["evidence"]
