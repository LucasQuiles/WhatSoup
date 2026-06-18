#!/usr/bin/env python3
"""Tests for tools/coverage_check fail-closed runner behavior."""
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path


def load_coverage_check():
    path = Path(__file__).resolve().parents[1] / "tools/coverage_check.py"
    spec = importlib.util.spec_from_file_location("coverage_check_under_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_coverage_check_returns_nonzero_when_measured_test_fails():
    module = load_coverage_check()
    with tempfile.TemporaryDirectory(prefix="coverage-check-") as tmp_dir:
        root = Path(tmp_dir)
        probe = root / "dummy_probe.py"
        test = root / "tests/test_failing.py"
        test.parent.mkdir()
        probe.write_text("def covered():\n    return 1\n", encoding="utf-8")
        test.write_text("raise RuntimeError('intentional fail closed canary')\n", encoding="utf-8")

        original_probe_dir = module.PROBE_DIR
        original_probe_real = module.probe_real
        original_executed = module.executed
        original_cls = module._cls
        original_argv = sys.argv[:]
        original_disable = os.environ.get("AGENT_RUNTIME_LEDGER_DISABLE")
        try:
            module.PROBE_DIR = str(root)
            module.probe_real = {os.path.realpath(probe): str(probe)}
            module.executed = {os.path.realpath(probe): set()}
            module._cls = {}
            sys.argv = ["coverage_check.py"]
            os.environ["AGENT_RUNTIME_LEDGER_DISABLE"] = "1"
            rc = module.main()
        finally:
            module.PROBE_DIR = original_probe_dir
            module.probe_real = original_probe_real
            module.executed = original_executed
            module._cls = original_cls
            sys.argv = original_argv
            if original_disable is None:
                os.environ.pop("AGENT_RUNTIME_LEDGER_DISABLE", None)
            else:
                os.environ["AGENT_RUNTIME_LEDGER_DISABLE"] = original_disable
        assert rc == 2, rc


def test_executable_lines_ignores_none_line_entries():
    module = load_coverage_check()
    with tempfile.TemporaryDirectory(prefix="coverage-check-lines-") as tmp_dir:
        path = Path(tmp_dir) / "probe.py"
        path.write_text("VALUE = 1\n", encoding="utf-8")

        original_findlinestarts = module.dis.findlinestarts
        try:
            module.dis.findlinestarts = lambda _co: [(0, None), (1, 1)]
            assert module.executable_lines(str(path)) == {1}
        finally:
            module.dis.findlinestarts = original_findlinestarts


def test_candidate_sources_can_measure_tools_when_filtered():
    module = load_coverage_check()
    with tempfile.TemporaryDirectory(prefix="coverage-check-tools-") as tmp_dir:
        root = Path(tmp_dir)
        tools = root / "tools"
        tools.mkdir()
        (root / "alpha_probe.py").write_text("VALUE = 1\n", encoding="utf-8")
        (tools / "run_ledger.py").write_text("VALUE = 2\n", encoding="utf-8")
        (tools / "coverage_check.py").write_text("VALUE = 3\n", encoding="utf-8")

        original_probe_dir = module.PROBE_DIR
        original_tools_dir = module.TOOLS_DIR
        try:
            module.PROBE_DIR = str(root)
            module.TOOLS_DIR = str(tools)
            selected = [Path(path).name for path in module.candidate_sources(["run_ledger"])]
        finally:
            module.PROBE_DIR = original_probe_dir
            module.TOOLS_DIR = original_tools_dir

        assert selected == ["run_ledger.py"], selected


def test_coverage_check_records_coverage_run_to_ledger():
    module = load_coverage_check()
    with tempfile.TemporaryDirectory(prefix="coverage-check-ledger-") as tmp_dir:
        root = Path(tmp_dir) / "probe-root"
        tests = root / "tests"
        tests.mkdir(parents=True)
        probe = root / "dummy_probe.py"
        ledger = Path(tmp_dir) / "ledger.jsonl"
        probe.write_text("def covered():\n    return 1\n", encoding="utf-8")
        tests.joinpath("test_ok.py").write_text(
            "from dummy_probe import covered\n"
            "assert covered() == 1\n",
            encoding="utf-8",
        )

        original_probe_dir = module.PROBE_DIR
        original_probe_real = module.probe_real
        original_executed = module.executed
        original_cls = module._cls
        original_argv = sys.argv[:]
        original_path = os.environ.get("AGENT_RUNTIME_LEDGER_PATH")
        original_disable = os.environ.pop("AGENT_RUNTIME_LEDGER_DISABLE", None)
        try:
            module.PROBE_DIR = str(root)
            module.probe_real = {os.path.realpath(probe): str(probe)}
            module.executed = {os.path.realpath(probe): set()}
            module._cls = {}
            sys.argv = ["coverage_check.py"]
            os.environ["AGENT_RUNTIME_LEDGER_PATH"] = str(ledger)
            rc = module.main()
        finally:
            module.PROBE_DIR = original_probe_dir
            module.probe_real = original_probe_real
            module.executed = original_executed
            module._cls = original_cls
            sys.argv = original_argv
            if original_path is None:
                os.environ.pop("AGENT_RUNTIME_LEDGER_PATH", None)
            else:
                os.environ["AGENT_RUNTIME_LEDGER_PATH"] = original_path
            if original_disable is not None:
                os.environ["AGENT_RUNTIME_LEDGER_DISABLE"] = original_disable

        records = [json.loads(line) for line in ledger.read_text(encoding="utf-8").splitlines()]
        events = [record for record in records if record.get("type") == "run"]
        assert rc == 0, rc
        assert len(events) == 1, records
        event = events[0]
        assert event["kind"] == "coverage", event
        assert event["name"] == "coverage_check.py", event
        assert event["coverage_pct"] == 100.0, event
        sys.modules.pop("run_ledger", None)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print("PASS", fn.__name__)
    print(f"\nall {len(tests)} coverage_check tests passed")
