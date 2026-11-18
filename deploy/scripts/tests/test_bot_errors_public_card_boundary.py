"""The public BOT ERRORS card is one content boundary: no credential, number, path, link or command.

Every test renders a FULL card through format_public_message, because the
card's own rules and the shared redactor interact: a card rule that consumes
a header's scheme first leaves the credential unrecognisable to redact().
Credential- and phone-shaped samples are assembled at runtime.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from hypothesis import given, settings, strategies as st


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load():
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_card_boundary", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


_mod = _load()

BEARER_CREDENTIAL = "".join(("cardtok", "A1b2C3d4", "E5f6G7h8"))
BASIC_CREDENTIAL = "".join(("dXNlcjpw", "YXNzd29y", "ZA=="))
URL_PASSWORD = "".join(("pw", "Q9x7Z2"))
PHONE_DIGITS = "".join(("1", "555", "010", "4477"))
PHONE_FORMATTED = "".join(("+1 (", "555", ") 010-", "4477"))


def _card(summary: str, evidence: str = "ignored by the public card") -> str:
    return _mod.format_public_message({
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "critical",
        "id": "evt-public-card-boundary",
        "createdAt": "2026-11-11T00:00:00Z",
        "machine": "host-a",
        "instance": "q",
        "source": "agent_reply_guarantee_breach",
        "summary": summary,
        "evidence": evidence,
    })


def test_card_hides_the_credential_of_an_authorization_bearer_header() -> None:
    card = _card(f"Authorization: Bearer {BEARER_CREDENTIAL} was refused")

    assert BEARER_CREDENTIAL not in card
    assert BEARER_CREDENTIAL[:12] not in card


def test_card_hides_the_credential_of_a_basic_authorization_assignment() -> None:
    card = _card(f"login failed authorization=Basic {BASIC_CREDENTIAL} for the bot")

    assert BASIC_CREDENTIAL not in card
    assert BASIC_CREDENTIAL[:8] not in card


# Every Authorization scheme, an unknown one and none at all: the whole header
# value goes from the card, never just its first word. The shared redactor takes
# a scheme word it does not know for the value, so "Token <credential>" keeps
# the credential at rest; the card removes the whole value itself.
SCHEME_CREDENTIAL = "".join(("schemetok", "Q1w2E3r4", "T5y6U7i8"))
AUTHORIZATION_VALUES = (
    ("Bearer", f"Bearer {SCHEME_CREDENTIAL}"),
    ("Basic", f"Basic {SCHEME_CREDENTIAL}"),
    ("Token", f"Token {SCHEME_CREDENTIAL}"),
    ("Digest", f'Digest username="bot", realm="api", nonce="n1", response="{SCHEME_CREDENTIAL}"'),
    ("Negotiate", f"Negotiate {SCHEME_CREDENTIAL}"),
    ("unknown scheme", f"Hawk {SCHEME_CREDENTIAL}"),
    ("no scheme", SCHEME_CREDENTIAL),
)
AUTHORIZATION_SHAPES = (
    ("header", lambda key, value: f"request refused\n{key}: {value}\naccept: json"),
    ("inline header", lambda key, value: f"{key}: {value}"),
    ("assignment", lambda key, value: f"login failed {key.lower()}={value}"),
    ("json", lambda key, value: '{"' + key + '": "' + value.replace('"', '\\"') + '"}'),
)


@pytest.mark.parametrize("key", ["Authorization", "Proxy-Authorization"])
@pytest.mark.parametrize("scheme,value", AUTHORIZATION_VALUES, ids=[label for label, _ in AUTHORIZATION_VALUES])
@pytest.mark.parametrize("shape,build", AUTHORIZATION_SHAPES, ids=[label for label, _ in AUTHORIZATION_SHAPES])
def test_card_hides_the_whole_authorization_value_for_every_scheme(key, scheme, value, shape, build) -> None:
    text = build(key, value)
    event = {
        "schemaVersion": 2, "eventKind": "incident_alert", "eventType": "alert", "severity": "critical",
        "id": "evt-authorization-scheme", "createdAt": "2026-11-11T00:00:00Z", "machine": "host-a",
        "instance": "q", "source": "agent_reply_guarantee_breach", "summary": text, "evidence": text,
    }

    card = _mod.format_public_message(event)

    assert SCHEME_CREDENTIAL not in card
    assert SCHEME_CREDENTIAL[:9] not in card


def test_card_hides_header_lines_in_summary_and_evidence() -> None:
    card = _card(
        f"request failed\nAuthorization: Bearer {BEARER_CREDENTIAL}\naccept: json",
        evidence=f"Authorization: Basic {BASIC_CREDENTIAL}\nAuthorization: Bearer {BEARER_CREDENTIAL}",
    )

    assert BEARER_CREDENTIAL not in card
    assert BASIC_CREDENTIAL not in card


def test_card_hides_url_userinfo() -> None:
    card = _card(f"fetch https://svc-user:{URL_PASSWORD}@host.example/x failed")

    assert URL_PASSWORD not in card
    assert "svc-user" not in card


PHONE_SHAPES = (
    PHONE_FORMATTED,
    ".".join(("555", "010", "4477")),
    " ".join(("555", "010", "4477")),
    "".join(("555", "010", "4477")),
)


@settings(derandomize=True, database=None, deadline=None, max_examples=len(PHONE_SHAPES))
@given(st.sampled_from(PHONE_SHAPES))
def test_card_hides_an_unlabelled_phone_number(phone: str) -> None:
    card = _card(f"call {phone} about the outage")

    assert "4477" not in card
    assert PHONE_DIGITS[1:] not in "".join(ch for ch in card if ch.isdigit())


def test_card_hides_a_colon_prefixed_absolute_path() -> None:
    card = _card("store file:/var/lib/bot-errors/private.db is locked")

    assert "/var/lib" not in card
    assert "private.db" not in card


def test_card_hides_relative_paths() -> None:
    card = _card("see logs/app.log and ./run-bot.sh and ../state/outbox/queue.json")

    assert "logs/app.log" not in card
    assert "run-bot.sh" not in card
    assert "queue.json" not in card


def test_card_hides_windows_paths() -> None:
    card = _card(r"open C:\Users\Owner\bot\token.txt and \\fileserver\share\keys failed")

    assert "C:\\" not in card
    assert "token.txt" not in card
    assert "fileserver" not in card


def test_card_hides_url_fragment_content() -> None:
    card = _card("open https://host.example/doc#cap-alpha-77 or host.example/doc#cap-beta-88 now")

    assert "cap-alpha-77" not in card
    assert "cap-beta-88" not in card


def test_card_hides_a_raw_shell_instruction() -> None:
    card = _card("run systemctl restart whatsoup-bot.service to recover")

    assert "systemctl" not in card
    assert "restart whatsoup" not in card


def test_card_footer_survives_a_year_one_timestamp() -> None:
    """New York conversion of 0001-01-01 UTC underflows; the card must still render."""
    card = _mod.format_public_message({
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "critical",
        "id": "evt-public-card-year-one",
        "createdAt": "0001-01-01T00:00:00Z",
        "machine": "host-a",
        "instance": "q",
        "source": "agent_reply_guarantee_breach",
        "summary": "reply queue is delayed",
    })

    assert card.endswith("· host-a · Date unavailable")


def test_card_keeps_plain_wording_that_only_resembles_these_classes() -> None:
    card = _card("basic sync and/or I/O degraded 24/7")

    assert "basic sync and/or I/O degraded 24/7" in card
