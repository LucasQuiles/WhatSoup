# Python Deploy Redaction SSOT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace divergent BOT ERRORS Python deploy-script redaction regex copies with one manifest-tracked redaction module and proof that every deploy consumer redacts the same secret fixtures.

**Architecture:** Add a small `deploy/scripts/lib/` package that is shipped and verified with the BOT ERRORS runtime manifest. Migrate every Python deploy redactor to call the shared module through compatibility wrapper names so existing call sites and manifest markers remain stable. Keep the TypeScript source-hygiene secret scan separate for this slice because it scans source diffs, while the Python module redacts runtime diagnostic text.

**Tech Stack:** Python 3 standard library, pytest, existing BOT ERRORS runtime manifest validation, existing TypeScript health-check manifest tests.

**Status:** completed - landed via PR #830 (`97e60757`). This plan is retained as the Python deploy redaction SSOT design/proof record.

---

## Decision Record

**Decision needed:** choose the canonical source for BOT ERRORS Python deploy-script redaction patterns.

**Recommended option:** ship a manifest-tracked Python module at `deploy/scripts/lib/bot_errors_redaction.py` and require every BOT ERRORS Python deploy script to call it through the existing script-level wrapper names.

**Why this option:** the current drift is behavior, not only data. The redactors use Python `re.Pattern` flags, replacement functions, phone/JID context handling, and different credential-path marker strings. A JSON-only `deploy/secret-patterns.json` would centralize pattern text but still leave replacement semantics and ordering duplicated in every script. A Python module centralizes both matching and replacement while staying testable with the existing deploy pytest suite and runtime-manifest hash guard.

**Rejected for this slice:** a standalone `deploy/secret-patterns.json` as the only source of truth. It can become a later vocabulary export if TypeScript source-diff hygiene and Python runtime redaction need a shared inventory, but it is too weak as the first runtime SSOT because it cannot express the full redaction pipeline.

**Fallback if shared imports fail on real hosts:** revert the shared-module migration and replace it with an explicit N-copy equivalence guard that imports each standalone script and proves identical redaction outputs across a fixed fixture matrix. Do not keep an unguarded N-copy pattern set.

**TypeScript vocabulary decision:** keep `scripts/repo-hygiene-guard.ts` separate in this slice. It scans source diffs for committed secrets; the Python module redacts runtime diagnostic text before writing alerts, breadcrumbs, and state. The two surfaces may share fixture vocabulary later, but forcing one implementation now would mix two different threat models.

**Approval boundary:** implementation is approved only after an owner accepts a manifest-tracked `deploy/scripts/lib/` import shape for the deployed BOT ERRORS scripts. Without that approval, execute only the parity-test expansion and/or the N-copy equivalence guard.

## Current Evidence

- `deploy/scripts/bot-errors-health-check.py` has a `CREDENTIAL_PATH_RE` clone that omits the `.config/secrets/` branch covered by collector, heartbeat-watchdog, runner, emit, and q-loop variants.
- `deploy/scripts/tests/test_bot_errors_redaction_regex.py` does not load `bot-errors-health-check.py`, so the health-check gap is not enforced by the current Python parity test.
- `deploy/scripts/tests/test_bot_errors_redaction_regex.py` also omits `bot-errors-dispatcher.py`, so dispatcher can drift from the deploy-script redaction contract without this Python parity test catching it.
- The deploy scripts are manifest-managed by `deploy/bot-errors-runtime-manifest.json`; `tests/scripts/bot-errors-health-check.test.ts` validates the committed manifest hashes and `mustContain` markers.
- `origin/main` includes `deploy/scripts/lib/bot_errors_redaction.py` plus manifest coverage as of `97e60757`.
- Recent hardening already closed the emit atomic-write parent preflight, private-dir `bot-errors-q-loop.py` exception alignment, `guard-core.readText`, and console `asRecordOrEmpty`; this plan is only for D5/R8 redaction SSOT and the Python deploy import/manifest strategy.

## Local Compose Outcome

- Shared module: `deploy/scripts/lib/bot_errors_redaction.py`.
- Manifest coverage: `deploy/bot-errors-runtime-manifest.json` and `scripts/check-bot-errors-runtime-manifest.ts` include the shared helper files.
- Consumers migrated: collector, dispatcher, emit, health-check, heartbeat-watchdog, q-loop, and runner.
- Tests added: `deploy/scripts/tests/test_bot_errors_redaction_regex.py` covers all consumers and `.config/secrets/` paths; `deploy/scripts/tests/test_bot_errors_redaction_ssot.py` rejects local regex-clone reintroduction.
- Boundary preserved: TypeScript `scripts/repo-hygiene-guard.ts` remains a source-diff hygiene scanner with a distinct threat model.

## Implementation Reconciliation

The task snippets below were the red-first implementation plan. PR #830 implemented the slice with a slightly narrower public helper API than the initial draft:

- Authoritative helper API: `deploy/scripts/lib/bot_errors_redaction.py` exports `redact_bot_errors_text(value, *, credential_path_marker, ...)` and `redact_json_value(value, redact_text)`.
- Script wrappers remain the compatibility boundary: collector, dispatcher, emit, health-check, heartbeat-watchdog, q-loop, and runner expose their existing wrapper names and pass each script's historical credential-path marker to the shared helper.
- Do not paste the older Task 2/Task 3 snippets over the current branch. In particular, the draft helper name `redact_text` was superseded by `redact_bot_errors_text`, and JSON redaction now accepts the caller's wrapper function to preserve per-script marker semantics.
- Current proof from the landed compose: `python3.12 -m pytest deploy/scripts/tests/test_bot_errors_redaction_regex.py deploy/scripts/tests/test_bot_errors_redaction_ssot.py -q` passed 86 tests, and `npm test -- --pool=forks tests/scripts/check-bot-errors-runtime-manifest.test.ts tests/scripts/bot-errors-health-check.test.ts` passed 117 tests.

## File Structure

- Create: `deploy/scripts/lib/__init__.py`
  - Makes `deploy/scripts/lib` an explicit import package for repo-root and deploy-root execution.
- Create: `deploy/scripts/lib/bot_errors_redaction.py`
  - Owns canonical secret, credential-path, token, userinfo, PEM, JWT, AWS, GitHub, phone, and WhatsApp-JID redaction logic.
- Modify: `deploy/scripts/bot-errors-collector.py`
  - Replace local redaction regex definitions with wrappers around the shared module.
- Modify: `deploy/scripts/bot-errors-dispatcher.py`
  - Replace local redaction regex definitions with wrappers around the shared module.
- Modify: `deploy/scripts/bot-errors-emit.py`
  - Replace local redaction regex definitions with wrappers around the shared module.
- Modify: `deploy/scripts/bot-errors-health-check.py`
  - Replace local redaction regex definitions with wrappers around the shared module and close the `.config/secrets/` false negative.
- Modify: `deploy/scripts/bot-errors-heartbeat-watchdog.py`
  - Replace local redaction regex definitions with wrappers around the shared module.
- Modify: `deploy/scripts/bot-errors-q-loop.py`
  - Replace local redaction regex definitions with wrappers around the shared module.
- Modify: `deploy/scripts/bot-errors-runner.py`
  - Replace local redaction regex definitions with wrappers around the shared module.
- Modify: `deploy/scripts/tests/test_bot_errors_redaction_regex.py`
  - Enforce parity across all Python deploy-script redactors, including health-check and dispatcher.
- Add: `deploy/scripts/tests/test_bot_errors_redaction_ssot.py`
  - Enforce that local redaction regex clones do not reappear outside the shared module.
- Modify: `deploy/bot-errors-runtime-manifest.json`
  - Track the shared module and update script hashes after migration.
- Modify: `tests/scripts/bot-errors-health-check.test.ts`
  - Extend manifest validation expectations if needed for the shared module marker.

## Compatibility Contract

- Keep existing script-level function names:
  - `redact_collector_text`
  - `redact_watchdog_text`
  - `redact_event_text`
  - `redact_text`
  - `redact`
- Preserve existing marker strings accepted by tests:
  - `[REDACTED_CREDENTIAL_PATH]`
  - `[REDACTED CREDENTIAL PATH]`
  - `[REDACTED]`
  - `Authorization: Bearer [REDACTED]`
- Do not create a JSON-only pattern file in this slice; Python `re.Pattern` flags, replacement functions, and phone/JID context logic make the shared module a safer first canonical source.
- Do not merge the TypeScript `repo-hygiene-guard` secret vocabulary into this Python module in this slice; document that TS scans source diffs and Python redacts runtime diagnostic strings.

## Task 1: Add Red-First Parity Coverage

**Files:**
- Modify: `deploy/scripts/tests/test_bot_errors_redaction_regex.py`

- [ ] **Step 1: Add health-check and dispatcher to the redactor matrix**

Replace the `_REDACTORS` list with this exact matrix:

```python
_REDACTORS: list[tuple[str, str, str]] = [
    ("bot-errors-collector.py", "redact_collector_text", "[REDACTED_CREDENTIAL_PATH]"),
    ("bot-errors-dispatcher.py", "redact", "[REDACTED CREDENTIAL PATH]"),
    ("bot-errors-emit.py", "redact", "[REDACTED CREDENTIAL PATH]"),
    ("bot-errors-health-check.py", "redact_event_text", "[REDACTED_CREDENTIAL_PATH]"),
    ("bot-errors-heartbeat-watchdog.py", "redact_watchdog_text", "[REDACTED_CREDENTIAL_PATH]"),
    ("bot-errors-q-loop.py", "redact_text", "[REDACTED CREDENTIAL PATH]"),
    ("bot-errors-runner.py", "redact", "[REDACTED CREDENTIAL PATH]"),
]
```

- [ ] **Step 2: Add explicit `.config/secrets/` coverage**

Append this test below `test_deep_home_credential_paths_still_redact`:

```python
@pytest.mark.parametrize(("script_name", "func_name", "marker"), _REDACTORS)
def test_config_secrets_paths_still_redact(script_name: str, func_name: str, marker: str):
    mod = _load_module(script_name)
    redact: Callable[[str], str] = getattr(mod, func_name)

    text = "source=/srv/operator/.config/secrets/provider.env token=visible"
    redacted = redact(text)

    assert marker in redacted
    assert ".config/secrets" not in redacted
    assert "provider.env" not in redacted
```

- [ ] **Step 3: Add cross-consumer secret fixtures**

Append this fixture test:

```python
@pytest.mark.parametrize(("script_name", "func_name", "_marker"), _REDACTORS)
@pytest.mark.parametrize(
    "raw",
    [
        "Authorization: Bearer " + "sk-" + "live-" + "a" * 26,
        "token='" + "sk-" + "live-" + "b" * 26 + "'",
        "github=" + "ghp_" + "c" * 26,
        "aws=" + "AKIA" + "1" * 16,
        "jwt=" + "eyJ" + "a" * 12 + "." + "eyJ" + "b" * 12 + "." + "c" * 16,
        "url=https://user:password" + "@" + "host.invalid/path",
        "key=-----BEGIN " + "PRIVATE KEY-----\\nabc\\n-----END " + "PRIVATE KEY-----",
        "jid=" + "14155551234" + "@" + "s.whatsapp.net",
    ],
)
def test_common_secret_fixtures_redact_across_consumers(script_name: str, func_name: str, _marker: str, raw: str):
    mod = _load_module(script_name)
    redact: Callable[[str], str] = getattr(mod, func_name)

    redacted = redact(raw)

    assert "sk-live" not in redacted
    assert "ghp_" not in redacted
    assert "AKIA1234567890ABCDEF" not in redacted
    assert "eyJabcdefghijk" not in redacted
    assert "user:password@" not in redacted
    assert "BEGIN " + "PRIVATE KEY" not in redacted
    assert "14155551234" not in redacted
```

- [ ] **Step 4: Run the red-first test**

Run:

```bash
python3 -m pytest deploy/scripts/tests/test_bot_errors_redaction_regex.py -q
```

Expected: fails on `bot-errors-health-check.py` for the `.config/secrets/` credential path before the shared module exists.

## Task 2: Add The Shared Redaction Module

**Files:**
- Create: `deploy/scripts/lib/__init__.py`
- Create: `deploy/scripts/lib/bot_errors_redaction.py`

- [ ] **Step 1: Create the package marker**

Create `deploy/scripts/lib/__init__.py` with:

```python
"""Shared helpers for manifest-tracked BOT ERRORS deploy scripts."""
```

- [ ] **Step 2: Create the canonical redaction module**

Create `deploy/scripts/lib/bot_errors_redaction.py` with:

```python
from __future__ import annotations

import re
from typing import Any

REDACTED = "[REDACTED]"
REDACTED_CREDENTIAL_PATH = "[REDACTED_CREDENTIAL_PATH]"
REDACTED_CREDENTIAL_PATH_SPACED = "[REDACTED CREDENTIAL PATH]"

AUTHORIZATION_BEARER_RE = re.compile(r"\b(authorization\s*[:=]\s*bearer\s+)[^\s\"',;}]+", re.I)
BEARER_VALUE_RE = re.compile(r"\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}", re.I)
KEYED_SECRET_RE = re.compile(
    r"\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_]*)(\s*[:=]\s*)(['\"]?)([^'\"\s,;}]+)(['\"]?)",
    re.I,
)
SECRETISH_ASSIGNMENT_RE = re.compile(
    r"\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY)[A-Z0-9_]*)(\s*[:=]\s*)(['\"]?)[^'\"\s,;}]+(['\"]?)",
    re.I,
)
CREDENTIAL_PATH_RE = re.compile(
    r"(?:~|/Users/[^/\s]+|/home/[^/\s]+|/var/root|/srv/[^/\s]+)"
    r"/(?:"
    r"\.config/secrets/[^\\s'\"`<>|]+"
    r"|\.config/whatsoup/[^\\s'\"`<>|]+"
    r"|\.local/share/whatsoup/instances/[^\\s'\"`<>|]+/auth/[^\\s'\"`<>|]+"
    r"|auth-bond-backups/[^\\s'\"`<>|]+"
    r"|[^\\s'\"`<>|]*(?:token|secret|credential|private-key|api-key|\.env)[^\\s'\"`<>|]*"
    r")",
    re.I,
)
AWS_ACCESS_KEY_ID_RE = re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")
GITHUB_TOKEN_RE = re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b")
JWT_VALUE_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")
PEM_PRIVATE_KEY_RE = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----", re.S)
URL_USERINFO_RE = re.compile(r"\b([a-z][a-z0-9+.-]*://)[^\s/@:]+:[^\s/@]+@", re.I)
WHATSAPP_JID_RE = re.compile(r"\b(\d{7,15})@(?:s\.whatsapp\.net|c\.us)\b")
PHONE_RE = re.compile(r"(?<!\d)(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})(?!\d)")


def _redact_assignment(match: re.Match[str]) -> str:
    if len(match.groups()) == 5:
        return f"{match.group(1)}{match.group(2)}{match.group(3)}{REDACTED}{match.group(5)}"
    return f"{match.group(1)}{match.group(2)}{match.group(3)}{REDACTED}"


def _redact_phone(match: re.Match[str]) -> str:
    return "[REDACTED_PHONE]"


def redact_text(value: Any, *, credential_path_marker: str = REDACTED_CREDENTIAL_PATH_SPACED) -> str:
    text = str(value)
    text = PEM_PRIVATE_KEY_RE.sub("[REDACTED PEM PRIVATE KEY]", text)
    text = CREDENTIAL_PATH_RE.sub(credential_path_marker, text)
    text = URL_USERINFO_RE.sub(r"\1[REDACTED]@", text)
    text = AWS_ACCESS_KEY_ID_RE.sub("[REDACTED AWS ACCESS KEY]", text)
    text = GITHUB_TOKEN_RE.sub("[REDACTED GITHUB TOKEN]", text)
    text = JWT_VALUE_RE.sub("[REDACTED JWT]", text)
    text = AUTHORIZATION_BEARER_RE.sub(r"\1" + REDACTED, text)
    text = BEARER_VALUE_RE.sub(r"\1" + REDACTED, text)
    text = KEYED_SECRET_RE.sub(_redact_assignment, text)
    text = SECRETISH_ASSIGNMENT_RE.sub(_redact_assignment, text)
    text = WHATSAPP_JID_RE.sub("[REDACTED_JID]", text)
    return PHONE_RE.sub(_redact_phone, text)


def redact_json_value(value: Any, *, credential_path_marker: str = REDACTED_CREDENTIAL_PATH_SPACED) -> Any:
    if isinstance(value, str):
        return redact_text(value, credential_path_marker=credential_path_marker)
    if isinstance(value, list):
        return [redact_json_value(item, credential_path_marker=credential_path_marker) for item in value]
    if isinstance(value, dict):
        return {
            str(key): redact_json_value(item, credential_path_marker=credential_path_marker)
            for key, item in value.items()
        }
    return value
```

- [ ] **Step 3: Run the redaction tests**

Run:

```bash
python3 -m pytest deploy/scripts/tests/test_bot_errors_redaction_regex.py -q
```

Expected: still fails because the scripts have not imported the shared module yet.

## Task 3: Migrate Script Wrappers Without Renaming Public Functions

**Files:**
- Modify: `deploy/scripts/bot-errors-collector.py`
- Modify: `deploy/scripts/bot-errors-dispatcher.py`
- Modify: `deploy/scripts/bot-errors-emit.py`
- Modify: `deploy/scripts/bot-errors-health-check.py`
- Modify: `deploy/scripts/bot-errors-heartbeat-watchdog.py`
- Modify: `deploy/scripts/bot-errors-q-loop.py`
- Modify: `deploy/scripts/bot-errors-runner.py`

- [ ] **Step 1: Add a shared import helper to each script**

Add this import block near each script's existing imports:

```python
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from lib.bot_errors_redaction import (
    REDACTED_CREDENTIAL_PATH,
    REDACTED_CREDENTIAL_PATH_SPACED,
    redact_json_value as shared_redact_json_value,
    redact_text as shared_redact_text,
)
```

Use the existing `Path` and `sys` imports. If a script defines `SCRIPT_DIR` already, reuse the existing name instead of adding a second one.

- [ ] **Step 2: Replace local redaction regex blocks**

Delete local declarations for these names from each migrated script when present:

```python
AUTHORIZATION_BEARER_RE
AUTHORIZATION_SECRET_RE
BEARER_SECRET_RE
BEARER_VALUE_RE
KEYED_SECRET_RE
SECRET_ASSIGNMENT_RE
SECRETISH_ASSIGNMENT
CREDENTIAL_PATH_RE
CREDENTIAL_PATH
AWS_ACCESS_KEY_ID_RE
AWS_ACCESS_KEY_ID
GITHUB_TOKEN_RE
GITHUB_TOKEN
JWT_VALUE_RE
JWT_VALUE
PEM_PRIVATE_KEY_RE
PEM_PRIVATE_KEY
URL_USERINFO_RE
URL_USERINFO
```

- [ ] **Step 3: Preserve collector compatibility wrapper**

Replace `redact_collector_text` with:

```python
def redact_collector_text(value: Any) -> str:
    return shared_redact_text(value, credential_path_marker=REDACTED_CREDENTIAL_PATH)
```

Replace `redacted_collector_payload` with:

```python
def redacted_collector_payload(value: Any) -> Any:
    return shared_redact_json_value(value, credential_path_marker=REDACTED_CREDENTIAL_PATH)
```

- [ ] **Step 4: Preserve heartbeat-watchdog compatibility wrapper**

Replace `redact_watchdog_text` with:

```python
def redact_watchdog_text(value: Any) -> str:
    return shared_redact_text(value, credential_path_marker=REDACTED_CREDENTIAL_PATH)
```

Replace `redacted_watchdog_payload` with:

```python
def redacted_watchdog_payload(value: Any) -> Any:
    return shared_redact_json_value(value, credential_path_marker=REDACTED_CREDENTIAL_PATH)
```

- [ ] **Step 5: Preserve health-check compatibility wrapper**

Replace `redact_event_text` and `redact_json_value` with:

```python
def redact_event_text(value: str) -> str:
    return shared_redact_text(value, credential_path_marker=REDACTED_CREDENTIAL_PATH)


def redact_json_value(value: Any) -> Any:
    return shared_redact_json_value(value, credential_path_marker=REDACTED_CREDENTIAL_PATH)
```

Keep `redact_evidence_string` as a local truncation wrapper:

```python
def redact_evidence_string(value: str, max_len: int = 160) -> str:
    redacted = redact_event_text(value.strip())
    return redacted[:max_len]
```

- [ ] **Step 6: Preserve emit, runner, q-loop, and dispatcher wrappers**

Use the spaced credential marker for scripts that already emitted `[REDACTED CREDENTIAL PATH]`:

```python
def redact(value: Any) -> str:
    return shared_redact_text(value, credential_path_marker=REDACTED_CREDENTIAL_PATH_SPACED)


def redact_json_value(value: Any) -> Any:
    return shared_redact_json_value(value, credential_path_marker=REDACTED_CREDENTIAL_PATH_SPACED)
```

For q-loop, keep the function name:

```python
def redact_text(value: str) -> str:
    return shared_redact_text(value, credential_path_marker=REDACTED_CREDENTIAL_PATH_SPACED)
```

- [ ] **Step 7: Run focused Python redaction tests**

Run:

```bash
python3 -m pytest deploy/scripts/tests/test_bot_errors_redaction_regex.py -q
```

Expected: all tests pass.

## Task 4: Add An SSOT Drift Guard Test

**Files:**
- Add: `deploy/scripts/tests/test_bot_errors_redaction_ssot.py`

- [ ] **Step 1: Add the clone-ban test**

Create `deploy/scripts/tests/test_bot_errors_redaction_ssot.py` with:

```python
from __future__ import annotations

from pathlib import Path

SCRIPT_ROOT = Path(__file__).resolve().parents[1]
SHARED = SCRIPT_ROOT / "lib" / "bot_errors_redaction.py"

LOCAL_REGEX_NAMES = (
    "AUTHORIZATION_BEARER_RE",
    "AUTHORIZATION_SECRET_RE",
    "BEARER_SECRET_RE",
    "BEARER_VALUE_RE",
    "KEYED_SECRET_RE",
    "SECRET_ASSIGNMENT_RE",
    "SECRETISH_ASSIGNMENT",
    "CREDENTIAL_PATH_RE",
    "CREDENTIAL_PATH = re.compile",
    "AWS_ACCESS_KEY_ID_RE",
    "AWS_ACCESS_KEY_ID = re.compile",
    "GITHUB_TOKEN_RE",
    "GITHUB_TOKEN = re.compile",
    "JWT_VALUE_RE",
    "JWT_VALUE = re.compile",
    "PEM_PRIVATE_KEY_RE",
    "PEM_PRIVATE_KEY = re.compile",
    "URL_USERINFO_RE",
    "URL_USERINFO = re.compile",
)


def test_python_deploy_redaction_regexes_live_only_in_shared_module():
    offenders: list[str] = []
    for path in SCRIPT_ROOT.glob("bot-errors-*.py"):
        if path == SHARED:
            continue
        text = path.read_text(encoding="utf-8")
        for name in LOCAL_REGEX_NAMES:
            if name in text:
                offenders.append(f"{path.name}: {name}")

    assert offenders == []
```

- [ ] **Step 2: Run the SSOT test**

Run:

```bash
python3 -m pytest deploy/scripts/tests/test_bot_errors_redaction_ssot.py -q
```

Expected: pass after Task 3 migration.

## Task 5: Manifest And Deploy-Shape Verification

**Files:**
- Modify: `deploy/bot-errors-runtime-manifest.json`
- Modify: `tests/scripts/bot-errors-health-check.test.ts`

- [ ] **Step 1: Add the shared module and regenerate script hashes**

Run this manifest updater after the final Python script edits:

```bash
python3 - <<'PY'
from __future__ import annotations

import hashlib
import json
from pathlib import Path

manifest_path = Path("deploy/bot-errors-runtime-manifest.json")
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

managed_paths = {
    "deploy/scripts/bot-errors-collector.py",
    "deploy/scripts/bot-errors-dispatcher.py",
    "deploy/scripts/bot-errors-emit.py",
    "deploy/scripts/bot-errors-health-check.py",
    "deploy/scripts/bot-errors-heartbeat-watchdog.py",
    "deploy/scripts/bot-errors-q-loop.py",
    "deploy/scripts/bot-errors-runner.py",
    "deploy/scripts/lib/bot_errors_redaction.py",
}

shared_entry = {
    "path": "deploy/scripts/lib/bot_errors_redaction.py",
    "sha256": "",
    "mustContain": [
        "def redact_text",
        "def redact_json_value",
        ".config/secrets",
        "Authorization: Bearer [REDACTED]",
    ],
}

entries = manifest["files"]
if not any(entry["path"] == shared_entry["path"] for entry in entries):
    insert_after = next(
        index for index, entry in enumerate(entries)
        if entry["path"] == "deploy/scripts/bot-errors-health-check.py"
    )
    entries.insert(insert_after + 1, shared_entry)

for entry in entries:
    path = entry["path"]
    if path in managed_paths:
        body = Path(path).read_bytes()
        entry["sha256"] = hashlib.sha256(body).hexdigest()

manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY
```

Expected: the manifest contains one entry for `deploy/scripts/lib/bot_errors_redaction.py`, and every changed script entry has a fresh 64-character lowercase sha256.

- [ ] **Step 3: Keep compatibility markers in the manifest**

Do not remove these existing marker names from script entries unless the script no longer exposes the compatibility wrapper:

```json
"redact_collector_text"
"redact_watchdog_text"
"AUTHORIZATION_SECRET_RE"
```

If a marker refers to a deleted local regex, replace it with a wrapper or shared-module marker that proves the same deployed capability. For health-check, use:

```json
"redact_event_text"
"lib.bot_errors_redaction"
```

- [ ] **Step 4: Run manifest tests**

Run:

```bash
npm test -- --pool=forks --fileParallelism=false tests/scripts/bot-errors-health-check.test.ts
```

Expected: pass, including the checked-in runtime manifest alignment test.

## Task 6: Verification Ladder

**Files:**
- No additional edits.

- [ ] **Step 1: Run all deploy Python tests**

Run:

```bash
python3 -m pytest deploy/scripts/tests/ -q
```

Expected: all deploy Python tests pass.

- [ ] **Step 2: Run targeted TypeScript tests**

Run:

```bash
npm test -- --pool=forks --fileParallelism=false tests/scripts/bot-errors-health-check.test.ts tests/scripts/bot-errors-dispatcher.test.ts tests/scripts/bot-errors-collector.test.ts tests/scripts/bot-errors-runner.test.ts
```

Expected: all targeted TypeScript tests pass.

- [ ] **Step 3: Run Test Integrity on changed tests**

Run:

```bash
"$HOME/.claude/plugins/test-integrity/scripts/test-integrity" scan --ci deploy/scripts/tests/test_bot_errors_redaction_regex.py deploy/scripts/tests/test_bot_errors_redaction_ssot.py tests/scripts/bot-errors-health-check.test.ts
```

Expected: no suspicious or low-integrity findings.

- [ ] **Step 4: Run repository push verification**

Run:

```bash
npm run verify:push:branch
```

Expected: exit 0. Treat any masked or piped test output as inconclusive unless the true command exit is captured.

## Task 7: Commit, PR, And Post-Merge Requirements

**Files:**
- Modify generated docs only if work-index or publication guards require them.

- [ ] **Step 1: Inspect the final diff**

Run:

```bash
git diff --stat
git diff -- deploy/scripts deploy/bot-errors-runtime-manifest.json tests/scripts deploy/scripts/tests
```

Expected: only redaction SSOT, manifest, and tests are changed.

- [ ] **Step 2: Commit the implementation**

Run:

```bash
git add deploy/scripts deploy/bot-errors-runtime-manifest.json tests/scripts deploy/scripts/tests
git commit -m "fix(bot-errors): centralize deploy redaction patterns"
```

Expected: commit succeeds without trailers.

- [ ] **Step 3: Request approval before push**

Report:

```text
Branch: fix/bot-errors-redaction-ssot
Purpose: centralize Python BOT ERRORS redaction patterns and manifest verification
Risk: deploy-script import path and manifest hash drift
Tests: pytest deploy/scripts/tests, targeted TS tests, Test Integrity, verify:push:branch
Approval needed: push, PR creation, merge
Rollback: revert the single commit; scripts retain compatibility wrappers
```

- [ ] **Step 4: After approval, push and open the PR**

Run only after approval:

```bash
cat > /tmp/whatsoup-bot-errors-redaction-ssot-pr.md <<'PR_BODY'
## Summary
- centralize BOT ERRORS Python deploy redaction patterns in a manifest-tracked shared module
- keep existing script-level redaction wrapper names stable
- add cross-consumer fixture and clone-ban tests for redaction drift

## Verification
- python3 -m pytest deploy/scripts/tests/ -q
- npm test -- --pool=forks --fileParallelism=false tests/scripts/bot-errors-health-check.test.ts tests/scripts/bot-errors-dispatcher.test.ts tests/scripts/bot-errors-collector.test.ts tests/scripts/bot-errors-runner.test.ts
- "$HOME/.claude/plugins/test-integrity/scripts/test-integrity" scan --ci deploy/scripts/tests/test_bot_errors_redaction_regex.py deploy/scripts/tests/test_bot_errors_redaction_ssot.py tests/scripts/bot-errors-health-check.test.ts
- npm run verify:push:branch
PR_BODY

git push -u origin fix/bot-errors-redaction-ssot
gh pr create --title "fix(bot-errors): centralize deploy redaction patterns" --body-file /tmp/whatsoup-bot-errors-redaction-ssot-pr.md
```

Expected: PR opens against `main`; quality checks must be green before merge.

- [ ] **Step 5: After merge approval, verify main**

After merge, run:

```bash
PR_NUMBER="$(gh pr list --repo LucasQuiles/WhatSoup --state merged --head fix/bot-errors-redaction-ssot --json number -q '.[0].number')"
MERGE_SHA="$(gh pr view "$PR_NUMBER" --json mergeCommit -q '.mergeCommit.oid')"
gh pr view "$PR_NUMBER" --json state,mergeCommit
gh api "repos/LucasQuiles/WhatSoup/commits/$MERGE_SHA/check-runs"
```

Expected: PR state `MERGED`; post-merge main checks green.

## Acceptance Checklist

- [ ] Health-check redacts `.config/secrets/...` paths.
- [ ] Collector, dispatcher, emit, health-check, heartbeat-watchdog, q-loop, and runner share one Python redaction implementation.
- [ ] Existing wrapper function names remain available.
- [ ] Runtime manifest tracks the shared module and all changed scripts.
- [ ] Python redaction parity tests include every deploy redactor.
- [ ] SSOT guard fails if a local redaction regex clone is reintroduced.
- [ ] TypeScript repo-hygiene secret scan remains explicitly separate and documented as a source-diff guard.
- [ ] No raw token, credential path, private key, GitHub token, AWS key, JWT, URL userinfo, phone number, or WhatsApp JID appears in redacted fixture outputs.
- [ ] Full push verification is clean before any push.
- [ ] CI and post-merge main CI are green before closure.

## Residuals After This Plan

- A future cross-language vocabulary decision may still be useful after the Python SSOT lands, but it should be based on observed overlap between runtime redaction and source-diff hygiene.
- The broader Python standalone deployment decision remains: a shared manifest-tracked package is the recommended direction; if this import shape breaks a real host deployment, revert the implementation and replace it with an explicit N-copy equivalence guard.
