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
    r"([\"']?(?:(?:[A-Za-z0-9_.-]{0,20}api[_-]?key[A-Za-z0-9_.-]{0,20})|client[_-]?secret|access[_-]?token|"
    r"refresh[_-]?token|auth[_-]?token|cookie|password|passphrase|secret|session|token|"
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
URL_USERINFO_RE = re.compile(r"\b([a-z][a-z0-9+.-]*://)[^\s/@:]+:[^\s/@]+@", re.IGNORECASE)


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
