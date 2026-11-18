"""Public BOT ERRORS card rendering stays bounded and omits machine details."""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import time
from pathlib import Path

import pytest
from hypothesis import given, settings, strategies as st


_SCRIPT = Path(__file__).resolve().parents[1] / "bot-errors-dispatcher.py"


def _load():
    spec = importlib.util.spec_from_file_location("bot_errors_dispatcher_public_card", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


_mod = _load()


def _event(**overrides: object) -> dict[str, object]:
    event: dict[str, object] = {
        "schemaVersion": 2,
        "eventKind": "incident_alert",
        "eventType": "alert",
        "severity": "critical",
        "id": "evt-public-card-001",
        "createdAt": "2026-10-29T00:00:00Z",
        "machine": "host-a",
        "instance": "q",
        "source": "agent_reply_guarantee_breach",
        "summary": "ESCALATED still open: reply queue is delayed",
        "evidence": "ignored by the public card",
    }
    event.update(overrides)
    return event


def test_public_card_redacts_sensitive_details_without_forwarding_raw_owner_action() -> None:
    """Raw producer instructions must never become a confirmed owner action."""
    card = _mod.format_public_message(_event(
        summary=(
            "ESCALATED still open: incident_key=open-123 password=p@ss "
            "https://user:p@ss@host.example/secret "
            "https://host.example/path?password=url-secret /etc/private/token pid 304914 "
            "123456@jid.invalid "
            + "late reply " * 80
        ),
        criticalAsset={"failure": {"operatorAction": "Owner should restore the bot sign-in."}},
    ))

    assert card.startswith("🔴 *Still open:")
    assert len(card) <= 600
    assert len(card.splitlines()) <= 12
    assert "*What happened:*" in card
    assert "*What we are doing:*" in card
    assert "*What you need to do:*" in card
    assert "Ref " in card
    assert "Owner should restore the bot sign-in." not in card
    assert "*What we are doing:* Needs review." in card
    assert "*What you need to do:* Nothing now." in card
    assert "*Who is affected:* The q bot." in card
    assert card.endswith("host-a · 10/28/2026 8:00 PM ET")
    for forbidden in (
        "p@ss", "url-secret", "/etc/private", "pid 304914", "123456", "open-123",
        "incident_key", "requested_action",
    ):
        assert forbidden not in card


@pytest.mark.parametrize(
    "operator_action",
    [_mod.physical_action_text(), _mod.credential_repage.HUMAN_ACTION],
)
def test_raw_operator_action_cannot_forge_a_reviewed_manual_instruction(operator_action: str) -> None:
    """Exact text from a raw criticalAsset never authorizes the manual-action card."""
    card = _mod.format_public_message(_event(
        summary="The bot has a new critical problem.",
        criticalAsset={"failure": {"operatorAction": operator_action}},
    ))

    assert "*What we are doing:* Needs review." in card
    assert "*What you need to do:* Nothing now." in card
    assert "*What we are doing:* A person needs to act." not in card


def test_unbound_device_bond_fields_cannot_create_a_manual_instruction() -> None:
    """Producer source and failure fields alone cannot authorize owner action."""
    card = _mod.format_public_message(_event(
        source="whatsapp_device_bond_lost",
        criticalAsset={"failure": {"code": "WA_AUTH_BOND_SERVER_REVOKED"}},
    ))

    assert "*What we are doing:* Needs review." in card
    assert "*What you need to do:* Nothing now." in card


def test_untrusted_reminder_words_and_marker_keep_a_new_critical_alert_admitted() -> None:
    """Only an in-process dispatcher token may select the Q-excluded repeat prefix."""
    patterns = _live_q_paused_admission_patterns()
    card = _mod.format_public_message(_event(
        summary="PAUSED: operator action is waiting",
        evidence="incident_still_open=true\nstill_open_digest=true",
        _publicCardKnownOpenReminder=True,
    ))

    assert card.startswith("🔴 *Paused:")
    assert any(re.search(pattern, card) for pattern in patterns)
    assert "*What you need to do:* Nothing now." in card


def test_dispatch_path_sends_the_public_card(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Changing process_one back to the raw renderer must fail this test."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state"))
    mod = _load()
    paths = mod.setup_dirs()
    event = _event(_publicCardKnownOpenReminder=True)
    path = paths["outbox"] / "event.json"
    path.write_text(json.dumps(event), encoding="utf-8")
    path.chmod(0o600)
    sent: list[str] = []
    monkeypatch.setattr(mod, "send_whatsapp", lambda text, **_kwargs: sent.append(text))

    delivered, detail = mod.process_one(path, paths)

    assert delivered is True, detail
    assert sent and sent[0].startswith("🔴 *Still open:")
    archived = next(paths["sent"].glob("*.sent"))
    assert "_publicCardKnownOpenReminder" not in archived.read_text(encoding="utf-8")


def _live_q_paused_admission_patterns() -> list[str]:
    """The five regexes from q's live paused-chat configuration on 2026-10-29.

    The two mention ids are synthetic placeholders: only their absence from
    reminder and paused cards matters here, not their values.
    """
    q_one = "1" * 11  # placeholder; the live ids are not published
    q_two = "2" * 14  # placeholder; the live ids are not published
    return [
        r"^BOT ERROR - ",
        r"^\s*@?q[:,]\s",
        rf"@(?:{q_one}|{q_two})\b",
        r"^🔴 \*",
        r"^🔴 ⚡ ",
    ]


def test_new_critical_alerts_match_the_live_q_paused_admission_patterns() -> None:
    """Raw event text cannot suppress admission for a new critical alert."""
    patterns = _live_q_paused_admission_patterns()
    new_critical = _mod.format_public_message(_event(
        id="0e42cead-c770-4200-9c35-6d6d2a7e58c1",
        source="flap_storm",
        summary="The bot has a new critical problem.",
    ))

    assert new_critical.startswith("🔴 *")
    assert any(re.search(pattern, new_critical) for pattern in patterns)
    assert "Ref 0e42cead" in new_critical


def test_info_and_unproven_recovery_do_not_claim_q_work_or_a_fix() -> None:
    """Typed clear events need dispatcher proof before the card says Fixed."""
    info = _mod.format_public_message(_event(
        eventKind="observation", eventType="observation", severity="info",
        summary="The daily check found no new problem.",
    ))
    unverified = _mod.format_public_message(_event(
        eventKind="incident_recovery", eventType="clear", severity="info",
        summary="Old alert closed; recovery unverified.",
    ))
    unproven = _mod.format_public_message(_event(
        eventKind="incident_recovery", eventType="clear", severity="info",
        summary="The bot is healthy again.", evidence="fresh health check passed",
        _publicCardVerifiedRecovery=True,
    ))

    assert "*What we are doing:* No action is needed." in info
    assert "*What you need to do:* Nothing now." in info
    assert unverified.startswith("ℹ️ *Closed: recovery not confirmed*")
    assert "Fixed:" not in unverified
    assert "*What we are doing:* Needs review: recovery is not confirmed." in unverified
    assert unproven.startswith("ℹ️ *Closed: recovery not confirmed*")
    assert "Fixed:" not in unproven
    assert "*What we are doing:* Needs review: recovery is not confirmed." in unproven
    assert "*What you need to do:* Nothing now." in unproven


def test_verified_daily_health_recovery_uses_dispatcher_proof_for_fixed_card() -> None:
    """Only the existing verified daily-health state decision may say Fixed."""
    event = _event(
        eventKind="incident_recovery",
        eventType="clear",
        severity="info",
        source="daily-health",
        summary="The bot is healthy again.",
        evidence=(
            "health q: 200 status=healthy wa_connected=true state=connected "
            "auth_bond_status=present auth_bond_creds_exists=true "
            "auth_bond_creds_size=128 auth_failure_class=none"
        ),
    )
    state = {
        "openIncidents": {
            "host-a|q|daily-health-fail:q": {
                "status": "open",
                "openedAt": 1,
                "lastEvidence": "FAIL health q: socket disconnected",
            },
        },
    }

    _mod.append_clear_context(event, state)
    card = _mod.format_public_message(event)

    assert card.startswith("✅ *Fixed: The bot is healthy again.*")
    assert "*What we are doing:* No action is needed." in card
    assert "*What you need to do:* Nothing now." in card


@settings(derandomize=True, database=None, deadline=None)
@given(case=st.sampled_from((("underlying-open", True), ("quiet-unverified", False), ("aged-out", False))))
def test_observation_with_open_incident_keeps_internal_review(case: tuple[str, bool]) -> None:
    """A quiet alert stream must not dismiss its still-open underlying incident.

    The three endings are a finite domain; Hypothesis exhausts it.
    """
    ending, needs_review = case
    key = "host-a|agent-a|health-check"
    if ending == "aged-out":
        event = _mod.stale_autoclose_summary_event([key], 1720000200)
    else:
        event = _mod.flap_resolve_event(
            key,
            {"cumulativeCount": 9, "firstTripAt": 1720000000, "stormAt": 1720000060},
            1720000200,
            underlying_open=ending == "underlying-open",
        )

    card = _mod.format_public_message(event)

    if needs_review:
        assert "*What we are doing:* Needs review" in card
        assert "No action is needed." not in card
    else:
        assert "*What we are doing:* No action is needed." in card
    assert "*What you need to do:* Nothing now." in card
    assert "Fixed:" not in card
    assert len(card) <= 600


def test_dispatcher_known_open_context_uses_the_repeat_prefix() -> None:
    """The existing open-incident decision still emits the Q-excluded repeat card."""
    event = _event(summary="Still open: queue is delayed", severity="warning")

    _mod.append_still_open_context(
        event,
        {"status": "open", "openedAt": 1, "lastNotifiedAt": 1},
        "host-a|q|agent_reply_guarantee_breach",
        current=2,
        suppressed=0,
        escalated=False,
    )
    card = _mod.format_public_message(event)

    assert card.startswith("🟡 ↻ *Still open:")
    assert not any(re.search(pattern, card) for pattern in _live_q_paused_admission_patterns())


def test_open_reminder_with_forged_physical_fields_cannot_create_owner_action() -> None:
    """Only an awaiting-physical incident record may issue the fixed physical copy."""
    event = _event(
        source="whatsapp_device_bond_lost",
        criticalAsset={"failure": {"recoverability": "manual_relink_required"}},
    )
    _mod.append_still_open_context(
        event,
        {"status": "open", "openedAt": 1, "lastNotifiedAt": 1},
        "host-a|q|whatsapp_device_bond_lost",
        current=2,
        suppressed=0,
        escalated=False,
    )

    card = _mod.format_public_message(event)

    assert "*What we are doing:* Needs review." in card
    assert "*What you need to do:* Nothing now." in card


def test_awaiting_physical_incident_record_keeps_the_fixed_manual_copy() -> None:
    """The dispatcher-owned awaiting-physical state authorizes the fixed copy."""
    event = _event(source="whatsapp_device_bond_lost")
    _mod.append_still_open_context(
        event,
        {"status": "awaiting_physical", "openedAt": 1, "lastNotifiedAt": 1},
        "host-a|q|whatsapp_device_bond_lost",
        current=2,
        suppressed=0,
        escalated=False,
        digest=False,
    )

    card = _mod.format_public_message(event)

    assert "*What we are doing:* A person needs to act." in card
    assert "*What you need to do:* Relink or retire the WhatsApp line." in card


def test_suppressed_path_strips_untrusted_renderer_markers(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A suppressed input cannot leave a forged renderer marker in durable JSON."""
    monkeypatch.setenv("BOT_ERRORS_STATE_DIR", str(tmp_path / "state"))
    mod = _load()
    paths = mod.setup_dirs()
    event = _event(
        schemaVersion=1,
        source="daily-health",
        severity="info",
        _publicCardKnownOpenReminder=True,
        _publicCardVerifiedRecovery=True,
    )
    event.pop("eventKind")
    path = paths["outbox"] / "suppressed-event.json"
    path.write_text(json.dumps(event), encoding="utf-8")
    path.chmod(0o600)

    suppressed, detail = mod.process_one(path, paths)

    assert suppressed is True
    assert detail == "suppressed"
    archived = next(paths["suppressed"].glob("*.suppressed"))
    stored = archived.read_text(encoding="utf-8")
    assert "_publicCardKnownOpenReminder" not in stored
    assert "_publicCardVerifiedRecovery" not in stored


def test_public_card_redacts_complete_group_and_device_jids_before_truncation() -> None:
    """The formatter must remove whole WhatsApp IDs instead of leaving their prefixes."""
    digits = "".join(str(part) for part in range(1, 10))
    group_jid = f"{digits}-{digits[::-1]}@g.us"
    device_jid = f"{digits}:42@s.whatsapp.net"
    lid_jid = f"{digits}@lid"
    text = _mod.public_card_text(
        f"group={group_jid} device={device_jid} lid={lid_jid}",
        300,
    )

    assert "WHATSAPP JID" not in text
    for identifier in (
        group_jid,
        device_jid,
        lid_jid,
        f"{digits}-",
        f"{digits}:",
    ):
        assert identifier not in text


_SCHEME_CREDENTIAL = "".join(("schemetok", "Q7r8S9t0", "U1v2W3x4"))
_AUTHORIZATION_SUMMARIES = [
    f"Authorization: Token {_SCHEME_CREDENTIAL} was refused",
    f"Authorization: Digest {_SCHEME_CREDENTIAL} was refused",
    f"Authorization: Negotiate {_SCHEME_CREDENTIAL} was refused",
    f"Authorization: Custom-Scheme {_SCHEME_CREDENTIAL} was refused",
    f"Authorization: {_SCHEME_CREDENTIAL} was refused",
    f"Proxy-Authorization: Bearer {_SCHEME_CREDENTIAL} was refused",
    f"Proxy-Authorization: Token {_SCHEME_CREDENTIAL} was refused",
    f"headers {{'Authorization': 'Token {_SCHEME_CREDENTIAL}'}} refused",
    f'headers {{"Proxy-Authorization": "Negotiate {_SCHEME_CREDENTIAL}"}} refused',
    f'Authorization: "Token {_SCHEME_CREDENTIAL} refused',
]
# A marker followed by another [REDACTED] means the value was cut in two: the
# scheme word went one way and the credential the other.
_SPLIT_VALUE_MARKERS = re.compile(r"(?:\[REDACTED\]|\[detail omitted\])\s+\[REDACTED\]")


@pytest.mark.parametrize("summary", _AUTHORIZATION_SUMMARIES)
def test_public_card_hides_an_authorization_value_whatever_its_scheme(summary: str) -> None:
    """The whole Authorization or Proxy-Authorization value goes, for any scheme or none."""
    card = _mod.format_public_message(_event(summary=summary, evidence=summary))

    assert _SCHEME_CREDENTIAL not in card
    assert _SCHEME_CREDENTIAL[:12] not in card


@pytest.mark.parametrize("summary", _AUTHORIZATION_SUMMARIES)
def test_public_card_shows_an_authorization_value_as_one_marker(summary: str) -> None:
    """The card removes the value whole, scheme word included."""
    card = _mod.format_public_message(_event(summary=summary, evidence=summary))

    assert not _SPLIT_VALUE_MARKERS.search(card), card
    for scheme in ("Token", "Digest", "Negotiate", "Custom-Scheme", "Bearer"):
        assert scheme not in card


@pytest.mark.parametrize(
    "summary",
    [
        f"token: Token {_SCHEME_CREDENTIAL} refused",
        f"secret: Bearer {_SCHEME_CREDENTIAL} refused",
        f"token=Token {_SCHEME_CREDENTIAL} refused",
        f"secret=Digest {_SCHEME_CREDENTIAL} refused",
        f"password: Negotiate {_SCHEME_CREDENTIAL} refused",
        f"access_token: Token {_SCHEME_CREDENTIAL} refused",
        f"sessionToken: Digest {_SCHEME_CREDENTIAL} refused",
        f"x-auth-token: Negotiate {_SCHEME_CREDENTIAL} refused",
        f"api-key = Basic {_SCHEME_CREDENTIAL} refused",
        f'body {{"token": "Token {_SCHEME_CREDENTIAL}"}} refused',
        f"api_key: Custom {_SCHEME_CREDENTIAL} refused",
        f"password: Hawk id {_SCHEME_CREDENTIAL}, retrying",
    ],
)
def test_public_card_hides_a_scheme_credential_after_a_secret_key(summary: str) -> None:
    """A secret key's scheme word and credential go together, so the credential cannot follow a lone marker."""
    card = _mod.format_public_message(_event(summary=summary, evidence=summary))

    assert _SCHEME_CREDENTIAL not in card
    assert _SCHEME_CREDENTIAL[:12] not in card


@pytest.mark.parametrize(
    ("summary", "removed", "kept"),
    [
        ("login failed: token: expired yesterday, retrying in five minutes", ("expired", "yesterday"),
         "retrying in five minutes"),
        ("secret: rotated by the admin; restart pending", ("rotated", "admin"), "restart pending"),
        (f"api_key: Custom {_SCHEME_CREDENTIAL} & retry queued", (_SCHEME_CREDENTIAL[:12],), "retry queued"),
        (f'cookie: "sid {_SCHEME_CREDENTIAL}, path", then retry', (_SCHEME_CREDENTIAL[:12], "path"), "then retry"),
    ],
)
def test_public_card_removes_a_whole_secret_key_value_and_keeps_the_text_after_it(
    summary: str, removed: tuple[str, ...], kept: str
) -> None:
    """The value ends at its closing quote or, unquoted, at the next , ; & or line end; the rest stays."""
    card = _mod.format_public_message(_event(summary=summary, evidence=summary))

    for fragment in removed:
        assert fragment not in card
    assert kept in card


@pytest.mark.parametrize(
    "text",
    [
        "a-" * 8000 + f"token: Token {_SCHEME_CREDENTIAL}",
        "a_" * 8000 + f"token: Token {_SCHEME_CREDENTIAL}",
        "a." * 8000 + f"token: Token {_SCHEME_CREDENTIAL}",
        "token: a, " * 3000 + f"token: {_SCHEME_CREDENTIAL}",
        "token: \"a, token: 'b, " * 1500 + f"token: {_SCHEME_CREDENTIAL}",
    ],
    ids=["hyphens", "underscores", "dots", "many-keys", "unclosed-quotes"],
)
def test_public_card_secret_value_rule_stays_linear(text: str) -> None:
    """A hyphen segment in the key once rescanned the whole run from every word boundary."""
    start = time.perf_counter()
    redacted = _mod.public_card_keyed_values(text)
    elapsed_ms = (time.perf_counter() - start) * 1000

    assert elapsed_ms < 250
    assert _SCHEME_CREDENTIAL not in redacted


@pytest.mark.parametrize("text", ["a-" * 8000, "a." * 8000], ids=["hyphen-run", "dot-run"])
def test_public_card_text_stays_linear_on_16_kb_runs(text: str) -> None:
    """The whole card boundary, not one rule: a link rule once rescanned the run from every boundary.

    The boundary is also timed on the whole run directly, because the card may
    pass it less than the whole text.
    """
    for render in (lambda: _mod.public_card_text(text, 600), lambda: _mod.public_card_boundary(text)):
        start = time.perf_counter()
        render()
        elapsed_ms = (time.perf_counter() - start) * 1000

        assert elapsed_ms < 250


# Opus M6 (B7 re-gate): the host-path-with-fragment rule starts after "_" and
# after a "." that no label character precedes, as it did before the
# linear-time fix, so these links are omitted again.
_CARD_FRAGMENT = "".join(("FRAG", "q7Wz", "tail"))


@pytest.mark.parametrize(
    "summary",
    [f"see my_svc.example.org/cb#{_CARD_FRAGMENT} now", f"see ...example.org/cb#{_CARD_FRAGMENT} now"],
    ids=["after-underscore", "after-dots"],
)
def test_public_card_omits_a_host_path_with_fragment_after_underscore_or_dots(summary: str) -> None:
    card = _mod.public_card_text(summary, 600)

    assert _CARD_FRAGMENT not in card
    assert "[link omitted]" in card


# Repeated units that drove the card's host-path-with-fragment rule quadratic. Each is a
# reproducer of a measured regression, not a sample of an input domain, so the list is fixed.
_HOST_FRAGMENT_RULE_RUNS = {
    "dot-run": "a.",  # a start after every "." rescanned the run (2.3 s on 16 KB)
    "digit-dot-run": "1.",
    "leading-dot-run": ".a",
    "underscore-dot-run": "_a.a",  # the rule must start after "_" again (Opus M6)
    "underscore-run": "a_",
    "hyphen-run": "a-",
    "underscore-dot-pairs": "_a._a",
    "host-slash-run": "a.a/",  # a start after every "/" rescanned the path (9dbb5a5d7: 25 s at 128 KB)
}


@pytest.mark.parametrize("run", list(_HOST_FRAGMENT_RULE_RUNS))
def test_public_card_host_fragment_rule_stays_linear_to_128_kb(run: str) -> None:
    """A start after every "." of a dotted run rescanned the run from each one (2.3 s on 16 KB), and a
    start after every "/" rescanned the path after it (9dbb5a5d7: 1.4 s at 32 KB, 25 s at 128 KB).

    The boundary is also timed on the whole text directly, because the card may
    pass it less than the whole text.
    """
    unit = _HOST_FRAGMENT_RULE_RUNS[run]
    renders = {"card": lambda text: _mod.public_card_text(text, 600), "boundary": _mod.public_card_boundary}
    for name, render in renders.items():
        timings = {}
        for size in (32_768, 131_072):
            text = unit * (size // len(unit))
            best = None
            for _ in range(3):
                start = time.perf_counter()
                render(text)
                elapsed = time.perf_counter() - start
                best = elapsed if best is None else min(best, elapsed)
            timings[size] = best * 1000

        # Linear growth is 4x from 32 KB to 128 KB; a quadratic rule grows 16x.
        assert timings[131_072] < 1000, (name, timings)
        assert timings[131_072] < 8 * max(timings[32_768], 1.0), (name, timings)


# Card reproducers from the B7 gate reviews. Each credential is built at run
# time; its tail must vanish, because a value cut in two leaves the tail.
_CARD_CANARY = "".join(("canary", "Q7w8", "E9r0T1y2"))
_CARD_HEAD, _CARD_TAIL = _CARD_CANARY[:8], _CARD_CANARY[8:]
_CARD_LETTERS_ONLY_BASIC = "".join(("dXNl", "cjpw", "YXNz"))
_CARD_PEM_LABEL = " ".join(("EC", "PRIVATE", "KEY"))
_CARD_PEM_BLOCK = (
    f"-----BEGIN {_CARD_PEM_LABEL}-----\nMHcCAQEEI{_CARD_CANARY}{_CARD_CANARY}\n"
    f"AwEHoUQDQgAE{_CARD_CANARY}\n-----END {_CARD_PEM_LABEL}-----"
)
_CARD_LEAKS = {
    "secret-key-escaped-quote": f'{{"token": "Token prefix\\" {_CARD_CANARY}"}}',
    "authorization-escaped-quote": f'{{"authorization": "Token prefix\\" {_CARD_CANARY}"}}',
    "split-credential": f"Authorization: Token {_CARD_HEAD}\n {_CARD_TAIL}",
    "split-proxy-credential": f"Proxy-Authorization: Token {_CARD_HEAD}\n {_CARD_TAIL}",
    "split-secret-key-credential": f"api_key: Custom {_CARD_HEAD}\n\t{_CARD_TAIL}",
    "pem-after-secret-key": f"jwt_secret: {_CARD_PEM_BLOCK}",
    "pem-after-password": f"password: {_CARD_PEM_BLOCK}",
    "http-authorization-colon": f"HTTP_AUTHORIZATION: Token {_CARD_CANARY}",
    "http-authorization-equals": f"HTTP_AUTHORIZATION=Token {_CARD_CANARY}",
    "http-authorization-dict": f"{{'HTTP_AUTHORIZATION': 'Basic {_CARD_CANARY}'}}",
    "http-proxy-authorization": f"HTTP_PROXY_AUTHORIZATION: Negotiate {_CARD_CANARY}",
    "proxy-authorization-underscore": f"proxy_authorization: Token {_CARD_CANARY}",
    "proxy-authorization-camel": f"proxyAuthorization: Token {_CARD_CANARY}",
    "passphrase-custom": f"passphrase: Custom {_CARD_CANARY}",
    "session-custom": f"session: Custom {_CARD_CANARY}",
    "pat-custom": f"pat: Custom {_CARD_CANARY}",
    "credential-custom": f"credential: Custom {_CARD_CANARY}",
    "passphrase-quoted-words": f'passphrase: "correct {_CARD_CANARY}"',
    "raw-headers-pair": f"rawHeaders: [ 'Authorization', 'Token {_CARD_CANARY}' ]",
    "header-tuple": f"[('Authorization', 'Basic {_CARD_CANARY}')]",
    "basic-letters-only": f"request failed: Basic {_CARD_LETTERS_ONLY_BASIC}",
}


@pytest.mark.parametrize("summary", list(_CARD_LEAKS.values()), ids=list(_CARD_LEAKS))
def test_public_card_shows_no_credential_fragment(summary: str) -> None:
    """Checked untruncated and on the rendered card, so truncation cannot hide a leak."""
    text = _mod.public_card_text(summary, 4000)
    card = _mod.format_public_message(_event(summary=summary, evidence=summary))

    for rendered in (text, card):
        assert _CARD_TAIL not in rendered
        assert _CARD_LETTERS_ONLY_BASIC not in rendered
        assert "MHcCAQEEI" not in rendered


def test_public_card_reads_the_credential_check_label_as_a_label() -> None:
    """credential_check is not a secret key; credential still is.

    The card's general rule omits every key=value detail, so the requirement
    name itself shows as "[detail omitted]" here; stored records keep it.
    """
    line = "OK credential_check: credential_requirement=tokens.env credential_path_redacted=true mode=600"
    text = _mod.public_card_text(line, 600)

    assert "[REDACTED]" not in text
    assert text.startswith("OK credential check: ")
    secret_text = _mod.public_card_text(f"credential: {_CARD_CANARY} refused", 600)
    assert _CARD_TAIL not in secret_text


def test_public_card_keeps_a_sentence_about_authorization() -> None:
    """Prose has no key separator, so the authorization rules leave it as written."""
    sentence = "authorization failed for the bot"
    card = _mod.format_public_message(_event(summary=sentence, evidence=sentence))

    assert _mod.public_card_text(sentence, 300) == sentence
    assert f"*What happened:* {sentence}" in card


def _shown_parts(secret: str, rendered: str) -> list[str]:
    """Every four-character piece of `secret` that `rendered` holds, case folded."""
    folded = rendered.casefold()
    return [secret[at:at + 4] for at in range(len(secret) - 3) if secret[at:at + 4].casefold() in folded]


def _card_renderings(summary: str) -> tuple[str, str]:
    """The card helper as the dispatcher calls it, untruncated, and the whole delivered card."""
    event = _event(summary=summary, evidence=summary)
    return _mod.public_card_text(_mod.event_display_summary(event), 100_000), _mod.format_public_message(event)


# A quoted value that ends in a secret key, with ":" or "=" after its closing
# quote, is a chained key: what follows is that key's value. Taking the quoted
# text as the outer key's whole value removed the inner key and left its
# credential with no key in front of it. The secrets are synthetic.
_CHAINED_SECRET = "".join(("Wv4Kx", "Pq8Ym", "Rt3Zn"))
_CHAINED_FIRST = "".join(("Hc5Lb", "Mt9Qe"))
# "plain-outer-key" ('"token" = "api_key": <credential>') and "key-after-break"
# ('token: "<first>-session": <credential>') left this list under owner ruling
# R96: main shows the credential after them and the owner accepted main's
# behavior, so test_bot_errors_public_card_against_main.py holds the card to
# what main hides there.
_CHAINED_KEY_SUMMARIES = {
    "escaped-outer-key-space": f'\\"token\\" = "api_key": {_CHAINED_SECRET}',
    "escaped-outer-key-tab": f'\\"token\\" = "api_key":\t{_CHAINED_SECRET}',
    "three-keys": f'"token" = "api_key":"secret"={_CHAINED_SECRET} end',
    "key-after-prose": f'"secret": "{_CHAINED_FIRST}, retry api_key": "{_CHAINED_SECRET}"',
    "key-after-prose-single-quotes": f"secret='{_CHAINED_FIRST} retry token': '{_CHAINED_SECRET}'",
    "key-after-prose-unquoted-value": f'token: "{_CHAINED_FIRST} and password": {_CHAINED_SECRET}',
}


@pytest.mark.parametrize("summary", list(_CHAINED_KEY_SUMMARIES.values()), ids=list(_CHAINED_KEY_SUMMARIES))
def test_public_card_hides_the_credential_after_a_chained_key(summary: str) -> None:
    """No piece of either secret stays, on the card helper or on the delivered card."""
    for rendered in _card_renderings(summary):
        assert not _shown_parts(_CHAINED_SECRET, rendered), rendered
        assert not _shown_parts(_CHAINED_FIRST, rendered), rendered


# The accepted residual: an unknown first word after a secret key is accepted at
# rest only, and the card removes the whole value. With "&" in front, the shared
# redactor takes "&Bearer" as a one-word value and leaves the credential after it.
_RESIDUAL_CREDENTIAL = "".join(("Rk9v", "YmFy", "Qm9i"))


@pytest.mark.parametrize(
    "summary",
    [
        f"'token': &Bearer {_RESIDUAL_CREDENTIAL}",
        f"token: &Bearer {_RESIDUAL_CREDENTIAL}",
        f"api_key=&&Basic {_RESIDUAL_CREDENTIAL} retry queued",
    ],
    ids=["quoted-key", "plain-key", "two-ampersands"],
)
def test_public_card_hides_the_accepted_residual_after_an_ampersand(summary: str) -> None:
    for rendered in _card_renderings(summary):
        assert not _shown_parts(_RESIDUAL_CREDENTIAL, rendered), rendered
