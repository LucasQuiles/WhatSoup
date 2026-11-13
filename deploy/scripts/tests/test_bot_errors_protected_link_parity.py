"""Python side of the protected-link parity corpus.

The same rows in ``tests/fixtures/protected-link-parity-corpus.json`` drive the
TypeScript scanner in ``tests/core/protected-link-parity.test.ts``, so the
Python port of ``sanitizeProtectedMessageText`` cannot drift from it. Hosts are
reserved ``.test`` names; the production digests are compared with the
TypeScript pins without naming any host.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
_SCRIPTS_DIR = _TESTS_DIR.parent
_REPO_ROOT = _SCRIPTS_DIR.parent.parent
_SSOT_PATH = _SCRIPTS_DIR / "lib" / "bot_errors_redaction.py"
_CORPUS_PATH = _REPO_ROOT / "tests" / "fixtures" / "protected-link-parity-corpus.json"
_TS_PINS_PATH = _REPO_ROOT / "src" / "lib" / "protected-delivery-pins.ts"


def _load_module():
    if str(_SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(_SCRIPTS_DIR))
    spec = importlib.util.spec_from_file_location("protected_link_bot_errors_redaction", _SSOT_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_MOD = _load_module()
_CORPUS = json.loads(_CORPUS_PATH.read_text(encoding="utf-8"))
_TEST_PINS = frozenset(
    hashlib.sha256(host.encode("utf-8")).hexdigest() for host in _CORPUS["linkHosts"]
)


@pytest.mark.parametrize("case", _CORPUS["cases"], ids=[case["id"] for case in _CORPUS["cases"]])
def test_scanner_matches_the_typescript_corpus(case: dict) -> None:
    assert _MOD.sanitize_protected_link_text(case["input"], _TEST_PINS) == case["expected"]


def test_default_digests_equal_the_typescript_link_pins() -> None:
    source = _TS_PINS_PATH.read_text(encoding="utf-8")
    digests = set(re.findall(r"'([0-9a-f]{64})'", source))
    assert digests, "no digests found in the TypeScript pins module"
    assert _MOD.PROTECTED_LINK_HOST_SHA256 == frozenset(digests)


def test_legacy_string_alert_content_is_redacted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_MOD, "PROTECTED_LINK_HOST_SHA256", _TEST_PINS)
    link = "https://links.example.test/s/#v3." + "Q" * 22 + "." + "Z" * 43
    rendered = _MOD.alert_text(f"ESCALATED still open: delivery failed for {link}")
    assert rendered == "ESCALATED still open: delivery failed for [protected managed link]"
    assert "links." not in _MOD.alert_text_for_fingerprint(f"failed {link}")


_BOUND_LINK = "https://links.example.test/s/#v3." + "Q" * 22 + "." + "Z" * 43
_TS_SCANNER_PATH = _REPO_ROOT / "src" / "lib" / "protected-link-text.ts"


def test_text_after_the_128th_link_is_kept() -> None:
    text = f"{_BOUND_LINK} " * 128 + "IMPORTANT NEUTRAL CONTENT"
    result = _MOD.sanitize_protected_link_text(text, _TEST_PINS)
    assert result.count(_MOD.PROTECTED_MESSAGE_MARKER) == 128
    assert result.endswith(" IMPORTANT NEUTRAL CONTENT")


def test_more_than_128_links_withhold_the_whole_text() -> None:
    text = f"{_BOUND_LINK} " * 129 + "IMPORTANT NEUTRAL CONTENT"
    assert _MOD.sanitize_protected_link_text(text, _TEST_PINS) == _MOD.PROTECTED_TEXT_WITHHELD_MARKER


def test_a_fragment_past_its_bound_withholds_the_whole_text() -> None:
    text = "see https://links.example.test/s/#" + "F" * 16_384 + " IMPORTANT NEUTRAL CONTENT"
    assert _MOD.sanitize_protected_link_text(text, _TEST_PINS) == _MOD.PROTECTED_TEXT_WITHHELD_MARKER


def test_withheld_marker_equals_the_typescript_marker() -> None:
    marker = _MOD.PROTECTED_TEXT_WITHHELD_MARKER
    assert _MOD.PROTECTED_MESSAGE_MARKER in marker
    assert f"PROTECTED_TEXT_WITHHELD_MARKER = '{marker}';" in _TS_SCANNER_PATH.read_text(encoding="utf-8")


def test_neutral_legacy_string_is_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_MOD, "PROTECTED_LINK_HOST_SHA256", _TEST_PINS)
    text = "ESCALATED still open: see https://other.example.test/s/#v3.keep"
    assert _MOD.alert_text(text) == text
