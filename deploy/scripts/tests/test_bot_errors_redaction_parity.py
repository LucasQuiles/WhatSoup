"""BEAD-052 redaction parity — Python SSOT side.

Asserts the shared `redaction-parity-corpus.jsonl` fixture against the Python
SSOT `redact_bot_errors_text`. The corpus is the SAME file the vitest
(`tests/redaction-parity.test.ts`) drives against the TS `redactBotErrorsText`,
so the two suites prove the TS redactor mirrors the Python ground truth.

Each row carries either a single ``expected`` (TS and Python agree) or per-side
``expected_ts``/``expected_py`` (intentional divergence, with a ``rationale``).
This suite asserts ``expected_py`` (falling back to ``expected``).
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
_SCRIPTS_DIR = _TESTS_DIR.parent
_REPO_ROOT = _SCRIPTS_DIR.parent.parent
_SSOT_PATH = _SCRIPTS_DIR / "lib" / "bot_errors_redaction.py"
_CORPUS_PATH = _REPO_ROOT / "tests" / "fixtures" / "redaction-parity-corpus.jsonl"

# Match the TS default-off credential-path marker so the shared corpus rows are
# deterministic across both suites.
_CREDENTIAL_PATH_MARKER = "[REDACTED CREDENTIAL PATH]"


def _load_redactor():
    if str(_SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(_SCRIPTS_DIR))
    spec = importlib.util.spec_from_file_location("bead052_bot_errors_redaction", _SSOT_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.redact_bot_errors_text


def _load_corpus() -> list[dict]:
    rows: list[dict] = []
    for line in _CORPUS_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


_REDACT = _load_redactor()
_ROWS = _load_corpus()


def test_corpus_has_minimum_rows():
    assert len(_ROWS) >= 20


@pytest.mark.parametrize("row", _ROWS, ids=[row["id"] for row in _ROWS])
def test_redaction_parity_python_side(row: dict, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("BOT_ERRORS_SAFE_SHAPE_CRED_PATH", raising=False)
    expected = row.get("expected_py", row.get("expected"))
    assert isinstance(expected, str), f"row {row['id']} must declare expected_py or expected"
    got = _REDACT(row["input"], credential_path_marker=_CREDENTIAL_PATH_MARKER)
    assert got == expected
