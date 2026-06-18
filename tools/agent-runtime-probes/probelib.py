#!/usr/bin/env python3
"""probelib — shared, single-home helpers for the agent-runtime probe suite.

Exists to kill copy-paste of the security-critical redactor (previously duplicated and
diverging across runtime_doctor.py and opencode_topology_export.py) and to give the suite
one fail-closed `redact()`.

KEY FIX vs the old per-probe copies: the old redactor matched the KEY NAME only, so a
secret scalar living under a generic key (e.g. a token string inside a `command`/`args`
list) leaked. This version is content-aware: it redacts when the KEY name is sensitive OR
the VALUE matches a known secret shape, and it re-inspects every list element's value.
"""
from __future__ import annotations

import json
import hashlib
import re
import shutil
import subprocess
import tomllib
from pathlib import Path
from typing import Any

SENSITIVE_PARTS = (
    "token", "secret", "key", "password", "credential", "auth",
    "cookie", "header", "client_id", "tenant_id", "url",
)
SAFE_KEY_SUFFIXES = (
    "_keys",
    "_key_names",
    "_count",
    "_counts",
    "_limit",
    "_limits",
    "_tokens",
)
SAFE_KEY_NAMES = {
    "keys",
    "settings_keys",
    "config_keys",
    "mcp_keys",
    "environment_keys",
    "first_token_family",
    "tokens_sha256_16",
    "has_secret_word",
    "has_url",
    "autocompactinputtokens",
    "session_key_status",  # CAPE masker: a non-secret status string (ok|invalid|not_evaluated)
}

# Secret VALUE shapes — matched regardless of key name (defense against the fail-open hole).
# Un-anchored for recall (catch secrets abutting an alphanumeric char, e.g. xsk-..., data1AKIA...).
# The sk- alternative additionally requires a digit OR uppercase via (?=[A-Za-z0-9]*[0-9A-Z]) so it
# skips lowercase English words like "ri{sk-c}lassification"/"ta{sk-c}ompletion" while still catching
# real keys (mixed-case/digit base62 — e.g. sk-ABCDEFGHIJKLMNOPQRST or sk-abcd1234...). A "has a digit"
# test alone missed all-uppercase keys. The other prefixes (pcsk_/gh*/AKIA/xox*/AIza/eyJ) are
# distinctive enough not to collide with prose. Precision on benign keys is handled by the key-name
# allowlist, never by narrowing this value regex. Kept byte-identical with the live estate copy.
SECRET_VALUE = re.compile(
    r"sk-(?=[A-Za-z0-9]*[0-9A-Z])[A-Za-z0-9]{8,}"  # OpenAI-style (digit-or-uppercase: skip lowercase words)
    r"|pcsk_[A-Za-z0-9_]{8,}"                   # Pinecone
    r"|gh[pousr]_[A-Za-z0-9]{20,}"              # GitHub PAT/OAuth
    r"|AKIA[0-9A-Z]{12,}"                       # AWS access key id
    r"|xox[baprs]-[A-Za-z0-9-]{10,}"            # Slack
    r"|AIza[0-9A-Za-z_\-]{30,}"                 # Google API key
    r"|eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]+"  # JWT
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----"      # PEM
    r"|\b[Bb]earer\s+[A-Za-z0-9._\-]{12,}"      # bearer token
    r"|[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"           # email
)


def _is_safe_key(lowered: str) -> bool:
    return lowered in SAFE_KEY_NAMES or lowered.endswith(SAFE_KEY_SUFFIXES)


def redact(value: Any, key: str = "") -> Any:
    """Fail-closed redaction. Redact when the key name is sensitive OR the value looks
    like a secret. Structure (dict/list containers, key names) is preserved."""
    # A bool is categorically never a credential, and the value-shape scan only inspects
    # strings, so preserving it weakens nothing. Guard before the key-name check so a falsy
    # attestation/telemetry flag under a sensitive-named key is not clobbered into the truthy
    # string "<redacted>" (M1c boolean-clobber fix). Note: isinstance(True, int) is True, so
    # this must precede any int handling; non-bool ints still fall through to fail-closed redaction.
    if isinstance(value, bool):
        return value
    lowered = key.lower()
    if any(part in lowered for part in SENSITIVE_PARTS) and not _is_safe_key(lowered):
        return value if value in (None, "", [], {}) else "<redacted>"
    if isinstance(value, dict):
        return {k: redact(v, k) for k, v in value.items()}
    if isinstance(value, list):
        # re-inspect each element's VALUE (do not blindly inherit the parent key)
        return [redact(v, key if isinstance(v, (dict, list)) else "") for v in value]
    if isinstance(value, str) and SECRET_VALUE.search(value):
        return "<redacted:value>"
    return value


def run(argv: list[str], timeout: int = 20) -> dict[str, Any]:
    try:
        proc = subprocess.run(argv, text=True, capture_output=True, timeout=timeout, check=False)
        return {"cmd": argv, "rc": proc.returncode,
                "stdout": proc.stdout.strip(), "stderr": proc.stderr.strip()}
    except FileNotFoundError:
        return {"cmd": argv, "rc": 127, "stdout": "", "stderr": "not found"}
    except subprocess.TimeoutExpired:
        return {"cmd": argv, "rc": 124, "stdout": "", "stderr": "timeout"}


def git_head(repo: Path) -> str | None:
    out = run(["git", "-C", str(repo), "log", "-1", "--format=%h %s"], timeout=5)
    if out["rc"] != 0:
        return None
    return str(out["stdout"]).strip() or None


def sha256_16(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()[:16]


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception as exc:  # diagnostic script: fail-closed to an error marker
        return {"_error": f"{type(exc).__name__}: {exc}"}


def load_toml(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        with path.open("rb") as handle:
            return tomllib.load(handle)
    except Exception as exc:
        return {"_error": f"{type(exc).__name__}: {exc}"}


def du(path: Path) -> str | None:
    if not path.exists():
        return None
    out = run(["du", "-sh", str(path)], timeout=10)
    return out["stdout"].split("\t", 1)[0] if out["rc"] == 0 else None


def sqlite_counts(path: Path, tables: list[str]) -> dict[str, Any] | None:
    if not path.exists() or shutil.which("sqlite3") is None:
        return None
    result: dict[str, Any] = {}
    for table in tables:
        out = run(["sqlite3", str(path), f"select count(*) from {table};"], timeout=10)
        result[table] = int(out["stdout"]) if out["rc"] == 0 and out["stdout"].isdigit() else None
    return result
