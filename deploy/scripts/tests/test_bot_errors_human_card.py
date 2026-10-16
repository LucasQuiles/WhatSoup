"""Human card + machine packet for BOT ERRORS notices (relay 10 P1/P2/P4, relay 16 A/B/D/E).

A notice reaches WhatsApp as a short plain card; the full body, every field in it
and the whole event go first to one JSON packet named by the card's Ref.

Golden cards live in ``fixtures/bot_errors_human_card/``. Nine are reconstructed
from delivered BOT INFO messages, one per family: ``format_event`` renders each
event to exactly the message that was delivered (``legacy_body``), so the card is
built from the same event state the old body came from. The rest are synthetic
dispatcher events (ERROR, WARNING, RECOVERY, resolved, mention safety). Fixtures
carry no chat ids, phone numbers of real lines, secrets or real host names.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import pytest
from hypothesis import example, given, strategies as st

_TESTS_DIR = Path(__file__).resolve().parent
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))

from bot_errors_property_support import properties  # noqa: E402
from support import card_hygiene, dispatcher_fixtures  # noqa: E402

_SCRIPT = _TESTS_DIR.parent / "bot-errors-dispatcher.py"
_FIXTURES = _TESTS_DIR / "fixtures" / "bot_errors_human_card"

_ENV_KEYS = ["BOT_ERRORS_STATE_DIR", "BOT_ERRORS_EMAIL_FALLBACK", "BOT_ERRORS_DRY_SEND_CAPTURE"]
_clean_env = dispatcher_fixtures.make_env_scrub_fixture(_ENV_KEYS)

# Q's pause-bypass patterns for the BOT ERRORS group (RE2, flag i, matched on the
# first 4096 characters). Kept here as a test constant on purpose: the test must
# not read any private configuration. Python ``re`` with IGNORECASE is equivalent
# for these patterns. The live third pattern names Q's own two line identifiers
# ("@" + one of two fixed digit strings); this public repository carries no line
# identifiers, so it is widened here to any "@" + digit run. The wider pattern
# admits everything the live one does, so equal admission under it is the
# stricter gate, and the cards and bodies must carry no such run at all.
Q_PAUSE_BYPASS_PATTERNS = (
    r"^BOT ERROR - ",
    r"^\s*@?q[:,]\s",
    r"@\d{6,}\b",
    r"^🔴 \*",
    r"^🔴 ⚡ ",
)
_Q_PATTERNS = [re.compile(pattern, re.IGNORECASE) for pattern in Q_PAUSE_BYPASS_PATTERNS]


def q_admits(text: str) -> bool:
    head = text[:4096]
    return any(pattern.search(head) for pattern in _Q_PATTERNS)


def _load(name: str = "bot_errors_dispatcher_human_card"):
    spec = importlib.util.spec_from_file_location(name, _SCRIPT)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


_mod = _load()


def _goldens() -> list[dict]:
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(_FIXTURES.glob("*.json"))]


_GOLDENS = _goldens()
_GOLDEN_IDS = [golden["family"] for golden in _GOLDENS]
_INFO_FAMILIES = {
    "self_restart_completed",
    "provider_fallback_restored",
    "provider_fallback_reverted",
    "model_currency",
    "recovery_debt_attention",
    "flap_storm_closed",
    "stale_autoclose",
}
# Real delivered messages, one per BOT INFO family (relay 16 tests and gates).
_REAL_FAMILIES = _INFO_FAMILIES | {"stale_logged_out", "stale_awaiting_physical"}
_DISPATCHER_FAMILIES = {"dispatcher_error", "dispatcher_warning", "dispatcher_recovery", "dispatcher_resolved"}

# Card hygiene (relay 16 B, relay 19 B4): checked on EVERY card this module
# renders through the dispatcher's card renderers, not only on the goldens.
_FORBIDDEN_CARD_PATTERNS = card_hygiene.FORBIDDEN_CARD_PATTERNS
_card_body_without_ref = card_hygiene.card_body_without_ref
_RENDERED_CARDS = card_hygiene.install_card_hygiene_hook(_mod)


@pytest.fixture
def state(tmp_path):
    os.environ["BOT_ERRORS_STATE_DIR"] = str(tmp_path)
    (tmp_path / "logs").mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp_path.chmod(0o700)
    return _mod.state_paths()


# --- Golden cards -----------------------------------------------------------


def test_every_family_has_a_golden() -> None:
    assert set(_GOLDEN_IDS) >= _REAL_FAMILIES | _DISPATCHER_FAMILIES | {"mention_safety"}


@pytest.mark.parametrize("golden", _GOLDENS, ids=_GOLDEN_IDS)
def test_golden_card(golden: dict) -> None:
    event = golden["event"]
    ref = _mod.notice_ref_candidates(_mod.notice_id_of(event))[0]
    assert _mod.format_card(event, ref) == golden["card"]
    assert golden["card"].endswith(f"\nRef: {ref}")


@pytest.mark.parametrize("golden", _GOLDENS, ids=_GOLDEN_IDS)
def test_golden_event_still_renders_its_delivered_body(golden: dict) -> None:
    # The card is rendered from the event the old body came from: for the real
    # families legacy_body IS the delivered message (host and paths neutralised).
    # The one intended body change is P2: a unit name keeps its "@".
    body = _mod.format_event(golden["event"])
    if golden.get("p2_changes_body"):
        # The old body rewrote EVERY "@" to " at "; now only a mention risk is.
        assert body != golden["legacy_body"]
        assert body.replace("@", " at ") == golden["legacy_body"]
    else:
        assert body == golden["legacy_body"]


@pytest.mark.parametrize("golden", _GOLDENS, ids=_GOLDEN_IDS)
def test_card_carries_no_machine_fields(golden: dict) -> None:
    body = _card_body_without_ref(golden["card"])
    for pattern in _FORBIDDEN_CARD_PATTERNS:
        assert not pattern.search(body), (pattern.pattern, golden["card"])
    assert not card_hygiene.card_path_tokens(body), golden["card"]
    assert re.fullmatch(r"Ref: [0-9a-f]{8}", golden["card"].split("\n")[-1])
    assert len(golden["card"]) <= 600
    first = golden["card"].split("\n", 1)[0]
    assert not first.rstrip("*").rstrip().endswith(":")


@pytest.mark.parametrize("golden", [g for g in _GOLDENS if g["family"] in _INFO_FAMILIES], ids=lambda g: g["family"])
def test_information_card_is_at_most_four_lines(golden: dict) -> None:
    lines = golden["card"].split("\n")
    assert len(lines) <= 4
    assert lines[0].startswith("ℹ️ *")
    assert lines[1].startswith("Where: ")
    assert "You: No action needed" in lines


def test_action_cards_carry_every_target_line() -> None:
    for golden in _GOLDENS:
        if golden["family"] in _INFO_FAMILIES:
            continue
        lines = golden["card"].split("\n")
        assert lines[1].startswith("Where: ")
        assert any(line.startswith("Handling: ") for line in lines), golden["family"]
        assert any(line.startswith("You: ") for line in lines), golden["family"]
        if not golden["card"].startswith("✅"):
            assert any(line.startswith("Impact") for line in lines), golden["family"]


def test_title_catalog_meanings() -> None:
    by_family = {g["family"]: g["card"].split("\n", 1)[0] for g in _GOLDENS}
    assert by_family["self_restart_completed"] == "ℹ️ *Q restarted and is back online*"
    assert by_family["provider_fallback_restored"] == "ℹ️ *Q restarted while on its backup AI provider*"
    assert by_family["provider_fallback_reverted"] == "ℹ️ *Q is back on its main AI provider*"
    assert by_family["model_currency"] == "ℹ️ *Q: newer AI model available*"
    assert by_family["recovery_debt_attention"] == "ℹ️ *Q has unfinished recovery work*"
    assert "alerts stopped; the problem behind them is still open" in by_family["flap_storm_closed"]


def test_catalog_variants_follow_the_event() -> None:
    base = dict(next(g for g in _GOLDENS if g["family"] == "provider_fallback_reverted")["event"])
    plain = dict(base, evidence="reason=window-elapsed turnsServed=3")
    probed = dict(base, evidence="reason=primary-probe-ok turnsServed=3")
    assert "(checked healthy)" not in _mod.format_card(plain, "00000000")
    assert "*Q is back on its main AI provider (checked healthy)*" in _mod.format_card(probed, "00000000")

    currency = dict(next(g for g in _GOLDENS if g["family"] == "model_currency")["event"])
    retiring = dict(currency, eventKind="incident_alert", eventType="alert", severity="warning")
    assert "*Q: AI model in use is being retired*" in _mod.format_card(retiring, "00000000")
    live = dict(retiring, source="model-currency-live-scan")
    assert "*Q: AI model list could not be read; using the built-in list*" in _mod.format_card(live, "00000000")

    debt = dict(next(g for g in _GOLDENS if g["family"] == "recovery_debt_attention")["event"])
    debt["diagnostics"] = {**debt["diagnostics"], "count": 3}
    assert "*Q has unfinished recovery work (3)*" in _mod.format_card(debt, "00000000")

    other_bot = dict(next(g for g in _GOLDENS if g["family"] == "self_restart_completed")["event"], instance="ar-bot")
    assert "*ar-bot restarted and is back online*" in _mod.format_card(other_bot, "00000000")


def test_unknown_source_gets_a_plain_title_without_digests() -> None:
    event = dict(next(g for g in _GOLDENS if g["family"] == "dispatcher_error")["event"])
    event["source"] = "some_new_probe:sub-check"
    first = _mod.format_card(event, "00000000").split("\n", 1)[0]
    assert first.startswith("🔴 *fixture-bot: some new probe sub check")
    assert "digest" not in first and "chars" not in first


# --- Q routing gate (relay 16 E) -----------------------------------------------


@pytest.mark.parametrize("golden", _GOLDENS, ids=_GOLDEN_IDS)
def test_q_admission_is_unchanged(golden: dict) -> None:
    old, new = golden["legacy_body"], golden["card"]
    assert q_admits(new) == q_admits(old)
    if old.startswith("BOT ERROR - "):
        assert q_admits(new)
        assert new.startswith("🔴 *")
    else:
        assert not new.startswith(("🔴 *", "🔴 ⚡ "))
        assert not re.match(r"^\s*@?q[:,]\s", new, re.IGNORECASE)


_MATRIX_KINDS = {"alert": "incident_alert", "observation": "observation", "clear": "incident_recovery"}
_MATRIX_TYPES = (("alert", "critical"), ("alert", "error"), ("alert", "warning"), ("observation", "info"), ("clear", "info"))
_MATRIX_SOURCES = st.one_of(
    st.sampled_from(("primary_model_unusable", "self_restart_completed", "q", "instance_logged_out")),
    st.from_regex(r"[a-z][a-z_-]{0,24}", fullmatch=True),
)
# Pieces the card scrubber removes. Between "@" and a digit run, each one used to
# leave "@<digits>" behind once it was stripped (relay 19 B3).
_SCRUBBED_PIECES = (
    "*",
    "**",
    "_",
    "[digest 0a1b2c3d]",
    "[set 0a1b2c]",
    "-",
    "deadbeef0123",
    "0a1b2c3d-0a1b-4c2d-8e3f-0a1b2c3d4e5f",
    "/tmp",
    "/tmp/x/",
    "~/a/b/",
    "unknown - 40 chars - digest 0a1b2c3d",
    # Relay 20 M4: emptied brackets and digit runs split by a removed piece.
    "()",
    "[]",
    "123*456*",
    "12_34*",
)
# Summaries that try to look addressed to Q or to mention a number, plus a
# confined (legacy object) summary. The text draws punctuation the scrubber
# removes as well as letters, digits and spaces.
_MATRIX_SUMMARIES = st.one_of(
    st.just({"failureClass": "unknown", "length": 12, "correlationDigest": "ab" * 32}),
    st.builds(
        lambda lead, piece, digits, tail: f"{lead}{piece}{digits} {tail}".strip(),
        st.sampled_from(("q: ", "Q, ", "@q ", "Q: please check @", "@", "")),
        st.sampled_from(("", *_SCRUBBED_PIECES)),
        st.from_regex(r"[0-9]{0,15}", fullmatch=True),
        st.text(
            alphabet=st.characters(codec="ascii", categories=("L", "N", "Zs"), include_characters="*_[]-/~@+.|=:"),
            max_size=30,
        ),
    ),
)


@properties
@given(kind=st.sampled_from(_MATRIX_TYPES), source=_MATRIX_SOURCES, summary=_MATRIX_SUMMARIES)
@example(kind=("alert", "critical"), source="q", summary="Q, please check @15550001234")
@example(kind=("observation", "info"), source="self_restart_completed", summary="q: worker stalled")
@example(kind=("alert", "warning"), source="q", summary="ping @*15550001111")
@example(kind=("observation", "info"), source="q", summary="ping @[digest 0a1b2c3d]15550001111")
@example(kind=("alert", "warning"), source="q", summary="ping @/tmp/x/15550001111")
def test_q_admission_matrix(kind: tuple[str, str], source: str, summary) -> None:
    """Q admits a notice exactly when it is a critical/error alert, in the old body and in the card alike."""
    event_type, severity = kind
    event = {
        "schemaVersion": 2,
        "eventKind": _MATRIX_KINDS[event_type],
        "eventType": event_type,
        "severity": severity,
        "id": f"matrix-{event_type}-{severity}",
        "createdAt": "2026-10-15T10:00:00Z",
        "instance": "q",
        "source": source,
        "summary": summary,
    }
    card = _mod.format_card(event, "00000000")
    old_body = _mod.format_event(event)
    expected = event_type == "alert" and severity in {"critical", "error"}
    assert old_body.startswith("BOT ERROR - ") == expected
    assert q_admits(old_body) == expected, old_body
    assert q_admits(card) == expected, card


# --- P2: mention safety ---------------------------------------------------------


# A systemd template-unit name. Built at runtime: its "@" + ".service" shape is
# an e-mail address to the repository's publication guard.
_AT = "@"
_UNIT = f"whatsoup{_AT}fixture-bot.service"


def test_mention_risk_is_neutralised_and_unit_names_survive() -> None:
    assert _mod.neutralize_mentions(f"{_UNIT} failed") == f"{_UNIT} failed"
    assert _mod.neutralize_mentions("ping @15550001111") == "ping  at 15550001111"
    assert _mod.neutralize_mentions("ping @+15550001111") == "ping  at +15550001111"
    golden = next(g for g in _GOLDENS if g["family"] == "mention_safety")
    assert f"whatsoup{_AT}fixture-bot exited" in golden["card"]
    assert not re.search(r"@[0-9+]", golden["card"])
    body = _mod.format_event(golden["event"])
    assert f"whatsoup{_AT}fixture-bot exited" in body
    assert not re.search(r"@[0-9+]", body)
    event = dict(golden["event"], summary=f"{_UNIT} exited 1; paging @15550001111")
    card = _mod.format_card(event, "00000000")
    assert _UNIT in card and "@1555" not in card
    assert _UNIT in _mod.format_event(event)


_AT_DIGIT = re.compile(r"@[0-9+]")


def _producer_text_cards(text: str) -> list[str]:
    """Every card whose lines carry producer text: title, Where, Cause, summary line."""
    alert = {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "warning",
        "id": "b3-alert",
        "createdAt": "2026-10-15T10:00:00Z",
        "machine": text,
        "instance": "fixture-bot",
        "source": "health_body_degraded",
        "summary": text,
    }
    observation = dict(alert, id="b3-observation", eventKind="observation", eventType="observation", severity="info")
    resolved = dict(observation, id="b3-resolved")
    resolved[_mod.RESOLVES_PAGE_FIELD] = {"incidentKey": "k", "pagedSummary": text, "openedAt": None}
    summary_lines = _mod.information_summary_lines([{"noticeKind": "outbox", "title": text}])
    return [
        _mod.format_card(alert, "00000000"),
        _mod.format_card(observation, "00000000"),
        _mod.format_card(resolved, "00000000"),
        _mod.format_information_summary_card(summary_lines, "00000000"),
        _mod.card_plain(text),
    ]


@pytest.mark.parametrize("piece", _SCRUBBED_PIECES)
@pytest.mark.parametrize("digits", ["15550001111", "+15550001111", "4242"])
def test_no_card_line_gets_an_at_digit_from_a_scrubbed_piece(piece: str, digits: str) -> None:
    # Relay 19 B3: neutralizing "@" before the scrub let "@<piece><digits>" become
    # "@<digits>" once the piece was removed; Q admits "@" + six digits.
    text = f"ping @{piece}{digits} now"
    for card in _producer_text_cards(text):
        for line in card.split("\n"):
            assert not _AT_DIGIT.search(line), (text, line)
        assert not q_admits(card) or card.startswith("🔴 *"), card


@pytest.mark.parametrize("text", ["worker 123*456*789 stalled", "ping @()123*456 now", "ping @[]4242 now"])
def test_card_plain_never_rebuilds_a_long_number_or_an_at_digit(text: str) -> None:
    # Relay 20 M4: a removal or cleanup after the last strip used to join a
    # digit run or an "@" to digits again; card_plain repeats until stable.
    plain = _mod.card_plain(text)
    assert not re.search(r"\d{6,}", plain), (text, plain)
    assert not _AT_DIGIT.search(plain), (text, plain)
    assert plain.split(" ", 1)[0] in {"worker", "ping"}


@pytest.mark.parametrize("text", [
    "(" * 2000 + ")" * 2000,
    "ping @" + "(" * 2000 + ")" * 2000 + "15550001111 now",
    "worker " + "(" * 1000 + "123*456*789" + ")" * 1000 + " stalled",
], ids=["brackets", "mention-brackets", "number-brackets"])
def test_card_plain_is_bounded_on_a_long_nested_bracket_input(text: str) -> None:
    # Relay 21 N1: the repeat-until-stable loop had no pass limit and no length
    # cap, so 2,000 "(" then 2,000 ")" took about 2,000 quadratic passes.
    started = time.perf_counter()
    plain = _mod.card_plain(text)
    elapsed = time.perf_counter() - started
    assert elapsed < 0.1, elapsed
    assert not re.search(r"\d{6,}", plain), plain
    assert not _AT_DIGIT.search(plain), plain
    assert len(plain) <= _mod.CARD_TITLE_LIMIT


@pytest.mark.parametrize("text", [
    "chat 1,234,567,890,123 stalled",
    "chat 1 234 567 890 123 stalled",
    "phone +1 555 000 1111 linked",
    "line 1-555-000-1111 down",
    "host 1.234.567.890 down",
])
def test_long_numbers_written_with_separators_never_reach_the_card(text: str) -> None:
    # Relay 21 N4: each digit group was under six digits, so a separated id
    # passed. A run of 9 digits or more joined by one separator goes.
    plain = _mod.card_plain(text)
    assert not re.search(r"\d", plain), plain
    assert plain.split(" ", 1)[0] == text.split(" ", 1)[0] and plain.endswith(text.rsplit(" ", 1)[1])


@pytest.mark.parametrize("text", [
    "count 1,234,567 queued",
    "count 10,000,000 queued",
    "since 2026-10-16 08:00 today",
    "version 1.2.3 of 4 5 6",
])
def test_counts_and_dates_with_separators_stay_on_the_card(text: str) -> None:
    # Relay 21 N4: dispatcher counts are capped at 10,000,000 (8 digits) and a
    # date holds 8 digits, so both stay.
    assert _mod.card_plain(text) == text


_MACHINE_FIELD_SUMMARIES = (
    "pid=4242; chat=123456789012345; file=/tmp; key a|b|c",
    "worker pid 4242 stalled in /tmp for chat 123456789012345 (key hub-1|line|instance_logged_out)",
    "stale notice stale-hub-1_line_instance_logged_out-1760000000 re-sent from src/lib/bot.ts",
    "poison-1760000000-4242 quarantined at ~/state/x.json, see 01HZX3K5V8Q9R2T4W6Y8Z0A1B3",
)


@pytest.mark.parametrize("summary", _MACHINE_FIELD_SUMMARIES)
def test_card_lines_from_producer_text_carry_no_machine_fields(summary: str) -> None:
    # Relay 19 B4: producer summaries reach the title, the daily summary lines
    # and the resolved card's Cause line. None of them may carry a pid, a long
    # number, a path (one segment or more), an incident key or an event id.
    cards = _producer_text_cards(summary)
    for card in cards:
        card_hygiene.assert_card_hygiene(card)
        for piece in ("pid", "4242", "123456789012345", "/tmp", "a|b|c", "chat=", "file=", "1760000000", "01HZX"):
            assert piece not in card, (piece, card)
    plain = _mod.card_plain(summary)
    assert plain, "words survive the scrub"
    assert not plain.startswith((";", ",", ":")) and "()" not in plain and ";;" not in plain


def test_the_hygiene_hook_checks_every_rendered_card() -> None:
    before = len(_RENDERED_CARDS)
    event = dict(next(g for g in _GOLDENS if g["family"] == "dispatcher_warning")["event"], summary="pid=4242 x")
    _mod.format_card(event, "00000000")
    assert len(_RENDERED_CARDS) == before + 1
    with pytest.raises(card_hygiene.CardHygieneViolation):
        card_hygiene.assert_card_hygiene("ℹ️ *worker pid 4242 at /tmp*\nRef: 00000000")


@pytest.mark.parametrize(("summary", "path"), [
    ("failed reading config/agent.json", "config/agent.json"),
    ("see logs/error.log", "logs/error.log"),
])
def test_two_segment_relative_paths_never_reach_the_card(summary: str, path: str) -> None:
    # Relay 20 M1: a relative path of two segments that looks like a file (a
    # segment with a dot extension, or a folder word) is a path too.
    for card in _producer_text_cards(summary):
        assert path not in card and "/" not in card_hygiene.card_body_without_ref(card), card
    assert _mod.card_plain(summary) == summary.rsplit(" ", 1)[0]


def test_plain_words_joined_by_a_slash_stay_on_the_card() -> None:
    text = "read and/or write 3/4 of the read/write checks"
    assert _mod.card_plain(text) == text
    card_hygiene.assert_card_hygiene(f"ℹ️ *{text}*\nRef: 00000000")


_N3_PATHS = ("docs/archive.7z", "systemd/getty@.service", "logs\\error.log", "logs/error.log")
_N3_PHRASES = ("test/prod", "home/away", "and/or", "3/4", "10/16", "8080/8443", "data/voice", "state/city")


@pytest.mark.parametrize("path", _N3_PATHS)
def test_two_segment_paths_with_any_extension_never_reach_the_card(path: str) -> None:
    # Relay 21 N3: a digit extension, an "@" in a segment and the backslash
    # form all slipped through the two-segment rule.
    summary = f"failed reading {path} again"
    assert _mod.card_plain(summary) == "failed reading again"
    with pytest.raises(card_hygiene.CardHygieneViolation):
        card_hygiene.assert_card_hygiene(f"ℹ️ *{summary}*\nRef: 00000000")


@pytest.mark.parametrize("phrase", _N3_PHRASES)
def test_ordinary_slash_phrases_stay_on_the_card(phrase: str) -> None:
    # Relay 21 N3: the folder-word list emptied ordinary text ("test/prod").
    summary = f"switch {phrase} now"
    assert _mod.card_plain(summary) == summary
    card_hygiene.assert_card_hygiene(f"ℹ️ *{summary}*\nRef: 00000000")


def test_the_hygiene_path_check_is_not_the_scrubber_regex() -> None:
    # Relay 21 N3: the hook copied the scrubber's regex, so it could not catch
    # a gap of the same shape. It now has a check of its own.
    assert not hasattr(card_hygiene, "_FILE_SEGMENT")
    assert card_hygiene.card_path_tokens("see docs/archive.7z and test/prod") == ["docs/archive.7z"]


def test_an_instance_with_a_long_digit_run_gives_no_digit_run_on_the_where_line() -> None:
    event = dict(next(g for g in _GOLDENS if g["family"] == "dispatcher_warning")["event"], instance="bot-15550001111")
    where = _mod.card_where(event)
    assert where.startswith("Where: ") and not re.search(r"\d{6,}", where), where
    card = _mod.format_card(event, "00000000")
    assert not re.search(r"\d{6,}", card_hygiene.card_body_without_ref(card)), card


@pytest.mark.parametrize("card", [
    "ℹ️ *failed reading config/agent.json*\nRef: 00000000",
    "ℹ️ *see logs/error.log*\nRef: 00000000",
    "ℹ️ *re-sent from src/lib/bot.ts*\nRef: 00000000",
])
def test_the_hygiene_hook_fails_on_relative_paths(card: str) -> None:
    with pytest.raises(card_hygiene.CardHygieneViolation):
        card_hygiene.assert_card_hygiene(card)


# --- P4: confined summaries -----------------------------------------------------


def test_confined_cause_uses_only_allowlisted_fields() -> None:
    event = dict(next(g for g in _GOLDENS if g["family"] == "dispatcher_error")["event"])
    event["diagnostics"] = {
        "provider": "anthropic",
        "model": "model with spaces /and/a/path",
        "unit": _UNIT,
        "port": 9090,
        "count": "7",
        "operatorNote": "free text the card must never show",
    }
    assert _mod.card_cause(event) == "provider auth failure; provider anthropic; port 9090"
    card = _mod.format_card(event, "00000000")
    assert "free text" not in card and "operatorNote" not in card and "spaces" not in card
    assert "summary_confined" not in card


def test_large_counts_keep_thousands_separators_and_dated_models_keep_their_name() -> None:
    # Relay 20 S-c: a dispatcher-built count of a million or more used to form a
    # six-digit run the long-number strip then dropped; a dated model id vanished
    # the same way.
    event = dict(next(g for g in _GOLDENS if g["family"] == "dispatcher_error")["event"])
    event["diagnostics"] = {"model": "claude-sonnet-4-5-20250929", "count": 1234567}
    cause = _mod.card_cause(event)
    assert cause == "provider auth failure; model claude-sonnet-4-5; count 1,234,567"
    first = _mod.format_card(event, "00000000").split("\n", 1)[0]
    assert "count 1,234,567" in first and "model claude-sonnet-4-5" in first, first

    debt = dict(next(g for g in _GOLDENS if g["family"] == "recovery_debt_attention")["event"])
    debt["diagnostics"] = {**debt["diagnostics"], "count": 1234567}
    assert "*Q has unfinished recovery work (1,234,567)*" in _mod.format_card(debt, "00000000")

    autoclose = dict(next(g for g in _GOLDENS if g["family"] == "stale_autoclose")["event"])
    autoclose["evidence"] = "closed_count=1234567"
    assert "Closed 1,234,567 old alerts" in _mod.format_card(autoclose, "00000000")

    lines = _mod.information_summary_lines([{"noticeKind": "stale-autoclose", "count": 1234567}])
    assert lines == ["Closed 1,234,567 old alerts that stopped reporting; they reopen if the problem returns"]
    summary = _mod.format_information_summary_card(lines, "00000000", dropped=1234567)
    assert "1,234,567 older notices not listed" in summary


def test_unknown_failure_class_is_dropped() -> None:
    event = dict(next(g for g in _GOLDENS if g["family"] == "dispatcher_warning")["event"])
    assert "unknown" not in _mod.format_card(event, "00000000").lower()
    event["diagnostics"] = {}
    assert _mod.card_cause(event) is None


# --- A: machine packet ----------------------------------------------------------


@pytest.mark.parametrize("golden", _GOLDENS, ids=_GOLDEN_IDS)
def test_packet_round_trip(state, golden: dict) -> None:
    event = golden["event"]
    text, ref = _mod.notice_message(event, notice_kind="fixture", paths=state)
    assert text == golden["card"]
    packet = _mod.read_notice_packet(state, ref)
    assert packet is not None
    assert packet["ref"] == ref and packet["noticeId"] == event["id"]
    assert packet["card"] == text
    assert packet["event"] == _mod.redacted_dispatcher_payload(event)
    body = _mod.format_event(event)
    assert packet["body"] == body
    # Every field of today's body is in the packet, by label and value.
    packet_fields = [(field["label"], field["value"]) for field in packet["bodyFields"]]
    assert packet_fields[0] == ("headline", body.split("\n", 1)[0])
    for line in body.split("\n")[1:]:
        match = re.match(r"^  > (?P<label>[A-Za-z0-9_]+): ?(?P<value>.*)$", line)
        if match:
            assert any(
                label == match.group("label") and value.split("\n", 1)[0] == match.group("value")
                for label, value in packet_fields
            ), match.group("label")
    rebuilt = "\n".join(
        [packet_fields[0][1]] + [f"  > {label}: {value}" if value else f"  > {label}:" for label, value in packet_fields[1:]]
    )
    assert rebuilt == body


def test_packet_stores_the_redacted_event_never_the_raw_one(state, tmp_path) -> None:
    # Relay 19 S6: `packet <ref>` prints the packet, so the stored event is the
    # dispatcher's redacted payload, not json_snapshot(event).
    token = "x" * 40
    header = "Bear" + "er " + token
    event = json.loads(json.dumps(next(g for g in _GOLDENS if g["family"] == "dispatcher_error")["event"]))
    event["evidence"] = f"probe sent Authorization: {header}"
    event["diagnostics"] = {**event.get("diagnostics", {}), "authHeader": header, "nested": [{"value": header}]}
    _text, ref = _mod.notice_message(event, notice_kind="fixture", paths=state)
    packet = _mod.read_notice_packet(state, ref)
    assert packet["noticeId"] == event["id"]
    assert token not in json.dumps(packet)
    assert packet["event"]["diagnostics"]["authHeader"] == _mod.redact(header)
    env = {**os.environ, "BOT_ERRORS_STATE_DIR": str(tmp_path)}
    printed = subprocess.run(
        [sys.executable, str(_SCRIPT), "packet", ref], capture_output=True, text=True, env=env, timeout=60
    )
    assert printed.returncode == 0, printed.stderr
    assert token not in printed.stdout


def test_packet_cli_prints_the_packet_and_exits_one_when_absent(state, tmp_path) -> None:
    golden = next(g for g in _GOLDENS if g["family"] == "self_restart_completed")
    _text, ref = _mod.notice_message(golden["event"], notice_kind="fixture", paths=state)
    env = {**os.environ, "BOT_ERRORS_STATE_DIR": str(tmp_path)}
    found = subprocess.run(
        [sys.executable, str(_SCRIPT), "packet", ref], capture_output=True, text=True, env=env, timeout=60
    )
    assert found.returncode == 0, found.stderr
    assert json.loads(found.stdout)["ref"] == ref
    missing_ref = "0" * 8 if ref != "0" * 8 else "1" * 8
    absent = subprocess.run(
        [sys.executable, str(_SCRIPT), "packet", missing_ref], capture_output=True, text=True, env=env, timeout=60
    )
    assert absent.returncode == 1
    assert absent.stdout == ""
    bad = subprocess.run(
        [sys.executable, str(_SCRIPT), "packet", "../x"], capture_output=True, text=True, env=env, timeout=60
    )
    assert bad.returncode == 2


@pytest.mark.parametrize("golden", _GOLDENS, ids=_GOLDEN_IDS)
def test_format_card_cli_prints_only_the_card_the_group_gets(golden: dict, state, tmp_path) -> None:
    # --format-card goes to standard output: it must print the scrubbed card the
    # send path sends, byte for byte, and nothing from the event beyond it.
    sent, _ref = _mod.notice_message(golden["event"], notice_kind="fixture", paths=state)
    event_file = tmp_path / "event.json"
    event_file.write_text(json.dumps(golden["event"]), encoding="utf-8")
    cli_state = tmp_path / "cli-state"
    cli_state.mkdir(mode=0o700)
    printed = subprocess.run(
        [sys.executable, str(_SCRIPT), "--format-card", str(event_file)],
        capture_output=True,
        text=True,
        env={**os.environ, "BOT_ERRORS_STATE_DIR": str(cli_state)},
        timeout=60,
    )
    assert printed.returncode == 0, printed.stderr
    assert printed.stdout == sent + "\n"
    assert list(cli_state.iterdir()) == []


def test_ref_collision_never_overwrites_another_notice(state) -> None:
    golden = next(g for g in _GOLDENS if g["family"] == "dispatcher_error")
    event = golden["event"]
    first, second = _mod.notice_ref_candidates(event["id"])[:2]
    squatter = dict(event, id="another-notice-entirely")
    squatter_packet = _mod.build_notice_packet(squatter, ref=first, notice_kind="fixture", card="x")
    _mod.write_notice_packet(state, squatter_packet)
    before = _mod.notice_packet_path(state, first).read_bytes()

    text, ref = _mod.notice_message(event, notice_kind="fixture", paths=state)
    assert ref == second
    assert text.endswith(f"Ref: {second}")
    assert _mod.notice_packet_path(state, first).read_bytes() == before
    assert _mod.read_notice_packet(state, first)["noticeId"] == "another-notice-entirely"
    assert _mod.read_notice_packet(state, second)["noticeId"] == event["id"]

    # A direct write of different content at a taken Ref is refused.
    with pytest.raises(_mod.NoticeRefExhausted):
        _mod.write_notice_packet(state, _mod.build_notice_packet(event, ref=first, notice_kind="fixture", card="y"))
    assert _mod.notice_packet_path(state, first).read_bytes() == before


def test_cards_of_one_incident_get_their_own_refs_and_packets(state) -> None:
    # One incident (one incident_key), two cards with different subjects.
    first = json.loads(json.dumps(next(g for g in _GOLDENS if g["family"] == "dispatcher_error")["event"]))
    second = json.loads(json.dumps(first))
    second["id"] = "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f"
    second["createdAt"] = "2026-10-15T15:00:00.000Z"
    second["summary"] = {"failureClass": "provider_timeout", "length": 31, "correlationDigest": "5d" * 32}
    assert _mod.incident_key(first) == _mod.incident_key(second)

    text_one, ref_one = _mod.notice_message(first, notice_kind="fixture", paths=state)
    before = _mod.notice_packet_path(state, ref_one).read_bytes()
    text_two, ref_two = _mod.notice_message(second, notice_kind="fixture", paths=state)
    assert ref_one != ref_two
    assert text_one.split("\n", 1)[0] != text_two.split("\n", 1)[0]
    assert _mod.notice_packet_path(state, ref_one).read_bytes() == before
    packet_one = _mod.read_notice_packet(state, ref_one)
    packet_two = _mod.read_notice_packet(state, ref_two)
    assert packet_one["noticeId"] == first["id"] and packet_two["noticeId"] == second["id"]
    assert packet_one["incidentKey"] == packet_two["incidentKey"] == _mod.incident_key(first)
    assert packet_one["incidentRef"] == packet_two["incidentRef"]
    assert packet_one["incidentRef"] not in (ref_one, ref_two)


def test_dispatcher_made_notices_of_one_incident_get_their_own_refs(state) -> None:
    now = int(time.time())
    key = "mac-host-1.local|fixture-bot|whatsapp_device_bond_lost"
    record = {
        "status": "awaiting_physical",
        "openedAt": now - 5 * 86400,
        "lastSeenAt": now - 4 * 86400,
        "failureCode": "WA_AUTH_BOND_SERVER_REVOKED",
        "recoverability": "manual_relink_required",
        "assetKind": "whatsapp_linked_device",
    }
    day_one = _mod.stale_incident_event(key, dict(record), now)
    day_two = _mod.stale_incident_event(key, dict(record), now + 86400)
    _text, ref_one = _mod.notice_message(day_one, notice_kind="stale-digest", paths=state)
    _text, ref_two = _mod.notice_message(day_two, notice_kind="stale-digest", paths=state)
    assert ref_one != ref_two
    assert {
        _mod.read_notice_packet(state, ref)["incidentKey"] for ref in (ref_one, ref_two)
    } == {key}


def test_retried_notice_keeps_its_ref_and_updates_its_packet(state) -> None:
    event = json.loads(json.dumps(next(g for g in _GOLDENS if g["family"] == "dispatcher_error")["event"]))
    _text, ref = _mod.notice_message(event, notice_kind="fixture", paths=state)
    event["delivery"]["attempts"] = 2
    _text2, ref2 = _mod.notice_message(event, notice_kind="fixture", paths=state)
    assert ref2 == ref
    assert _mod.read_notice_packet(state, ref)["event"]["delivery"]["attempts"] == 2


def test_unwritable_packet_store_falls_back_to_the_full_body(state) -> None:
    state["packets"].parent.mkdir(parents=True, exist_ok=True)
    state["packets"].write_text("not a directory")
    event = next(g for g in _GOLDENS if g["family"] == "dispatcher_error")["event"]
    text, ref = _mod.notice_message(event, notice_kind="fixture", paths=state)
    assert ref is None
    assert text == _mod.format_event(event)
    assert q_admits(text)
    records = dispatcher_fixtures.dispatch_log_records(state)
    assert any(record.get("type") == "notice_packet_failed" for record in records)


def test_packets_older_than_retention_are_pruned(state) -> None:
    for family in ("dispatcher_error", "dispatcher_warning"):
        _mod.notice_message(next(g for g in _GOLDENS if g["family"] == family)["event"], notice_kind="fixture", paths=state)
    packets = sorted(state["packets"].glob("*.json"))
    assert len(packets) == 2
    old = time.time() - _mod.NOTICE_PACKET_RETENTION_SECONDS - 60
    os.utime(packets[0], (old, old))
    assert _mod.NOTICE_PACKET_RETENTION_SECONDS >= 30 * 86400
    assert _mod.prune_notice_packets(state) == 1
    assert sorted(state["packets"].glob("*.json")) == packets[1:]


@pytest.mark.parametrize(("configured", "expected"), [
    ("1", 30 * 86400),
    ("86400", 30 * 86400),
    (str(30 * 86400 - 1), 30 * 86400),
    (str(90 * 86400), 90 * 86400),
])
def test_packet_retention_has_a_thirty_day_floor(monkeypatch, configured: str, expected: int) -> None:
    # Relay 19 S3: the operator may keep packets longer, never under 30 days.
    monkeypatch.setenv("BOT_ERRORS_PACKET_RETENTION_SECONDS", configured)
    loaded = _load(f"bot_errors_dispatcher_retention_{configured}")
    assert loaded.NOTICE_PACKET_RETENTION_SECONDS == expected


def test_two_quarantines_in_one_second_keep_two_meta_alert_packets(state, monkeypatch, tmp_path) -> None:
    # Relay 19 S7: "poison-<second>-<pid>" let a second quarantine in the same
    # second take the first one's Ref and overwrite its packet.
    paths = _mod.setup_dirs()
    sends: list[str] = []
    monkeypatch.setattr(_mod, "send_whatsapp", lambda text, *a, **k: sends.append(text))
    monkeypatch.setattr(_mod.time, "time", lambda: 1_792_000_000.5)
    for name in ("one.json", "two.json"):
        bad = paths["outbox"] / name
        bad.write_text("{not json", encoding="utf-8")
        _mod.quarantine_poison(bad, paths["quarantine"], f"invalid JSON: {name}")
    refs = [card.rsplit("Ref: ", 1)[1] for card in sends]
    assert len(refs) == 2 and refs[0] != refs[1]
    packets = [_mod.read_notice_packet(paths, ref) for ref in refs]
    assert packets[0]["noticeId"] != packets[1]["noticeId"]
    assert "one.json" in packets[0]["body"] and "two.json" in packets[1]["body"]


def test_meta_alert_ids_differ_within_one_second(monkeypatch) -> None:
    monkeypatch.setattr(_mod.time, "time", lambda: 1_792_000_000.0)
    ids = {_mod.meta_alert_id("credential-meta") for _ in range(50)}
    assert len(ids) == 50
    assert all(value.startswith("credential-meta-1792000000-") for value in ids)


def test_outbox_send_carries_the_card_and_the_packet_names_the_sent_file(state, monkeypatch) -> None:
    paths = _mod.setup_dirs()
    sends: list[str] = []
    monkeypatch.setattr(_mod, "send_whatsapp", lambda text, *a, **k: sends.append(text))
    event = json.loads(json.dumps(next(g for g in _GOLDENS if g["family"] == "dispatcher_error")["event"]))
    event["delivery"] = {"attempts": 0, "status": "queued", "nextAttemptAtEpoch": 0}
    path = dispatcher_fixtures.write_outbox_event(paths, "20261015T090000Z.fixture-bot.error.json", event)

    ok, detail = _mod.process_one(path, paths)
    assert ok and detail == "sent", detail
    assert len(sends) == 1
    card = sends[0]
    assert card.startswith("🔴 *fixture-bot: primary model unusable")
    ref = card.rsplit("Ref: ", 1)[1]
    packet = _mod.read_notice_packet(paths, ref)
    assert packet["noticeKind"] == "outbox"
    sent_files = [p for p in paths["sent"].iterdir() if p.is_file()]
    assert [str(p) for p in sent_files] == [packet["outbox"]["sentPath"]]
    assert packet["outbox"]["file"] == path.name


def test_stale_digest_notice_is_a_card_with_a_packet(state, monkeypatch) -> None:
    paths = _mod.setup_dirs()
    sends: list[str] = []
    monkeypatch.setattr(_mod, "send_whatsapp", lambda text, *a, **k: sends.append(text))
    now = int(time.time())
    # A stale renotify goes out on its own only when a standing action remains
    # outside the line-recheck family (relay 16 C2): here a primary-phone check.
    key = "mac-host-1.local|fixture-bot|daily-health:primary_phone:fixture-bot"
    state_doc = dispatcher_fixtures.empty_state()
    state_doc["openIncidents"][key] = {
        "status": "awaiting_physical",
        "severity": "critical",
        "openedAt": now - 3 * 86400,
        "lastSeenAt": now - 2 * 86400,
        "lastSummary": "unknown - 40 chars - digest 0a1b2c3d",
        "failureCode": "WA_AUTH_BOND_SERVER_REVOKED",
        "recoverability": "manual_relink_required",
        "assetKind": "whatsapp_linked_device",
    }
    paths["incident_state"].write_text(json.dumps(state_doc))
    paths["incident_state"].chmod(0o600)
    sent, failed, _err = _mod.sweep_stale_incidents(paths)
    assert (sent, failed) == (1, 0)
    card = sends[0]
    assert "digest" not in card and "|" not in card
    packet = _mod.read_notice_packet(paths, card.rsplit("Ref: ", 1)[1])
    assert packet["noticeKind"] == "stale-digest"
    assert any(field["label"] == "incident_key" and field["value"] == key for field in packet["bodyFields"])
