"""B3 — inline bounded log tail for locally-emitted events.

``capture_log_tail`` reads the last lines of the source-specific local log
(LOG_DIR/whatsoup.log), REDACTS via the existing redact(), bounds the output
within a char/line budget, and build_event attaches it as an evidence section.
Env-gated BOT_ERRORS_INLINE_LOG_TAIL (default on). Fail-open: a missing log or
read error yields no section and never raises. Fleet-wide state logs
(dispatcher.out.log, collector.jsonl) are never used as a fallback: their
records carry no correlation to the alerting source, so an alert without a
source-specific log gets no inline tail — log_hints() still points responders
at the fleet-wide files (#2136).
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


def _write_fleet_wide_state_logs(state_dir: Path) -> None:
    state_logs = state_dir / "logs"
    state_logs.mkdir(parents=True, exist_ok=True)
    (state_logs / "dispatcher.out.log").write_text(
        "STALE dispatcher record from an unrelated episode\n", encoding="utf-8"
    )
    (state_logs / "collector.jsonl").write_text(
        '{"source":"unrelated_source","msg":"STALE collector record"}\n', encoding="utf-8"
    )


@pytest.mark.parametrize("log_dir_state", ["empty_dir", "unset"])
def test_fleet_wide_log_alone_produces_no_tail(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, log_dir_state: str
):
    """#2136 — fleet-wide state logs must never stand in for the source log.

    Their records carry no correlation to the alerting source, so when only
    they exist the tail is omitted and the safe log hints remain.
    """
    emit = _load_emit()
    state_dir = tmp_path / "state"
    _write_fleet_wide_state_logs(state_dir)
    monkeypatch.setenv("BOT_ERRORS_INLINE_LOG_TAIL", "1")
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(state_dir))
    monkeypatch.setenv("PYTEST_CURRENT_TEST", "logtail")
    if log_dir_state == "empty_dir":
        empty = tmp_path / "empty-logs"  # no whatsoup.log inside
        empty.mkdir()
        monkeypatch.setenv("LOG_DIR", str(empty))
    else:
        monkeypatch.delenv("LOG_DIR", raising=False)

    assert emit.capture_log_tail("whatsoup-prod") is None
    event = emit.build_event(_args("only-base"))
    assert "STALE" not in event["evidence"]
    assert "local log tail" not in event["evidence"]
    assert event["evidence"] == "only-base"
    assert event["diagnostics"]["logHints"]  # safe hints survive the omission


def test_source_specific_log_wins_over_fleet_wide_logs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """When LOG_DIR/whatsoup.log exists its tail is attached, never the state logs."""
    emit = _load_emit()
    log = tmp_path / "logs" / "whatsoup.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text("SOURCE-SPECIFIC crash marker\n", encoding="utf-8")
    _write_fleet_wide_state_logs(tmp_path / "state")
    monkeypatch.setenv("BOT_ERRORS_INLINE_LOG_TAIL", "1")
    _isolate(monkeypatch, tmp_path, log)

    tail = emit.capture_log_tail("whatsoup-prod")
    assert tail is not None
    assert "SOURCE-SPECIFIC crash marker" in tail
    assert "STALE" not in tail
    event = emit.build_event(_args())
    assert "SOURCE-SPECIFIC crash marker" in event["evidence"]
    assert "STALE" not in event["evidence"]
