#!/usr/bin/env python3
"""Tests for tools/run_ledger redacted append-only telemetry."""
import json
import importlib.util
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import run_ledger  # noqa: E402


def test_module_reloads_under_trace_for_coverage():
    path = Path(__file__).resolve().parents[1] / "tools/run_ledger.py"
    spec = importlib.util.spec_from_file_location("run_ledger_reloaded_for_coverage", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert module.SCHEMA == run_ledger.SCHEMA
    assert module.make_header()["schema_version"] == run_ledger.SCHEMA_VERSION


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_record_appends_valid_redacted_jsonl_with_header_self_hash():
    with tempfile.TemporaryDirectory(prefix="run-ledger-test-") as tmp_dir:
        ledger = Path(tmp_dir) / "sentinel/ledger.jsonl"

        status = run_ledger.record({
            "kind": "probe",
            "name": "sk-secretshape123456",
            "duration_ms": 12,
            "exit": 0,
            "schema_version": "0.1",
            "leak_hits": 1,
            "_error": "Bearer abcdefghijklmnop",
        }, ledger_path=ledger, recent_n=10)

        lines = read_jsonl(ledger)
        rendered = ledger.read_text(encoding="utf-8")
        assert status["status"] == "ok", status
        assert lines[0]["type"] == "header", lines
        assert lines[0]["schema_version"] == run_ledger.SCHEMA_VERSION, lines[0]
        assert lines[0]["self_hash"] == run_ledger.self_hash(lines[0]), lines[0]
        assert lines[1]["type"] == "run", lines
        assert lines[1]["self_hash"] == run_ledger.self_hash(lines[1]), lines[1]
        assert lines[1]["name"] == "<redacted:value>", lines[1]
        assert "sk-secretshape123456" not in rendered
        assert "abcdefghijklmnop" not in rendered


def test_concurrent_records_do_not_corrupt_jsonl():
    with tempfile.TemporaryDirectory(prefix="run-ledger-concurrency-") as tmp_dir:
        ledger = Path(tmp_dir) / "ledger.jsonl"
        code = (
            "from pathlib import Path; import run_ledger; "
            "run_ledger.record({'kind':'probe','name':'worker','duration_ms':1,'exit':0,'leak_hits':0}, "
            f"ledger_path=Path({str(ledger)!r}), recent_n=20)"
        )
        env = {**os.environ, "PYTHONPATH": f"{Path(__file__).resolve().parents[1] / 'tools'}:{Path(__file__).resolve().parents[1]}"}
        procs = [subprocess.Popen([sys.executable, "-c", code], env=env) for _ in range(6)]
        exits = [proc.wait(timeout=10) for proc in procs]

        parsed = run_ledger.parse_lines(ledger)
        assert exits == [0] * 6, exits
        assert parsed["status"] == "ok", parsed
        assert len(parsed["events"]) == 6, parsed


def test_rotation_keeps_recent_n_events_exactly():
    with tempfile.TemporaryDirectory(prefix="run-ledger-rotation-") as tmp_dir:
        ledger = Path(tmp_dir) / "ledger.jsonl"
        for idx in range(5):
            run_ledger.record({
                "kind": "probe",
                "name": f"probe-{idx}",
                "duration_ms": idx,
                "exit": 0,
                "leak_hits": 0,
            }, ledger_path=ledger, recent_n=3)

        parsed = run_ledger.parse_lines(ledger)
        assert parsed["status"] == "ok", parsed
        assert [event["name"] for event in parsed["events"]] == ["probe-2", "probe-3", "probe-4"], parsed


def test_missing_and_corrupt_ledger_are_typed_statuses():
    with tempfile.TemporaryDirectory(prefix="run-ledger-corrupt-") as tmp_dir:
        missing = Path(tmp_dir) / "missing.jsonl"
        corrupt = Path(tmp_dir) / "corrupt.jsonl"
        non_object = Path(tmp_dir) / "non-object.jsonl"
        unknown = Path(tmp_dir) / "unknown.jsonl"
        bad_json = Path(tmp_dir) / "bad-json.jsonl"
        corrupt.write_text('{"type":"header","schema_version":"0.1","self_hash":"bad"}\n', encoding="utf-8")
        non_object.write_text("[]\n", encoding="utf-8")
        unknown.write_text(json.dumps(run_ledger.with_self_hash({"type": "mystery"})) + "\n", encoding="utf-8")
        bad_json.write_text("{bad\n", encoding="utf-8")

        assert run_ledger.parse_lines(missing)["status"] == "no_ledger"
        parsed = run_ledger.parse_lines(corrupt)
        compacted = run_ledger.compact_recent(corrupt, 1)
        assert parsed["status"] == "ledger_corrupt", parsed
        assert parsed["error_type"] == "self_hash_mismatch", parsed
        assert compacted["status"] == "ledger_corrupt", compacted
        assert run_ledger.parse_lines(non_object)["error_type"] == "non_object_line"
        assert run_ledger.parse_lines(unknown)["error_type"] == "unknown_record_type"
        assert run_ledger.parse_lines(bad_json)["error_type"] == "JSONDecodeError"
        assert run_ledger.summarize(missing)["status"] == "no_ledger"


def test_parse_lines_handles_read_error_and_blank_lines():
    class UnreadableLedger:
        def exists(self):
            return True

        def read_text(self, encoding="utf-8"):
            raise OSError("cannot read")

    with tempfile.TemporaryDirectory(prefix="run-ledger-read-error-") as tmp_dir:
        ledger = Path(tmp_dir) / "ledger.jsonl"
        header = run_ledger.make_header()
        ledger.write_text("\n" + json.dumps(header, sort_keys=True) + "\n", encoding="utf-8")

        unreadable = run_ledger.parse_lines(UnreadableLedger())
        parsed = run_ledger.parse_lines(ledger)

        assert unreadable["status"] == "ledger_error", unreadable
        assert unreadable["error_type"] == "OSError", unreadable
        assert parsed["status"] == "ok", parsed
        assert len(parsed["headers"]) == 1, parsed


def test_normalize_event_handles_redactor_malfunction():
    original_redact = run_ledger.redact
    try:
        run_ledger.redact = lambda _value: "not-a-dict"
        event = run_ledger.normalize_event({"kind": "probe", "name": "x", "duration_ms": 1, "exit": 0, "leak_hits": 0})
    finally:
        run_ledger.redact = original_redact

    assert event["_error"] == "redaction_returned_non_object", event
    assert event["name"] == "unknown", event


def test_compaction_failed_replace_cleans_temp_file():
    with tempfile.TemporaryDirectory(prefix="run-ledger-replace-failure-") as tmp_dir:
        ledger = Path(tmp_dir) / "ledger.jsonl"
        run_ledger.record({"kind": "probe", "name": "replace-fail", "duration_ms": 0, "exit": 0, "leak_hits": 0}, ledger_path=ledger)
        original_replace = run_ledger.os.replace
        try:
            def fail_replace(_src, _dst):
                raise RuntimeError("replace failed")

            run_ledger.os.replace = fail_replace
            try:
                run_ledger.compact_recent(ledger, 1)
            except RuntimeError as exc:
                assert str(exc) == "replace failed", exc
            else:
                raise AssertionError("compact_recent should propagate replace failure")
        finally:
            run_ledger.os.replace = original_replace

        assert list(Path(tmp_dir).glob(".ledger.jsonl.*.tmp")) == []


def test_record_write_failure_returns_degraded_marker():
    with tempfile.TemporaryDirectory(prefix="run-ledger-degraded-") as tmp_dir:
        blocker = Path(tmp_dir) / "not-a-directory"
        blocker.write_text("x", encoding="utf-8")
        ledger = blocker / "ledger.jsonl"

        status = run_ledger.record({
            "kind": "probe",
            "name": "blocked-ledger",
            "duration_ms": 1,
            "exit": 0,
            "leak_hits": 0,
        }, ledger_path=ledger)

        assert status["status"] == "degraded", status
        assert status["error_type"] in {"FileExistsError", "NotADirectoryError"}, status
        assert "_error" in status, status


def test_record_disabled_env_path_and_no_rotation_paths():
    with tempfile.TemporaryDirectory(prefix="run-ledger-env-") as tmp_dir:
        ledger = Path(tmp_dir) / "env-ledger.jsonl"
        original_path = os.environ.get("AGENT_RUNTIME_LEDGER_PATH")
        original_disable = os.environ.get("AGENT_RUNTIME_LEDGER_DISABLE")
        try:
            os.environ["AGENT_RUNTIME_LEDGER_DISABLE"] = "1"
            disabled = run_ledger.record({"kind": "probe", "name": "disabled", "duration_ms": 0, "exit": 0, "leak_hits": 0}, ledger_path=ledger)
            os.environ.pop("AGENT_RUNTIME_LEDGER_DISABLE", None)
            os.environ["AGENT_RUNTIME_LEDGER_PATH"] = str(ledger)
            status = run_ledger.record({"kind": "probe", "name": "env-path", "duration_ms": 0, "exit": 0, "leak_hits": 0}, recent_n=None)
        finally:
            if original_path is None:
                os.environ.pop("AGENT_RUNTIME_LEDGER_PATH", None)
            else:
                os.environ["AGENT_RUNTIME_LEDGER_PATH"] = original_path
            if original_disable is None:
                os.environ.pop("AGENT_RUNTIME_LEDGER_DISABLE", None)
            else:
                os.environ["AGENT_RUNTIME_LEDGER_DISABLE"] = original_disable

        parsed = run_ledger.parse_lines(ledger)
        assert disabled["status"] == "disabled", disabled
        assert status["rotation"]["status"] == "skipped", status
        assert parsed["events"][0]["name"] == "env-path", parsed


def test_compaction_negative_n_keeps_all_events_and_count_empty_text_hits():
    with tempfile.TemporaryDirectory(prefix="run-ledger-negative-") as tmp_dir:
        ledger = Path(tmp_dir) / "ledger.jsonl"
        for idx in range(2):
            run_ledger.record({"kind": "probe", "name": f"p{idx}", "duration_ms": 0, "exit": 0, "leak_hits": 0}, ledger_path=ledger, recent_n=10)

        compacted = run_ledger.compact_recent(ledger, -1)

        assert compacted["status"] == "ok", compacted
        assert compacted["kept"] == 2, compacted
        assert run_ledger.count_secret_hits("") == 0


def test_summary_reports_run_count_pass_rate_and_trends():
    with tempfile.TemporaryDirectory(prefix="run-ledger-summary-") as tmp_dir:
        ledger = Path(tmp_dir) / "ledger.jsonl"
        run_ledger.record({"kind": "coverage", "name": "coverage_check.py", "duration_ms": 1, "exit": 0, "leak_hits": 0, "coverage_pct": 98.5}, ledger_path=ledger)
        run_ledger.record({"kind": "probe", "name": "bad.py", "duration_ms": 1, "exit": 2, "leak_hits": 3}, ledger_path=ledger)

        summary = run_ledger.summarize(ledger)

        assert summary["status"] == "ok", summary
        assert summary["run_count"] == 2, summary
        assert summary["pass_rate"] == 0.5, summary
        assert summary["leak_trend"]["latest"] == 3, summary
        assert summary["coverage_trend"]["latest"] == 98.5, summary


def test_cli_summary_compact_and_default_status_paths():
    with tempfile.TemporaryDirectory(prefix="run-ledger-cli-") as tmp_dir:
        ledger = Path(tmp_dir) / "ledger.jsonl"
        run_ledger.record({"kind": "probe", "name": "cli", "duration_ms": 1, "exit": 0, "leak_hits": 0}, ledger_path=ledger)
        old_argv = sys.argv[:]
        try:
            sys.argv = ["run_ledger.py", "--ledger", str(ledger), "--summary"]
            assert run_ledger.main() == 0
            sys.argv = ["run_ledger.py", "--ledger", str(ledger), "--compact", "1"]
            assert run_ledger.main() == 0
            sys.argv = ["run_ledger.py", "--ledger", str(ledger)]
            assert run_ledger.main() == 0
            sys.argv = ["run_ledger.py", "--ledger", str(Path(tmp_dir) / "missing.jsonl")]
            assert run_ledger.main() == 0
        finally:
            sys.argv = old_argv


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} run-ledger tests passed")
