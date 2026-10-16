"""Card hygiene for every BOT ERRORS card a test renders (relay 16 B, relay 19 B3/B4; not deployed).

A card carries no paths (absolute, or relative and file-like; checked by
``card_path_tokens``, not by the scrubber's regex), event ids,
digests, pids, incident keys, long numbers, key=value fields, schema words or
"@" + digit. The Ref value is 8 hex and is checked separately; the Ref line is
left out of the pattern check.

``install_card_hygiene_hook`` wraps a loaded dispatcher module's card renderers
so that EVERY card a test renders through them is checked, not only the goldens.
The renderers call one another through module globals, so wrapping the module
attributes covers the cards built inside ``notice_message`` and the daily senders.
"""
from __future__ import annotations

import functools
import re
from typing import Any

FORBIDDEN_CARD_PATTERNS = [
    re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.IGNORECASE),  # event id
    re.compile(r"\bdigest\b", re.IGNORECASE),
    re.compile(r"\bchars\b", re.IGNORECASE),
    re.compile(r"\bpid\b", re.IGNORECASE),
    re.compile(r"\|"),  # incident keys are machine|instance|source
    re.compile(r"(?<!\d)\d{6,}(?!\d)"),  # chat, phone and epoch-stamped ids
    re.compile(r"\b[A-Za-z_][\w.-]*=\S"),  # key=value machine fields
    re.compile(r"@[0-9+]"),  # a mention Q's @-number rule could admit
    re.compile(
        r"\b(?:summary_confined|incident_key|severity|alert_source|dispatcher_attempts|dispatch_log|"
        r"requested_action|clear_requirement|failure_code|failure_domain|recoverability|asset_kind|"
        r"journalctl|queue|evidence|source)\b",
        re.IGNORECASE,
    ),
]

CARD_RENDERERS = (
    "format_card",
    "format_resolved_page_card",
    "format_information_summary_card",
    "format_line_card",
)


def card_body_without_ref(card: str) -> str:
    return "\n".join(line for line in card.split("\n") if not line.startswith("Ref: "))


# Paths are checked token by token, not with the scrubber's regex (relay 21
# N3): a copy of that regex could not catch a gap of the same shape.
_TOKEN_EDGE = "\"'`()[]{}<>,;:*!?"
_DECIMAL = re.compile(r"\d+\.\d+")


def _file_like(segment: str) -> bool:
    """A segment with a dot extension of 1 to 8 letters or digits; a decimal is not one."""
    _stem, dot, extension = segment.rpartition(".")
    if not dot or _DECIMAL.fullmatch(segment):
        return False
    return 1 <= len(extension) <= 8 and extension.isascii() and extension.isalnum()


def card_path_tokens(text: str) -> list[str]:
    """Every token of the text that is a path: absolute or home, three segments
    or more, or two segments with a file-like one; "/" or "\\" separated."""
    found = []
    for raw in text.split():
        token = raw.strip(_TOKEN_EDGE).rstrip(".")
        if "/" not in token and "\\" not in token:
            continue
        segments = [segment for segment in re.split(r"[/\\]", token) if segment]
        if token.startswith(("/", "~")) or len(segments) >= 3 or any(_file_like(s) for s in segments):
            found.append(token)
    return found


def card_hygiene_violations(card: str) -> list[str]:
    body = card_body_without_ref(card)
    violations = [pattern.pattern for pattern in FORBIDDEN_CARD_PATTERNS if pattern.search(body)]
    paths = card_path_tokens(body)
    if paths:
        violations.append(f"path {paths}")
    return violations


class CardHygieneViolation(BaseException):
    """A card carried a machine field.

    A BaseException on purpose: the dispatcher renders cards inside
    ``except Exception`` fallbacks (notice_message sends the full body when a
    card or packet fails), which would swallow an AssertionError and hide the
    violation behind a fallback. This one reaches the test.
    """


def assert_card_hygiene(card: str) -> None:
    violations = card_hygiene_violations(card)
    if violations:
        raise CardHygieneViolation(violations, card)


def install_card_hygiene_hook(module: Any, monkeypatch: Any = None) -> list[str]:
    """Check every card the module's renderers return; returns the list of checked cards."""
    rendered: list[str] = []
    for name in CARD_RENDERERS:
        original = getattr(module, name)
        if getattr(original, "_card_hygiene_hooked", False):
            continue

        def make(renderer: Any) -> Any:
            @functools.wraps(renderer)
            def checked(*args: Any, **kwargs: Any) -> str:
                card = renderer(*args, **kwargs)
                assert_card_hygiene(card)
                rendered.append(card)
                return card

            checked._card_hygiene_hooked = True  # type: ignore[attr-defined]
            return checked

        if monkeypatch is not None:
            monkeypatch.setattr(module, name, make(original))
        else:
            setattr(module, name, make(original))
    return rendered
