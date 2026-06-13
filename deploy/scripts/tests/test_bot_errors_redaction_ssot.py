"""Structural guard for the BOT ERRORS deploy redaction SSOT."""
from __future__ import annotations

import re
from pathlib import Path

_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
_SSOT_PATH = _SCRIPT_ROOT / "lib" / "bot_errors_redaction.py"
_PROHIBITED_RE = re.compile(
    r"^(?:"
    r"AUTHORIZATION_(?:BEARER|SECRET)|"
    r"BEARER_(?:VALUE|SECRET)|"
    r"KEYED_SECRET|SECRETISH_ASSIGNMENT|SECRET_ASSIGNMENT|"
    r"CREDENTIAL_PATH|WHATSAPP_JID|AWS_ACCESS_KEY_ID|GITHUB_TOKEN|JWT_VALUE|"
    r"PEM_PRIVATE_KEY|URL_USERINFO|KEYED_PHONE(?:_LIKE)?|CONTEXT_PHONE(?:_LIKE)?|PHONE_LIKE"
    r")_?(?:RE)?\s*=\s*re\.compile",
)


def test_deploy_redaction_regexes_live_only_in_shared_module():
    offenders: list[str] = []
    for path in sorted(_SCRIPT_ROOT.glob("bot-errors-*.py")):
        if path == _SSOT_PATH:
            continue
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if _PROHIBITED_RE.search(line):
                offenders.append(f"{path.relative_to(_SCRIPT_ROOT)}:{lineno}:{line.strip()}")

    assert offenders == []


def test_shared_redaction_module_is_manifest_trackable():
    text = _SSOT_PATH.read_text(encoding="utf-8")
    assert "def redact_bot_errors_text" in text
    assert "CREDENTIAL_PATH_RE" in text
    assert ".config/secrets/" in text
