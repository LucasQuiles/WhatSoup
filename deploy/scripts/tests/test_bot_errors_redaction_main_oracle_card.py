"""Main is the oracle (owner ruling R78) for the public card: the card hides every secret main hides.

Two checks, each on the raw text and on this tree's stored text:
  card_raw, card_stored        the card helper, public_card_text(event_display_summary(event), limit),
                               the call public_card_summary makes: the private-key block,
                               public_card_keyed_values, the shared redactor, the card boundary
                               and the card rewrites. The limit is raised so that truncation never
                               counts as hiding. Occurrence-based against main's group-message
                               content transform, redact(alert_text(text)), on the raw text or on
                               main's stored text.
  message_raw, message_stored  the whole delivered card, format_public_message(event), against
                               main's whole delivered group message, format_event(event), from
                               main's dispatcher executed from its blob with main's lib modules.
                               Presence-based: where main's message hides a secret, the card hides
                               it. The card repeats its summary in three fields by design.
The accepted residual is checked absolutely on all four: the card hides it whatever main does.

This file loads bot-errors-dispatcher.py, which imports CARD_GLUED_KEY_WORDS,
CARD_SECRET_KEY_WORDS, FoldedLineEnds, is_authorization_key, keyed_value_span
and secret_key_pattern from the shared redactor; main's redactor defines none
of them, so with main's redactor in place this file stops as INCONCLUSIVE.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Iterator

import pytest


def _support():
    name = "redaction_main_oracle_support"
    if name not in sys.modules:
        try:
            spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(f"{name}.py"))
            assert spec is not None and spec.loader is not None
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            spec.loader.exec_module(module)
        except Exception as error:
            sys.modules.pop(name, None)
            if str(error).startswith("INCONCLUSIVE:"):
                raise
            raise AssertionError(
                f"INCONCLUSIVE: the oracle support module did not load ({type(error).__name__}: {error}). "
                "This is an oracle infrastructure failure, not a redaction finding."
            ) from error
    return sys.modules[name]


S = _support()


def _load_dispatcher():
    name = "bot_errors_dispatcher_main_oracle"
    try:
        spec = importlib.util.spec_from_file_location(name, S.SCRIPTS / "bot-errors-dispatcher.py")
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
    except Exception as error:  # noqa: BLE001 - a dispatcher that does not load leaves no card to judge
        sys.modules.pop(name, None)
        raise S.inconclusive(
            f"this tree's bot-errors-dispatcher.py does not load ({type(error).__name__}: {error}); "
            "with main's redactor in place it cannot import the card's names"
        ) from error
    return module


D = _load_dispatcher()
CARD_LIMIT = 100_000
HELPER_PATHS = ("card_raw", "card_stored")
MESSAGE_PATHS = ("message_raw", "message_stored")
PATHS = HELPER_PATHS + MESSAGE_PATHS
# Words the card's own rewrites put in (public_card_text); a measure that
# matches them does not show the input.
CARD_REWRITES = "[detail omitted] [path omitted] needs a person Still open fix outcome at"
# The delivered card's own fixed text for this suite's event (public_card_title,
# public_card_summary, public_card_affected, public_card_roles and
# format_public_message in bot-errors-dispatcher.py), plus the rewrites. A
# measure that matches it does not show the input. It is pinned here rather than
# rendered from this tree, so a change to the card's fixed lines cannot silence
# a measure.
CARD_FIXED_TEXT = "\n".join((
    "*What happened:* *Who is affected:* *What we are doing:* *What you need to do:* Ref · host-a · bot-a",
    "The alert needs review. The bot-a bot. Not yet confirmed.",
    "Needs review. Nothing now. No action is needed. A person needs to act.",
    "Needs review: recovery is not confirmed. Needs review: the problem is still open.",
    "Relink or retire the WhatsApp line. Restore the affected AI service sign-in.",
    "Paused: Still open: Fixed: Closed: recovery not confirmed",
    "Repeated alerts stopped. The problem is still open. Repeated alerts stopped. Recovery is not confirmed.",
    "Old alerts were closed; recovery is not confirmed. Auto-closed non-actionable; unverified; reopens if needed.",
    "10/28/2026 8:00 PM ET Date unavailable",
    CARD_REWRITES,
))


def _event(text: str) -> dict:
    return {
        "schemaVersion": 2, "eventKind": "incident_alert", "eventType": "alert", "severity": "critical",
        "id": "evt-main-oracle", "createdAt": "2026-10-29T00:00:00Z", "machine": "host-a", "instance": "bot-a",
        "source": "agent_reply_guarantee_breach", "summary": text, "evidence": text,
    }


def _card(text: str) -> str:
    return D.public_card_text(D.event_display_summary(_event(text)), CARD_LIMIT)


def _message(text: str) -> str:
    return D.format_public_message(_event(text))


def _main_message(text: str) -> str:
    return S.main_dispatcher().format_event(_event(text))


def _mine(path: str, text: str) -> str:
    """This tree's rendering on one card path."""
    if path == "card_raw":
        return _card(text)
    if path == "card_stored":
        return _card(S.stored(S.head, text))
    if path == "message_raw":
        return _message(text)
    return _message(S.stored(S.head, text))


def _floor(path: str, text: str) -> str:
    """main's output on one card path."""
    if path == "card_raw":
        return S.from_main(path, lambda: S.main_display(text))
    if path == "card_stored":
        return S.from_main(path, lambda: S.main_display(S.stored(S.main, text)))
    if path == "message_raw":
        return S.from_main(path, lambda: _main_message(text))
    return S.from_main(path, lambda: _main_message(S.stored(S.main, text)))


def _shown(row, path: str) -> tuple[list[str], str]:
    rendered = _mine(path, row.text)
    noise = CARD_FIXED_TEXT if path in MESSAGE_PATHS else CARD_REWRITES
    shown = S.shown_beyond_main(row, _floor(path, row.text), rendered, presence=path in MESSAGE_PATHS, noise=noise)
    return shown, rendered


@pytest.fixture(autouse=True)
def _test_pins(monkeypatch: pytest.MonkeyPatch) -> None:
    S.use_test_pins(monkeypatch)


@pytest.fixture(autouse=True)
def _bounded(request: pytest.FixtureRequest) -> Iterator[None]:
    with S.alarm(request.node.nodeid):
        yield


def test_the_card_oracle_is_mains_code_and_its_inputs_are_pinned() -> None:
    main_dispatcher = S.main_dispatcher()
    assert main_dispatcher.__file__.endswith(f"main-oracle-git-blob-{S.MAIN_DISPATCHER_BLOB}-bot-errors-dispatcher.py")
    # main's dispatcher calls main's redactor and main's envelope, never this tree's.
    assert main_dispatcher.redact_bot_errors_text is S.main.redact_bot_errors_text
    assert main_dispatcher.alert_text is S.main.alert_text
    assert main_dispatcher.classify_event.__module__ == "main_oracle_lib.bot_errors_envelope"
    assert D.redact_bot_errors_text is S.head.redact_bot_errors_text
    assert S.main is not S.head
    assert S.LOADED_MAIN_BLOBS["deploy/scripts/bot-errors-dispatcher.py"] == S.MAIN_DISPATCHER_BLOB
    assert S.LOADED_MAIN_BLOBS["deploy/scripts/lib/bot_errors_redaction.py"] == S.MAIN_REDACTOR_BLOB
    assert all(S.MAIN_BLOBS[path] == blob for path, blob in S.LOADED_MAIN_BLOBS.items())
    wrong = {path: blob for path, blob in S.MAIN_BLOBS.items() if S.main_tree_blob(path) != blob}
    if wrong:
        raise S.inconclusive(f"these pinned blob ids are not main's files at {S.MAIN_COMMIT}: {sorted(wrong)}")
    assert S.pinned_input_problems() == []
    assert (S.FUZZ_SEED, S.FUZZ_SIZE) == (20261116, 4000)
    assert tuple(row.id for row in S.SHAPES) == S.SHAPE_IDS
    assert tuple(sorted(row.id for row in S.NAMED)) == S.NAMED_IDS
    assert (S.RESIDUAL.id, S.CASES["acceptedResidual"]["template"]) == (S.RESIDUAL_ID, S.RESIDUAL_TEMPLATE)
    assert len(S.FUZZ) > 3000
    assert len(S.PARITY) > 100


@pytest.mark.parametrize("row", S.SHAPES, ids=lambda row: row.id)
def test_main_hides_each_reproduced_shape_at_rest_and_in_its_group_message(row) -> None:
    """The card floors are live: main hides each shape's credential at rest and in its group message of that text."""
    stored = S.from_main("at rest", lambda: S.stored(S.main, row.text))
    message = S.from_main("the group message", lambda: _main_message(stored))
    shown = [secret for secret in row.declared if secret in stored or secret in message]
    assert not shown, S.inconclusive_reason(
        f"main no longer hides the credential of {row.id}: {stored!r} / {message!r}"
    )


def test_main_group_message_replaces_a_protected_link() -> None:
    """main's raw group message replaces a pinned link, so the message floor is not a weakened one."""
    message = S.from_main("the group message", lambda: _main_message(S.LIVENESS.text))
    assert not S.shown_at_all(S.LIVENESS, message), S.inconclusive_reason(
        f"main's group message no longer replaces a pinned protected link: {message!r}"
    )


def test_the_card_summary_is_the_helper_this_suite_checks() -> None:
    """For this event's source, public_card_summary is public_card_text(event_display_summary(event), 68).

    The helper check judges that call untruncated. If the card's summary is
    built some other way, the helper no longer stands for the card: that is
    INCONCLUSIVE, and the whole-card check still judges the delivered text.
    """
    rows = [*S.SHAPES, *S.NAMED, S.RESIDUAL, *S.FUZZ, *S.PARITY]
    deadline = S.Deadline("the card summary contract")
    differ = []
    for done, row in enumerate(rows):
        deadline.check(done, len(rows))
        for text in (row.text, S.stored(S.head, row.text)):
            event = _event(text)
            if D.public_card_summary(event) != D.public_card_text(D.event_display_summary(event), 68):
                differ.append(row.id)
                break
    assert not differ, S.inconclusive_reason(
        f"public_card_summary is no longer the helper this suite checks, for {len(differ)} rows: {differ[:20]}"
    )


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("row", S.SHAPES, ids=lambda row: row.id)
def test_reproduced_shape_card_hides_what_main_hides(row, path: str) -> None:
    shown, card = _shown(row, path)
    assert not shown, f"{row.id} shows on {path} {shown} where main hides it: {card!r}"


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("row", S.NAMED, ids=lambda row: row.id)
def test_named_case_card_hides_what_main_hides(row, path: str) -> None:
    shown, card = _shown(row, path)
    assert not shown, f"{row.id} shows on {path} {shown} where main hides it: {card!r}"


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("corpus", ("fuzz", "parity"))
def test_corpus_card_hides_what_main_hides(corpus: str, path: str) -> None:
    rows = S.FUZZ if corpus == "fuzz" else S.PARITY
    deadline = S.Deadline(f"the {path} {corpus} aggregate")
    failures = []
    for done, row in enumerate(rows):
        deadline.check(done, len(rows))
        shown, card = _shown(row, path)
        if shown:
            failures.append(f"{row.id} ({row.family}) shows {shown}: {card!r}")
    assert not failures, S.failure_report(failures, path)


@pytest.mark.parametrize("path", PATHS)
def test_the_card_hides_the_accepted_residual(path: str) -> None:
    """The residual is accepted at rest only (lane LEDGER.md:2223): the card hides it whatever main does."""
    card = _mine(path, S.RESIDUAL.text)
    shown = S.shown_at_all(S.RESIDUAL, card)
    assert not shown, f"the card shows the accepted residual on {path} {shown}: {card!r}"
