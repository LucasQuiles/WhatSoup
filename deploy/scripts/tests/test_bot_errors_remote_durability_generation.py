"""Deterministic generation checks for the embedded remote durability helper."""

from __future__ import annotations

import ast
import importlib.util
import json
from pathlib import Path
import subprocess
import sys


_SCRIPTS = Path(__file__).resolve().parents[1]
_COLLECTOR = _SCRIPTS / "bot-errors-collector.py"
_GENERATOR = _SCRIPTS / "generate-bot-errors-remote-durability.py"
_REMOTE_HELPER = _SCRIPTS / "lib" / "durable_json_remote.py"


def _load_collector():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_collector_generation",
        _COLLECTOR,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_remote_durability_generation_is_current() -> None:
    result = subprocess.run(
        [sys.executable, str(_GENERATOR), "--check"],
        cwd=_SCRIPTS.parents[1],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr


def test_embedded_remote_helper_bytes_are_exact_and_parseable() -> None:
    collector = _load_collector()
    expected_prefix = _REMOTE_HELPER.read_text(encoding="utf-8")

    assert collector.REMOTE_DURABLE_JSON_SOURCE == expected_prefix
    assert collector.REMOTE_WRITEFAIL_ACK_SCRIPT.startswith(
        collector.REMOTE_DURABLE_JSON_SOURCE
    )
    ast.parse(collector.REMOTE_WRITEFAIL_ACK_SCRIPT)


def test_embedded_ack_functions_consume_durable_outcomes() -> None:
    collector = _load_collector()
    tree = ast.parse(collector.REMOTE_WRITEFAIL_ACK_SCRIPT)
    functions = {
        node.name: node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }

    journal_calls = {
        getattr(node.func, "id", "")
        for node in ast.walk(functions["write_ack_journal"])
        if isinstance(node, ast.Call)
    }
    copy_calls = {
        getattr(node.func, "id", "")
        for node in ast.walk(functions["copy_claim_atomic"])
        if isinstance(node, ast.Call)
    }

    assert {"publish_event_json", "require_advance"} <= journal_calls
    assert {"publish_event_json", "require_all_advance"} <= copy_calls


def test_production_inventory_has_no_collector_findings() -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(_SCRIPTS / "check-bot-errors-durable-writers.py"),
            "--inventory",
            "deploy/bot-errors-durable-writer-inventory.json",
            "--json",
        ],
        cwd=_SCRIPTS.parents[1],
        text=True,
        capture_output=True,
        check=False,
    )
    report = json.loads(result.stdout)
    collector_findings = [
        finding
        for finding in report["findings"]
        if finding.get("script") == "deploy/scripts/bot-errors-collector.py"
    ]

    assert result.returncode in {0, 1}
    assert report["status"] in {"pass", "violation"}
    assert collector_findings == []
