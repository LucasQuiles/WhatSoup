"""The public card hides every credential main's redactor hides in the same raw text.

Owner ruling R96: main's redactor runs first, on the raw text; the card's own
pass then runs on the redacted text, where it can only remove more, and a
length cap bounds every card step after main's. The card's key rule used to
run first. It glued its "<key>=[REDACTED]" marker to the next word, or ended a
chained key's value at an unfolded line break, so main's redactor, running
after it, no longer saw the scheme word or the key name it needed (B7 final
reviews). Each row here is checked against main's redactor on the same raw
text: every synthetic canary main hides must be absent from the card as shown,
case folded, without whitespace and percent-decoded. Canaries are built at run
time.
"""
from __future__ import annotations

import hashlib
import importlib.util
import re
import sys
import time
from pathlib import Path
from typing import Callable
from urllib.parse import unquote

import pytest

_SCRIPTS = Path(__file__).resolve().parents[1]
_REPOSITORY = _SCRIPTS.parents[1]
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import lib.bot_errors_redaction as shared  # noqa: E402


def _load():
    spec = importlib.util.spec_from_file_location(
        "bot_errors_dispatcher_card_against_main", _SCRIPTS / "bot-errors-dispatcher.py"
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


dispatcher = _load()


@pytest.fixture(autouse=True)
def _plain_credential_path_marker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BOT_ERRORS_SAFE_SHAPE_CRED_PATH", raising=False)


def _main(text: str) -> str:
    """Main's redactor on `text`, called as the dispatcher's redact() calls it."""
    return shared.redact_bot_errors_text(text, credential_path_marker="[REDACTED CREDENTIAL PATH]")


def _event(**overrides: object) -> dict[str, object]:
    event: dict[str, object] = {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "critical",
        "id": "evt-public-card-against-main",
        "createdAt": "2026-11-17T00:00:00Z",
        "machine": "host-a",
        "instance": "q",
        "source": "agent_reply_guarantee_breach",
        "summary": "reply queue is delayed",
        "evidence": "ignored by the public card",
    }
    event.update(overrides)
    return event


def _shows(canary: str, rendered: str) -> bool:
    """Whether `rendered` holds `canary` as shown, case folded, without whitespace or percent-decoded."""
    decoded = unquote(rendered)
    forms = (rendered, "".join(rendered.split()), decoded, "".join(decoded.split()))
    folded = canary.casefold()
    return any(canary in form or folded in form.casefold() for form in forms)


def _hidden_by_main(summary: str, canaries: tuple[str, ...]) -> list[str]:
    stored = _main(summary)
    return [canary for canary in canaries if not _shows(canary, stored)]


def _card_lines(summary: str) -> tuple[str, ...]:
    """The card helper at the summary (68) and What-happened (75) widths, and untruncated: a cut hides no leak."""
    return tuple(dispatcher.public_card_text(summary, width) for width in (68, 75, 100_000))


def _assert_card_hides(summary: str, hidden: list[str]) -> None:
    for rendered in _card_lines(summary):
        for canary in hidden:
            assert not _shows(canary, rendered), (canary, rendered)


def _canary(tag: str) -> str:
    # Letters and digits only, so no rule reads part of it as punctuation, and
    # longer than 8 characters, so main's Bearer rule takes it whole.
    return "".join(("Cnr", tag, "Kq7Wm3Np"))


def _rows(templates: dict[str, str], tag: str) -> dict[str, tuple[str, tuple[str, ...]]]:
    """Each template with "{C1}" and "{C2}" replaced by the row's own canaries."""
    rows: dict[str, tuple[str, tuple[str, ...]]] = {}
    for index, (row_id, template) in enumerate(templates.items()):
        first, second = _canary(f"{tag}{index:02d}a"), _canary(f"{tag}{index:02d}b")
        summary = template.replace("{C1}", first).replace("{C2}", second)
        rows[row_id] = (summary, tuple(canary for canary in (first, second) if canary in summary))
    return rows


_RAW_ROWS = _rows(
    {
        # The card's marker glued to the word after it (the six reproductions).
        "quoted-key-then-bearer": 'token="x"Bearer {C1}',
        "authorization-then-bearer": 'Authorization="x"Bearer {C1}',
        "b1-authorization-inside-a-quoted-value": 'token="x Authorization: "Bearer {C1}"',
        "f3-scheme-word-after-a-later-key": 'token="abc, password="Bearer {C1}"',
        "key-glued-after-a-dropped-quote": 'token: "a b"password": {C1}',
        "ampersand-stop": '\\"client_secret\\" : "&Bearer {C1}',
        # Their variants: Basic, an unclosed quote, single and escaped quotes,
        # a cookie key and an escaped chained key.
        "b1-basic-inside-a-quoted-value": 'token="x Authorization: "Basic {C1}"',
        "b1-unclosed-after-authorization": 'token="x Authorization: "Bearer {C1}',
        "single-quoted-key-then-bearer": "secret='x'Bearer {C1}",
        "escaped-quoted-key-then-bearer": 'token=\\"x\\"Bearer {C1}',
        "cookie-then-bearer": 'cookie="sid"Bearer {C1} retry',
        "escaped-chained-key-then-bearer": '\\"token\\"="api_key":"x"Bearer {C1}',
        # An unfolded line break after a chained key: the card's value ended at
        # the break, and the key it removed was the one main needed.
        "chained-authorization-lf": 'token="Authorization":\n{C1}',
        "chained-authorization-cr": 'token="Authorization":\r{C1}',
        "chained-authorization-crlf": 'token="Authorization":\r\n{C1}',
        "escaped-chained-key-lf": '\\"token\\" = "api_key":\n{C1}',
        "escaped-chained-key-cr": '\\"token\\" = "api_key":\r{C1}',
        "escaped-chained-key-crlf": '\\"token\\" = "api_key":\r\n{C1}',
        # F3 through the card: a quoted value that closes at a later key's quote.
        "f3-quote-closes-at-a-later-key": '"secret": "{C1}, retry api_key": "{C2}"',
    },
    "r",
)


@pytest.mark.parametrize("row_id", list(_RAW_ROWS))
def test_public_card_hides_every_canary_main_hides_in_raw_text(row_id: str) -> None:
    summary, canaries = _RAW_ROWS[row_id]
    hidden = _hidden_by_main(summary, canaries)

    assert hidden, f"main hides no canary of {summary!r}, so the row would check nothing"
    _assert_card_hides(summary, hidden)


# Owner ruling R96: main shows the credential after these two chained keys, and
# the owner accepted main's behavior for them, so they left the card's absolute
# list (test_public_card_hides_the_credential_after_a_chained_key in
# test_bot_errors_public_card.py). The card is held to what main hides: the
# first value in "key-after-break"; in "plain-outer-key" main hides neither
# canary, so that row records the accepted case and checks nothing more. No
# chain rule is added for them.
_ACCEPTED_CHAIN_ROWS = _rows(
    {
        "plain-outer-key": '"token" = "api_key": {C1}',
        "key-after-break": 'token: "{C1}-session": {C2}',
    },
    "k",
)


@pytest.mark.parametrize("row_id", list(_ACCEPTED_CHAIN_ROWS))
def test_public_card_hides_what_main_hides_after_an_accepted_chained_key(row_id: str) -> None:
    summary, canaries = _ACCEPTED_CHAIN_ROWS[row_id]
    _assert_card_hides(summary, _hidden_by_main(summary, canaries))


@pytest.mark.parametrize("row_id", ["quoted-key-then-bearer", "chained-authorization-lf"])
def test_delivered_card_hides_every_canary_main_hides(row_id: str) -> None:
    summary, canaries = _RAW_ROWS[row_id]
    hidden = _hidden_by_main(summary, canaries)
    card = dispatcher.format_public_message(_event(summary=summary, evidence=summary))

    assert hidden
    for canary in hidden:
        assert not _shows(canary, card), card


def _escaped_quote_ladder(rungs: int) -> str:
    """'token=', a run of backslashes one longer than the rung before, then '"a, '.

    No two values share an opener, so each value's closing-quote search ran to
    the end of the line and recounted the backslashes before every later quote.
    """
    return "".join("token=" + "\\" * depth + '"a, ' for depth in range(rungs))


def _fastest_ms(render: Callable[[], object], bound_ms: float) -> float:
    """The fastest of up to three runs; stops at the first run under the bound or far over it."""
    best = None
    for _ in range(3):
        start = time.perf_counter()
        render()
        elapsed = (time.perf_counter() - start) * 1000
        best = elapsed if best is None else min(best, elapsed)
        if elapsed < bound_ms or elapsed > 3 * bound_ms:
            break
    assert best is not None
    return best


def test_public_card_renders_an_escaped_quote_ladder_in_under_a_second() -> None:
    """Without the cap, the card's closing-quote search took about 5 s on this ladder at 300 KB."""
    text = _escaped_quote_ladder(770)
    renders: dict[str, Callable[[], object]] = {
        "summary line": lambda: dispatcher.public_card_text(text, 68),
        "delivered card": lambda: dispatcher.format_public_message(_event(summary=text)),
    }

    assert 290_000 <= len(text) <= 320_000
    for name, render in renders.items():
        assert _fastest_ms(render, 1000.0) < 1000.0, name


def test_main_redactor_sees_the_raw_text_and_the_card_pass_at_most_the_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    cap = dispatcher.PUBLIC_CARD_SCAN_MAX_CHARS
    redact_inputs: list[object] = []
    card_pass_inputs: list[str] = []
    redact, card_pass = dispatcher.redact, dispatcher.public_card_keyed_values

    def recording_redact(value: object) -> str:
        redact_inputs.append(value)
        return redact(value)

    def recording_card_pass(text: str) -> str:
        card_pass_inputs.append(text)
        return card_pass(text)

    monkeypatch.setattr(dispatcher, "redact", recording_redact)
    monkeypatch.setattr(dispatcher, "public_card_keyed_values", recording_card_pass)

    assert cap >= 4096
    for text in ('token="a" ' * 2_000, _escaped_quote_ladder(200)):
        redact_inputs.clear()
        card_pass_inputs.clear()
        dispatcher.public_card_text(text, 75)

        assert len(text) > cap
        assert redact_inputs and redact_inputs[0] == text
        assert card_pass_inputs and max(len(seen) for seen in card_pass_inputs) <= cap


# The rows of test_bot_errors_protected_link_at_rest.py at cf458c5b0 whose
# fragment tail main's display hides, back as absolute card checks. Hosts are
# reserved .test names, pinned for these tests only; the tail is filler.
_LINK_HOST = ".".join(("links", "example", "test"))
_DELIVERY_HOST = ".".join(("delivery", "example", "test"))
_TEST_PINS = frozenset(hashlib.sha256(host.encode("utf-8")).hexdigest() for host in (_LINK_HOST, _DELIVERY_HOST))
_TAIL = "Z" * 12
_LINK_ROWS = {
    "basic-before-bare-host": f"delivery failed: Basic {_DELIVERY_HOST.upper()}/S#{_TAIL} end",
    "header-pair-in-fragment": f"see https://{_LINK_HOST}/s/#'token','abc'{_TAIL} end",
    "quote-closes-in-fragment": f"token='a {_LINK_HOST}/s#Q'{_TAIL}' end",
    "credential-in-fragment": f"see https://{_LINK_HOST}/s/#credential=abc;{_TAIL} end",
    "proxy-authorization-in-fragment": f"see https://{_LINK_HOST}/s/#proxyAuthorization='A';{_TAIL} end",
}


@pytest.fixture
def _test_pins(monkeypatch: pytest.MonkeyPatch) -> None:
    # The dispatcher imports main's redactor by name, and its link sanitizer
    # reads the pins at call time, so patching that one module pins the hosts.
    monkeypatch.setattr(shared, "PROTECTED_LINK_HOST_SHA256", _TEST_PINS)


@pytest.mark.usefixtures("_test_pins")
@pytest.mark.parametrize("text", list(_LINK_ROWS.values()), ids=list(_LINK_ROWS))
def test_public_card_hides_the_fragment_tail_after_a_protected_link(text: str) -> None:
    """On the raw text and on main's stored text, through the card helper and the delivered card."""
    for summary in (text, _main(text)):
        assert _TAIL not in dispatcher.public_card_text(summary, 10_000)
        assert _TAIL not in dispatcher.format_public_message(_event(summary=summary, evidence=summary))


# Main's keyed-secret key group: a run of compound "<alnum>_" segments, then
# one alternative per key word. The TypeScript redactor has the same group with
# one more word, "credential".
_KEY_GROUP_START = "(?:[A-Za-z0-9]+_)*(?:"
_BOUNDED_RUN = "[A-Za-z0-9_.-]{0,20}"
_GLUED_PREFIX = "[A-Za-z0-9]{1,40}"


def _key_alternatives(source: str) -> list[str]:
    """The top-level alternatives of the one key group in `source`."""
    assert source.count(_KEY_GROUP_START) == 1, "expected exactly one keyed-secret key group"
    start = source.index(_KEY_GROUP_START) + len(_KEY_GROUP_START)
    depth, piece_start, pieces = 0, start, []
    for at in range(start, len(source)):
        character = source[at]
        if character == "(":
            depth += 1
        elif character == ")" and depth > 0:
            depth -= 1
        elif character in "|)" and depth == 0:
            pieces.append(source[piece_start:at])
            if character == ")":
                return pieces
            piece_start = at + 1
    raise AssertionError("the keyed-secret key group never closes")


def _spellings(alternative: str) -> list[str]:
    """Concrete keys for one alternative: each "[_-]?" as nothing, "_" or "-", and an "x" before a glued word."""
    alternative = alternative.replace(_BOUNDED_RUN, "")
    prefix = ""
    if alternative.startswith(_GLUED_PREFIX):
        prefix, alternative = "x", alternative[len(_GLUED_PREFIX):]
    if alternative.startswith("(?:") and alternative.endswith(")"):
        alternative = alternative[len("(?:"):-1]
    spellings = []
    for word in alternative.split("|"):
        head, *tails = word.split("[_-]?")
        variants = [head]
        for tail in tails:
            variants = [variant + separator + tail for variant in variants for separator in ("", "_", "-")]
        spellings.extend(prefix + variant for variant in variants)
    for spelling in spellings:
        assert re.fullmatch(r"[A-Za-z][A-Za-z_-]*", spelling), (alternative, spelling)
    return spellings


def _main_key_spellings(language: str) -> list[str]:
    if language == "python":
        assert "authorization" in shared.AUTHORIZATION_KEYED_RE.pattern
        source, extra = shared.KEYED_SECRET_RE.pattern, ["authorization"]
    else:
        source, extra = (_REPOSITORY / "src" / "lib" / "redaction-text.ts").read_text(encoding="utf-8"), []
    return [spelling for alternative in _key_alternatives(source) for spelling in _spellings(alternative)] + extra


@pytest.mark.parametrize("language", ["python", "typescript"])
def test_card_key_words_cover_every_keyed_word_of_main(language: str) -> None:
    """The card removes a whole value only after a key it knows; it must know every key main's keyed rule knows."""
    spellings = _main_key_spellings(language)

    assert len(spellings) >= 30, spellings
    for spelling in spellings:
        key = dispatcher._PUBLIC_CARD_SECRET_KEY.match(f" {spelling}: v")
        assert key is not None and key.group(2) == spelling, spelling
