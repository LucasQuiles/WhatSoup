"""B3 — inline bounded log tail for locally-emitted events.

``capture_log_tail`` reads the last lines of the primary local log (LOG_DIR/
whatsoup.log or state logs), REDACTS via the existing redact(), bounds the
output within a char/line budget, and build_event attaches it as an evidence
section. Env-gated BOT_ERRORS_INLINE_LOG_TAIL (default on). Fail-open: a missing
log or read error yields no section and never raises.
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


def _args(evidence: str = "base evidence") -> argparse.Namespace:
    return argparse.Namespace(
        event_type="alert",
        clear=False,
        event_id="fixed-id",
        severity="critical",
        instance="whatsoup-prod",
        source="needs_log_tail",
        summary="something failed",
        evidence=evidence,
        evidence_file=None,
        log_hint=None,
        diagnostic=None,
        critical_asset_json=None,
        print_path=False,
    )


def _isolate(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, log_file: Path) -> None:
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("PYTEST_CURRENT_TEST", "logtail")
    monkeypatch.setenv("LOG_DIR", str(log_file.parent))


def test_log_tail_present_redacted_and_bounded(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    emit = _load_emit()
    log = tmp_path / "logs" / "whatsoup.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    # 200 lines; only the tail should appear, and a secret must be redacted.
    lines = [f"line-{i} routine" for i in range(200)]
    lines.append("token=supersecretvalue123456")
    lines.append("FINAL crash marker")
    log.write_text("\n".join(lines) + "\n", encoding="utf-8")

    monkeypatch.setenv("BOT_ERRORS_INLINE_LOG_TAIL", "1")
    _isolate(monkeypatch, tmp_path, log)

    tail = emit.capture_log_tail("whatsoup-prod", max_chars=1200, max_lines=20)
    assert tail is not None
    assert "FINAL crash marker" in tail
    assert "line-0 routine" not in tail  # head dropped
    assert "supersecretvalue123456" not in tail  # redacted
    assert len(tail) <= 1200
    assert tail.count("\n") <= 20

    event = emit.build_event(_args())
    assert "FINAL crash marker" in event["evidence"]
    assert len(event["evidence"]) <= emit.MAX_EVIDENCE_CHARS


def test_log_tail_absent_no_section_no_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    emit = _load_emit()
    missing_dir = tmp_path / "nope"
    missing_dir.mkdir()
    monkeypatch.setenv("BOT_ERRORS_INLINE_LOG_TAIL", "1")
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("PYTEST_CURRENT_TEST", "logtail")
    monkeypatch.setenv("LOG_DIR", str(missing_dir))

    assert emit.capture_log_tail("whatsoup-prod") is None
    event = emit.build_event(_args("only-base"))
    assert event["evidence"] == "only-base"


def test_log_tail_gate_off_no_section(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    emit = _load_emit()
    log = tmp_path / "logs" / "whatsoup.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text("FINAL crash marker\n", encoding="utf-8")
    monkeypatch.setenv("BOT_ERRORS_INLINE_LOG_TAIL", "0")
    _isolate(monkeypatch, tmp_path, log)

    event = emit.build_event(_args("only-base"))
    assert "FINAL crash marker" not in event["evidence"]
    assert event["evidence"] == "only-base"
