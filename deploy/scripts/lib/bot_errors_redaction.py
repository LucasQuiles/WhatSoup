"""Shared redaction helpers for manifest-tracked BOT ERRORS deploy scripts."""

from __future__ import annotations

import os
import re
from typing import Any

AUTHORIZATION_BEARER_RE = re.compile(r"\b(authorization\s*[:=]\s*(?:Bearer|Basic)\s+)[^\s\\\"',;}]+", re.IGNORECASE)
AUTHORIZATION_KEYED_RE = re.compile(
    r"(^|[^A-Za-z0-9_]|\\n)"
    r"([\"']?authorization[\"']?\s*[:=]\s*[\"']?)"
    r"(?!(?:Bearer|Basic)\s)"
    r"([^\s\\,\"';}]+)([\"']?)",
    re.IGNORECASE,
)
BEARER_VALUE_RE = re.compile(r"\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}", re.IGNORECASE)
# C1 (ReDoS): the `api[_-]?key` alternative bounds its optional prefix/suffix
# wildcards to `[A-Za-z0-9_.-]{0,20}` instead of unbounded `*`. The prefix group
# already anchors the key start; the `*` form backtracked quadratically on dotted
# input (e.g. `1.1.1.…`). The bound still catches `x-api-key`/`apikey`/`x_api_key`.
# C3 (`token=Bearer <secret>` leak): the VALUE capture optionally consumes a
# leading `Bearer `/`Basic ` scheme so the whole token is masked.
KEYED_SECRET_RE = re.compile(
    r"(^|[^A-Za-z0-9_]|\\n)"
    # BEAD-055 + QR-052: anchor a known-secret tail even when the key carries a
    # compound prefix. Two prefix shapes are handled:
    #   (a) multi-underscore compounds — `(?:[A-Za-z0-9]+_)*` consumes ANY number of
    #       `<alnum>_` segments (BEAD-055 allowed only ONE, so `AWS_SESSION_TOKEN=`
    #       and `AWS_SECRET_ACCESS_KEY=` LEAKED). Each segment ends in a literal `_`,
    #       so the split is deterministic: no catastrophic backtracking.
    #   (b) camelCase-glued keys — the `[A-Za-z0-9]{1,40}(?:token|secret|password|
    #       passphrase|api[_-]?key)` branch catches `sessionToken=`/`bearerToken=`/
    #       `idToken=` where the secret word is a glued suffix. The `{1,40}` bound caps
    #       prefix backtracking (ReDoS-safe).
    # Benign tails (`event_count`, `message_id`, `session_id`, `user_id`,
    # `retry_count`) stay untouched — their tails are not secret-key words.
    r"([\"']?(?:[A-Za-z0-9]+_)*(?:(?:[A-Za-z0-9_.-]{0,20}api[_-]?key[A-Za-z0-9_.-]{0,20})|client[_-]?secret|secret[_-]?access[_-]?key|access[_-]?token|"
    r"refresh[_-]?token|auth[_-]?token|cookie|password|passphrase|secret|session|token|"
    r"[A-Za-z0-9]{1,40}(?:token|secret|password|passphrase|api[_-]?key)|"
    r"pat)[\"']?\s*[:=]\s*[\"']?)"
    r"((?:(?:Bearer|Basic)\s+)?[^\s\\,\"';}]+)([\"']?)",
    re.IGNORECASE,
)
CREDENTIAL_PATH_RE = re.compile(
    r"(?:(?<![A-Za-z0-9._~-])~|(?<![A-Za-z0-9._~-])/)[^\s\"',;}]*?(?:"
    r"\.config/secrets/[^\s\"',;}]+|"
    r"\.config/whatsoup/[^\s\"',;}]+|"
    r"\.local/share/whatsoup/instances/[^\s\"',;}]*/auth(?:/[^\s\"',;}]+)?|"
    r"auth-bond-backups/[^\s\"',;}]+|"
    r"/(?:bot-errors\.env|fleet-token|fleet\.env|fleet-tokens\.json|tokens\.env|secrets\.env|\.env(?:\.[^\s\"',;}]+)?)"
    r")\b",
    re.IGNORECASE,
)
WHATSAPP_JID_RE = re.compile(r"\b\d{5,}(?:-\d+)?(?::\d+)?@(s\.whatsapp\.net|g\.us|lid)\b", re.IGNORECASE)
WHATSAPP_SERVICE_UNIT_RE = re.compile(r"\b(whatsoup@)(\d{8,16})(\.service)?\b", re.IGNORECASE)
KEYED_PHONE_LIKE_RE = re.compile(
    r"(?<![A-Za-z0-9])(phone|phone[_-]?number|msisdn|line)(\s*[:=]\s*|[\s_-]+)(\+?\d{10,16})(?![A-Za-z0-9])",
    re.IGNORECASE,
)
CONTEXT_PHONE_LIKE_RE = re.compile(r"(?<![A-Za-z0-9])(for)([\s_-]+)(\+?\d{10,16})(?![A-Za-z0-9])", re.IGNORECASE)
PHONE_LIKE_RE = re.compile(r"(^|[^\w])(\+?(?:\d[\d\s().-]{8,}\d))(?![\w])")
AWS_ACCESS_KEY_ID_RE = re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")
GITHUB_TOKEN_RE = re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b")
JWT_VALUE_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")
PEM_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
)
# BEAD-054 (ReDoS): bound the scheme prefix to `{0,30}` instead of unbounded `*`.
# The `*` form backtracked quadratically on adversarial scheme-shaped runs (e.g.
# `apikey.`*N → ~8s on 140KB) because `[a-z0-9+.-]*` greedily consumed the whole
# input then re-tried `://` at every offset. The bound keeps the scan LINEAR while
# still masking creds for ANY scheme (redis/postgres/wss/https/ldap/ftp/…).
URL_USERINFO_RE = re.compile(r"\b([a-z][a-z0-9+.-]{0,30}://)[^\s/@:]+:[^\s/@]+@", re.IGNORECASE)


def redact_phone_like_match(match: re.Match[str], marker: str) -> str:
    candidate = match.group(2)
    stripped = candidate.strip()
    # I1 fix: the dotted-version guard must NOT exempt a phone written in dotted
    # form (e.g. `212.555.0181`, 10 digits in 3 short groups). A real version
    # carries a long build/segment number (>= 5 digits) or more than 15 total
    # digits; a dotted phone has 10–15 digits in short (<= 4 digit) groups. Only
    # exempt the candidate when it is a real version by that test.
    if re.fullmatch(r"\d+(?:\.\d+){2,}(?:[-+~][A-Za-z0-9.-]+)?", stripped):
        runs = re.findall(r"\d+", stripped)
        total_digits = sum(len(run) for run in runs)
        longest_run = max((len(run) for run in runs), default=0)
        if total_digits > 15 or longest_run >= 5:
            return match.group(0)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:[ T]\d{2}(?::\d{2}(?::\d{2})?)?)?", stripped):
        return match.group(0)
    digits = re.sub(r"\D", "", candidate)
    has_phone_syntax = stripped.startswith("+") or bool(re.search(r"[\s().-]", candidate))
    if has_phone_syntax and 10 <= len(digits) <= 15:
        return f"{match.group(1)}{marker}"
    return match.group(0)


# Recognizable, non-secret directory categories. When safe-shape is enabled we
# preserve the leading category so an operator can tell WHICH file is missing,
# while the secret leaf is reduced to a redacted marker. None of these prefixes
# is itself a secret (they are well-known config locations).
_CRED_PATH_SAFE_PREFIXES = (
    ".config/secrets/",
    ".config/whatsoup/",
    ".local/share/whatsoup/instances/",
    "auth-bond-backups/",
)


def _safe_shape_cred_path_enabled() -> bool:
    return os.environ.get("BOT_ERRORS_SAFE_SHAPE_CRED_PATH", "").strip().lower() in {"1", "true", "yes", "on"}


def _safe_shape_credential_path(matched: str, marker: str) -> str:
    """Reduce a credential-adjacent path to an actionable shape.

    Keeps the recognizable directory category (so the operator knows which file
    is in play) and replaces the secret leaf with ``[REDACTED]``. Falls back to
    the opaque marker when no known category is recognizable, so a real secret
    value is never exposed.
    """
    for prefix in _CRED_PATH_SAFE_PREFIXES:
        idx = matched.find(prefix)
        if idx != -1:
            return f"{matched[:idx]}{prefix}[REDACTED]"
    return marker


def redact_bot_errors_text(
    value: Any,
    *,
    credential_path_marker: str,
    jid_marker: str = "[REDACTED WHATSAPP JID]",
    phone_marker: str = "[REDACTED PHONE]",
    private_key_marker: str = "[REDACTED PEM PRIVATE KEY]",
    aws_marker: str = "[REDACTED AWS ACCESS KEY]",
    github_marker: str = "[REDACTED GITHUB TOKEN]",
    jwt_marker: str = "[REDACTED JWT]",
) -> str:
    text = "" if value is None else str(value)
    text = PEM_PRIVATE_KEY_RE.sub(private_key_marker, text)
    if _safe_shape_cred_path_enabled():
        text = CREDENTIAL_PATH_RE.sub(
            lambda m: _safe_shape_credential_path(m.group(0), credential_path_marker), text
        )
    else:
        text = CREDENTIAL_PATH_RE.sub(credential_path_marker, text)
    text = WHATSAPP_JID_RE.sub(jid_marker, text)
    text = WHATSAPP_SERVICE_UNIT_RE.sub(lambda m: f"{m.group(1)}{phone_marker}{m.group(3) or ''}", text)
    text = URL_USERINFO_RE.sub(r"\1[REDACTED]@", text)
    text = AWS_ACCESS_KEY_ID_RE.sub(aws_marker, text)
    text = GITHUB_TOKEN_RE.sub(github_marker, text)
    def redact_keyed(match: re.Match[str]) -> str:
        return f"{match.group(1)}{match.group(2)}[REDACTED]{match.group(4)}"

    text = JWT_VALUE_RE.sub(jwt_marker, text)
    text = AUTHORIZATION_BEARER_RE.sub(r"\1[REDACTED]", text)
    text = AUTHORIZATION_KEYED_RE.sub(redact_keyed, text)
    text = KEYED_SECRET_RE.sub(redact_keyed, text)
    text = BEARER_VALUE_RE.sub(r"\1[REDACTED]", text)
    text = KEYED_PHONE_LIKE_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}{phone_marker}", text)
    text = CONTEXT_PHONE_LIKE_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}{phone_marker}", text)
    return PHONE_LIKE_RE.sub(lambda m: redact_phone_like_match(m, phone_marker), text)


def redact_json_value(value: Any, redact_text) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [redact_json_value(item, redact_text) for item in value]
    if isinstance(value, dict):
        return {str(key): redact_json_value(item, redact_text) for key, item in value.items()}
    return value


# ---------------------------------------------------------------------------
# #2386 — legacy confined alert-content compatibility reader
# ---------------------------------------------------------------------------
# The TypeScript producer's confineAlertContent boundary replaced the
# operator-visible `summary`/`evidence` strings with a three-key confinement
# envelope. Two serialisations reach this consumer:
#   * the live mapping {"failureClass": str, "length": int, "correlationDigest": str}
#   * a baked `repr` string, produced wherever that mapping reached str()
# The baked form appears in TWO key orders, so every matcher below is
# key-order-insensitive. A matcher pinned to one order is blind to the other and
# silently under-reports. Only one of the two comes from the producer, which
# builds the object literal in failureClass order and serialises it with
# insertion order preserved; the alphabetical form arises on this side, from
# sort_keys round-trips through persisted state. Order-insensitive matching is
# required either way -- both forms are in the corpus -- but the second order is
# ours, not the producer's.
#
# Rendering is deliberately restricted to the EXACT three-key shape. An arbitrary
# mapping is never rendered: its values could be anything, and printing them would
# defeat the confinement boundary this envelope exists to enforce. Unknown shapes
# get a fixed sentinel and are quarantined by the caller.
#
# This reader never evaluates queue text and never parses it as JSON. The repr is
# matched structurally and its three typed values are read out of the regex match,
# so a hostile string is inert here. A source-scan test enforces that.

LEGACY_CONFINED_KEYS = frozenset({"failureClass", "length", "correlationDigest"})

UNRENDERABLE_ALERT_CONTENT = "[unrenderable alert content]"

_LEGACY_DIGEST_RE = re.compile(r"\A[0-9a-f]{64}\Z")

# One `'key': value` pair of the envelope's repr. Values are typed at the pair
# level: a single-quoted literal or a bare integer. `[^'{}]*` keeps a pair from
# swallowing a brace, so the three-pair bound below cannot be defeated by a
# nested structure.
#
# The digit run is BOUNDED at 19. CPython refuses int(str) past 4300 digits, and
# _parse_baked_repr converts before it validates keys, so an unbounded run let a
# queue string raise ValueError from inside the render path -- which has no guard
# above it, so one such event aborted the whole dispatcher cycle and stayed in the
# outbox to re-poison the next one. A character count cannot need 19 digits, so an
# over-long run is simply not this envelope and falls through to the text path.
# The bound must appear in BOTH grammars below: bounding only the parser would
# leave the scan matching and the parser still converting.
_REPR_PAIR = r"'[A-Za-z][A-Za-z0-9_]*': (?:'[^'{}]*'|\d{1,19})"

# Anchored: the whole string is one brace group holding EXACTLY three pairs, in
# any order. Key identity and value typing are verified by _parse_baked_repr
# after the match, which is what rejects a duplicate key or a four-key repr.
_BAKED_REPR_RE = re.compile(r"\A\{" + _REPR_PAIR + r"(?:, " + _REPR_PAIR + r"){2}\}\Z")

# Same grammar, unanchored: finds an envelope embedded in surrounding operator
# text. Persisted incident state carries prefixed forms (an escalation prefix
# concatenated onto a baked envelope), so rendering must reach those too.
_BAKED_REPR_SCAN_RE = re.compile(r"\{" + _REPR_PAIR + r"(?:, " + _REPR_PAIR + r"){2}\}")

_REPR_PAIR_PARTS_RE = re.compile(
    r"'(?P<key>[A-Za-z][A-Za-z0-9_]*)': (?:'(?P<text>[^'{}]*)'|(?P<number>\d{1,19}))"
)


# What an OPERATOR reads is the 8-character prefix; it is a display convenience.
# What decides INCIDENT IDENTITY is the full digest. Those are different jobs and
# they get different renderings: collapsing identity onto 32 bits merges distinct
# incidents, which is a silent loss, so the fingerprint path takes all 64 chars.
LEGACY_DISPLAY_DIGEST_CHARS = 8
LEGACY_FULL_DIGEST_CHARS = 64


def _legacy_confined_mapping_to_text(
    value: Any, *, digest_chars: int = LEGACY_DISPLAY_DIGEST_CHARS
) -> str | None:
    """Render a live confinement-envelope mapping, or None if it is not one."""
    if not isinstance(value, dict):
        return None
    if frozenset(value.keys()) != LEGACY_CONFINED_KEYS:
        return None
    failure_class = value.get("failureClass")
    length = value.get("length")
    digest = value.get("correlationDigest")
    if not isinstance(failure_class, str):
        return None
    # bool is an int subclass; a boolean is not a character count.
    if isinstance(length, bool) or not isinstance(length, int):
        return None
    if not isinstance(digest, str) or not _LEGACY_DIGEST_RE.match(digest):
        return None
    return f"{failure_class} - {length} chars - digest {digest[:digest_chars]}"


def _parse_baked_repr(text: str) -> dict[str, Any] | None:
    """Read the three typed values out of a matched repr, or None.

    Structural only -- the values come from regex groups, never from evaluating
    the string. Rejects a duplicate key, which the three-pair bound alone allows.
    """
    parsed: dict[str, Any] = {}
    for match in _REPR_PAIR_PARTS_RE.finditer(text):
        key = match.group("key")
        if key in parsed:
            return None
        number = match.group("number")
        parsed[key] = int(number) if number is not None else match.group("text")
    if frozenset(parsed.keys()) != LEGACY_CONFINED_KEYS:
        return None
    return parsed


def _baked_repr_to_text(
    text: str, *, digest_chars: int = LEGACY_DISPLAY_DIGEST_CHARS
) -> str | None:
    """Render one exact baked-repr string, or None if it is not one."""
    if not _BAKED_REPR_RE.match(text):
        return None
    parsed = _parse_baked_repr(text)
    if parsed is None:
        return None
    return _legacy_confined_mapping_to_text(parsed, digest_chars=digest_chars)


def legacy_confined_to_text(
    value: Any, *, digest_chars: int = LEGACY_DISPLAY_DIGEST_CHARS
) -> str | None:
    """Canonical operator string for the legacy confinement envelope.

    Accepts the live mapping or an exact baked-repr string, in either key order.
    Returns None for every other value, including a mapping with an extra or
    missing key, a non-hex or short digest, and a non-integer length.
    """
    rendered = _legacy_confined_mapping_to_text(value, digest_chars=digest_chars)
    if rendered is not None:
        return rendered
    if isinstance(value, str):
        return _baked_repr_to_text(value, digest_chars=digest_chars)
    return None


def _render_embedded_baked_reprs(
    text: str, *, digest_chars: int = LEGACY_DISPLAY_DIGEST_CHARS
) -> str:
    """Replace every embedded envelope repr with its canonical string.

    Surrounding operator text is preserved, so a persisted
    "ESCALATED still open: {...}" row renders readably instead of leaking a repr.
    """

    def replace(match: re.Match[str]) -> str:
        rendered = _baked_repr_to_text(match.group(0), digest_chars=digest_chars)
        return rendered if rendered is not None else match.group(0)

    return _BAKED_REPR_SCAN_RE.sub(replace, text)


def alert_text(value: Any, *, digest_chars: int = LEGACY_DISPLAY_DIGEST_CHARS) -> str:
    """The single funnel every alert-content read passes through.

    A string renders as itself, with any embedded envelope repr replaced by its
    canonical form. The live envelope mapping renders canonically. Anything else
    -- an arbitrary mapping, a list, a number -- renders as the fixed sentinel and
    is never printed, so an unexpected shape cannot leak through the boundary.
    """
    if value is None:
        return ""
    rendered = legacy_confined_to_text(value, digest_chars=digest_chars)
    if rendered is not None:
        return rendered
    if isinstance(value, str):
        return _render_embedded_baked_reprs(value, digest_chars=digest_chars)
    return UNRENDERABLE_ALERT_CONTENT


def alert_text_for_fingerprint(value: Any) -> str:
    """Render for IDENTITY, not for display: the full 64-hex digest.

    storm_fingerprint, recovery_episode_fingerprint and recovery_duplicate_
    fingerprint group incidents by this text. Feeding them the display rendering
    put identity on the 8-character prefix, so two incidents sharing a prefix
    merged into one -- a regression against the pre-confinement behaviour, where
    the summary carried the whole digest. Everything else about the rendering is
    identical, so grouping is unchanged apart from the restored entropy.
    """
    return alert_text(value, digest_chars=LEGACY_FULL_DIGEST_CHARS)


def alert_text_kind(value: Any) -> str:
    """Telemetry label for one alert-content value.

    One of "string", "legacy_object", "baked_repr", "unrenderable". Callers count
    these per event; an event can carry more than one kind across its fields, so
    the counters are never summed.
    """
    if value is None:
        return "string"
    if _legacy_confined_mapping_to_text(value) is not None:
        return "legacy_object"
    if isinstance(value, str):
        if _BAKED_REPR_SCAN_RE.search(value) and _render_embedded_baked_reprs(value) != value:
            return "baked_repr"
        return "string"
    return "unrenderable"
