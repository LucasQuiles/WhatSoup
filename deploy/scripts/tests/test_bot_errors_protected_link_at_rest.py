"""Markers survive the shared at-rest redactor unchanged.

Alert text can already carry PROTECTED_MESSAGE_MARKER, the stand-in for a
protected managed link. redact_bot_errors_text must pass the marker through as
written, also after a Bearer or Basic scheme word: no credential rule may take
it for a value.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import lib.bot_errors_redaction as shared  # noqa: E402

_MARKER = shared.PROTECTED_MESSAGE_MARKER
# A marker already in the text passes through every later rule unchanged.
MARKER_KEPT = [
    f"delivery failed for {_MARKER} now",
    f"Bearer {_MARKER} refused",
    f"Basic {_MARKER} refused",
]


@pytest.fixture(autouse=True)
def _default_credential_path_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    # redact_bot_errors_text reads this switch on every call.
    monkeypatch.delenv("BOT_ERRORS_SAFE_SHAPE_CRED_PATH", raising=False)


def _stored(text: str) -> str:
    return shared.redact_bot_errors_text(text, credential_path_marker="[REDACTED CREDENTIAL PATH]")


@pytest.mark.parametrize("text", MARKER_KEPT)
def test_a_marker_in_the_text_survives_unchanged(text: str) -> None:
    assert _stored(text) == text
