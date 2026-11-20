"""The card's key/value scan finds line ends once per text, not once per value.

keyed_value_span needs the end of a value's (folded) line. Searching for it
from each value made the scan quadratic on repeated short quoted assignments
(the search ran to the end of a single-line text for every value) and on
pretty-printed JSON (every indented line is a folded continuation, so the
search walked every later line). FoldedLineEnds indexes the breaks once; each
lookup is a binary search, and must return exactly what folded_line_end
returns. The public card's own pass (public_card_keyed_values) uses both.
"""
from __future__ import annotations

import importlib.util
import sys
import time
from pathlib import Path

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import lib.bot_errors_card_keys as card_keys  # noqa: E402


def _load_dispatcher():
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_linear", _SCRIPTS / "bot-errors-dispatcher.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


dispatcher = _load_dispatcher()

# unit, prefix: the text is prefix + unit repeated to the size.
SHAPES = {
    "json-line": ('"token":"a",', "{"),
    "single-quoted-dict": ("{'token': 'a'}, ", ""),
    "quoted-assignments": ('token="a" ', ""),
    "json-pretty": ('\n  "token": "a",', "{"),
    "card-stop-folded": ("\n token: a,", ""),
}
SIZES = (32_768, 65_536, 131_072)
# A linear scan stays far below this cap; the quadratic scan at 9dbb5a5d7
# passed 300 ms at 64 KB and 600 ms at 128 KB on every shape.
_CAP_MS_AT_128_KB = 600.0


def _card(text: str) -> str:
    return dispatcher.public_card_text(text, 600)


def _text(shape: str, size: int) -> str:
    unit, prefix = SHAPES[shape]
    return prefix + unit * ((size - len(prefix)) // len(unit))


def _best_ms(render, text: str) -> float:
    best = None
    for _ in range(3):
        start = time.perf_counter()
        render(text)
        elapsed = (time.perf_counter() - start) * 1000
        best = elapsed if best is None else min(best, elapsed)
    return best


@pytest.mark.parametrize("shape", list(SHAPES))
def test_card_key_value_scan_stays_linear_to_128_kb(shape: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Timed on the card pass itself and on the card: the card may pass the scan less than the whole text."""
    monkeypatch.delenv("BOT_ERRORS_SAFE_SHAPE_CRED_PATH", raising=False)
    for render in (dispatcher.public_card_keyed_values, _card):
        timings = {size: _best_ms(render, _text(shape, size)) for size in SIZES}

        for size, elapsed in timings.items():
            assert elapsed < _CAP_MS_AT_128_KB * size / SIZES[-1], (render.__name__, timings)
        # Linear growth from 32 KB to 128 KB is 4x; a quadratic scan grows 16x.
        assert timings[SIZES[-1]] < 8 * max(timings[SIZES[0]], 2.0), (render.__name__, timings)


@pytest.mark.parametrize("shape", list(SHAPES))
def test_card_still_removes_every_value_of_a_long_text(shape: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Checked on the card pass's own output, before any cut: the card shows at most 600 characters, so a
    credential 32 KB in would be missing from the card whether or not the pass removed it."""
    monkeypatch.delenv("BOT_ERRORS_SAFE_SHAPE_CRED_PATH", raising=False)
    secret = "".join(("lastval", "Q7w8", "E9r0"))
    text = _text(shape, 32_768) + f' token="{secret}"'

    assert secret not in dispatcher.public_card_keyed_values(text)


_LINE_END_TEXTS = [
    "",
    "plain",
    "a\nb",
    "a\r\nb",
    "a\rb",
    "a\\nb",
    "a\n b\n\tc\nd",
    "a\r\n b\r\n\tc\r\nd",
    "a\\n b\\n c",
    "\n\n \n",
    "x\r\n\r\n y",
    "token: a\n  b\\n\tc\r\n\r\n",
    "\\\\n \\n\\n ",
    "end with fold\n ",
    "end with break\r\n",
]


@pytest.mark.parametrize("text", _LINE_END_TEXTS)
def test_folded_line_ends_equals_folded_line_end_at_every_position(text: str) -> None:
    ends = card_keys.FoldedLineEnds(text)

    for position in range(len(text) + 1):
        assert ends.at(position) == card_keys.folded_line_end(text, position), (text, position)
