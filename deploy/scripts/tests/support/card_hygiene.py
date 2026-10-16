"""Card hygiene for every BOT ERRORS card a test renders (relay 16 B, relay 19 B3/B4; not deployed).

A card carries no paths (absolute, or relative and file-like), event ids,
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

# A path segment that looks like a file or folder: a dot extension or a common
# folder word (relay 20 M1). Plain words joined by a slash ("and/or", "3/4") pass.
_FILE_SEGMENT = (
    r"(?:[\w-]*\.[A-Za-z][\w.-]*"
    r"|(?:logs?|config|conf|src|lib|tmp|temp|var|etc|bin|data|state|deploy|scripts?|tests?|build|dist"
    r"|home|cache|packets|outbox|node_modules)(?![\w.-]))"
)

FORBIDDEN_CARD_PATTERNS = [
    re.compile(r"(?:^|[\s(=])(?:~[\w.@-]*)?/[\w.@-]+"),  # an absolute path, one segment or more
    re.compile(r"(?<![\w./-])[\w.-]+(?:/[\w.-]+){2,}"),  # a relative path, three segments or more
    re.compile(  # a relative path of two segments, one of them file-like
        rf"(?<![\w./-])(?:{_FILE_SEGMENT}/[\w.-]+|[\w.-]+/{_FILE_SEGMENT})"
    ),
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


def card_hygiene_violations(card: str) -> list[str]:
    body = card_body_without_ref(card)
    return [pattern.pattern for pattern in FORBIDDEN_CARD_PATTERNS if pattern.search(body)]


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
