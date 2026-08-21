# Anonymous Health Projection Ceiling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent anonymous health bodies from producing workload verdicts, preserve transport-down detection, and remove the two high-severity npm audit findings observed on the exact PR head.

**Architecture:** Enforce the existing authority boundary twice: stop unauthenticated non-diagnostic bodies before field evaluation, then exempt those projections from raw-status workload failure while retaining WARN-class configuration markers. Remediate the independent development-tool advisories through lockfile-only transitive upgrades, with a zero-finding audit and reproducible install as the acceptance gate.

**Tech Stack:** Python 3.12, pytest, Node.js 24.15.0, npm, Vitest, Test Integrity, WhatSoup release guards.

## Global Constraints

- Base all work on exact #3332 head `066041258e0c1f43338f9e2a8e12c0ebf4934e59`.
- Do not mutate or push the peer-owned remote PR branch; deliver local commits for owning-lane harvest.
- Anonymous body fields may never produce status, freshness, identity, authentication, database, provider, or runtime-agent verdicts.
- Anonymous diagnostic-shaped 200, 401, 403, and 503 responses are WARN-class configuration evidence, never workload FAIL.
- Connection-refused and transport errors remain FAIL.
- Authenticated diagnostic behavior remains unchanged.
- Use Node.js `24.15.0`; do not accept the Node 26 engine-warning dry-run as remediation evidence.
- Dependency remediation must require no direct dependency or breaking-version change and must leave full `npm audit` at zero findings.
- #3332 remains owner-gated; these local commits do not authorize merge.

---

### Task 1: Enforce the anonymous projection ceiling at both health boundaries

**Files:**
- Modify: `deploy/scripts/tests/test_bot_errors_health_check_health_projection.py`
- Modify: `deploy/scripts/bot-errors-health-check.py:3155-3197`
- Modify: `deploy/scripts/bot-errors-health-check.py:3539-3579`
- Modify: `deploy/bot-errors-runtime-manifest.json`
- Modify: `tests/scripts/bot-errors-health-check.test.ts`

**Interfaces:**
- Consumes: `classify_projection(payload, token_sent=bool) -> str`, `health_body_is_disclosed(payload) -> bool`
- Produces: unchanged `health_probe_details(...) -> str` and `format_health_probe(...) -> str` signatures with stricter anonymous semantics

- [ ] **Step 1: Strengthen the anonymous 200 regression test**

Replace the body and assertions in
`test_anonymous_diagnostic_shaped_body_hits_projection_ceiling` with:

```python
    body = json.dumps(
        {
            "schema_version": "health.v3",
            "status": "degraded",
            "generated_at": "2020-01-01T00:00:00Z",
            "whatsapp": {
                "connected": False,
                "connection": {"state": "logged_out", "auth_failure_class": "logged_out"},
            },
            "instance": {"name": "other-bot"},
            "runtime": {"agent": {"activeSessions": 9}},
        }
    )
    line = _mod.format_health_probe(
        "http://127.0.0.1:9099/health",
        200,
        body,
        "primary-bot",
        False,
        True,
    )

    assert line.startswith("WARN 200 ")
    assert "health_projection=unobserved" in line
    assert "health_unauthenticated_disclosure" in line
    assert "health_token_missing" in line
    for forbidden in (
        "health_degraded",
        "health_unhealthy",
        "health_status_",
        "health_generated_at_",
        "health_identity_",
        "health_probe_auth_failed",
        "wa_connected=",
        "auth_failure_class=",
        "runtime_agent_",
    ):
        assert forbidden not in line
```

- [ ] **Step 2: Add the anonymous 401/403/503 regression test**

Add immediately after the 200 test:

```python
def test_anonymous_diagnostic_shaped_error_statuses_are_configuration_warnings(monkeypatch) -> None:
    _freeze_body_age(monkeypatch)
    body = json.dumps(
        {
            "schema_version": "health.v3",
            "status": "unhealthy",
            "generated_at": "2020-01-01T00:00:00Z",
            "whatsapp": {"connected": False},
            "instance": {"name": "other-bot"},
        }
    )

    for status in (401, 403, 503):
        line = _mod.format_health_probe(
            "http://127.0.0.1:9099/health",
            status,
            body,
            "primary-bot",
            False,
            True,
        )
        assert line.startswith(f"WARN {status} ")
        assert "health_projection=unobserved" in line
        assert "health_unauthenticated_disclosure" in line
        assert "health_token_missing" in line
        for forbidden in (
            "health_probe_auth_failed",
            "health_unexpected_status",
            "health_unhealthy",
            "health_degraded",
            "health_status_",
            "health_generated_at_",
            "health_identity_",
            "wa_connected=",
        ):
            assert forbidden not in line
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
/opt/homebrew/bin/python3.12 -m pytest -q \
  deploy/scripts/tests/test_bot_errors_health_check_health_projection.py
```

Expected: FAIL only on the new authority-ceiling assertions. The current head leaks body markers and returns FAIL for anonymous 401/403/503.

- [ ] **Step 4: Stop anonymous body evaluation immediately**

Replace the anonymous block in `health_probe_details()` with:

```python
    if not token_sent and health_projection != "diagnostic":
        # Anonymous bodies prove endpoint liveness and configuration debt only.
        # No body field may produce a workload or privileged verdict.
        if health_body_is_disclosed(data):
            add_marker("health_unauthenticated_disclosure")
        return " ".join(details)
```

Keep the existing public-envelope return for token-sent/rejected responses.

- [ ] **Step 5: Make severity classification projection-aware**

Replace `non_diagnostic_public` with:

```python
    non_diagnostic_projection = (
        "health_projection=public" in details
        or "health_projection=unobserved" in details
    )
```

Use `not non_diagnostic_projection` in the raw 5xx FAIL condition, and add this WARN condition:

```python
        or "health_unauthenticated_disclosure" in details
```

- [ ] **Step 6: Run focused RED→GREEN verification**

Run:

```bash
/opt/homebrew/bin/python3.12 -m pytest -q \
  deploy/scripts/tests/test_bot_errors_health_check_health_projection.py
```

Expected: all projection tests PASS.

- [ ] **Step 7: Prove true-down and authenticated behavior remain intact**

Run:

```bash
/opt/homebrew/bin/python3.12 -m pytest -q \
  deploy/scripts/tests/test_bot_errors_health_check_health_projection.py::test_probe_health_missing_token_connection_refused_stays_legacy_fail \
  deploy/scripts/tests/test_bot_errors_health_check_health_projection.py::test_diagnostic_body_without_name_still_flags_identity_missing \
  deploy/scripts/tests/test_bot_errors_health_check_health_projection.py::test_token_rejected_is_warn_not_identity_fail
```

Expected: 3 passed.

- [ ] **Step 8: Run the complete affected health suites**

Before running the complete suite, replace the
`deploy/scripts/bot-errors-health-check.py` manifest entry's `sha256` with
the exact output of:

```bash
shasum -a 256 deploy/scripts/bot-errors-health-check.py
```

Do not change the pinned path or remove any `mustContain` marker.

Run:

```bash
/opt/homebrew/bin/python3.12 -m pytest -q deploy/scripts/tests
NODE_BIN="$HOME/.nvm/versions/node/v$(tr -d '[:space:]' < .nvmrc)/bin"
test -x "$NODE_BIN/node" && export PATH="$NODE_BIN:$PATH"
test "$(node -v)" = "v24.15.0"
npx vitest run \
  tests/scripts/bot-errors-health-check.test.ts \
  --pool=forks --fileParallelism=false --retry=0
npm run guard:bot-errors-runtime-manifest
npm run guard:test-integrity:required
```

Expected: deploy Python, all 161+ TypeScript health tests, 41-file manifest guard, and Test Integrity all PASS with zero new or drifted findings.

If an existing TypeScript fixture is intended to exercise authenticated diagnostic
status or freshness evaluation, pass `tokenSent=true` explicitly. Do not weaken the
anonymous projection ceiling to preserve a fixture that accidentally relied on the
helper's `tokenSent=false` default.

- [ ] **Step 9: Commit the health repair**

```bash
git add \
  deploy/bot-errors-runtime-manifest.json \
  deploy/scripts/bot-errors-health-check.py \
  deploy/scripts/tests/test_bot_errors_health_check_health_projection.py \
  tests/scripts/bot-errors-health-check.test.ts
git commit -m "fix(bot-errors): contain anonymous health verdicts"
```

---

### Task 2: Remove the observed npm advisory findings

**Files:**
- Modify: `package-lock.json`
- Do not modify: `package.json`

**Interfaces:**
- Consumes: npm lockfile transitive graph under Node.js 24.15.0
- Produces: patched transitive versions `brace-expansion@1.1.18`, `brace-expansion@5.0.9`, and `nanoid@3.3.18` with no direct dependency changes

- [ ] **Step 1: Capture the failing audit under the pinned runtime**

Run:

```bash
NODE_BIN="$HOME/.nvm/versions/node/v$(tr -d '[:space:]' < .nvmrc)/bin"
test -x "$NODE_BIN/node" && export PATH="$NODE_BIN:$PATH"
test "$(node -v)" = "v24.15.0"
npm audit --json
```

Expected: exit 1 with exactly two high-severity transitive development-tool findings:
`brace-expansion` (GHSA-mh99-v99m-4gvg and GHSA-rgw5-rvv9-x895) and
`nanoid` (GHSA-2v37-7h3g-55p8). Also run `npm audit --omit=dev --json`;
expected exit 0, proving production dependencies are not affected.

- [ ] **Step 2: Apply a lockfile-only non-breaking remediation**

Run:

```bash
NODE_BIN="$HOME/.nvm/versions/node/v$(tr -d '[:space:]' < .nvmrc)/bin"
test -x "$NODE_BIN/node" && export PATH="$NODE_BIN:$PATH"
test "$(node -v)" = "v24.15.0"
npm audit fix --package-lock-only --ignore-scripts
```

Do not use `--force`. Do not accept changes to `package.json`.

- [ ] **Step 3: Inspect the lockfile diff**

Run:

```bash
git diff -- package-lock.json
git diff --exit-code -- package.json
```

Expected: only transitive patched-version/integrity/resolution updates needed for
`brace-expansion` and `nanoid`; `package.json` has no diff. Any unrelated package removal, direct dependency change, or major upgrade blocks this task for re-triage.

- [ ] **Step 4: Verify reproducible install and zero advisories**

Run:

```bash
NODE_BIN="$HOME/.nvm/versions/node/v$(tr -d '[:space:]' < .nvmrc)/bin"
test -x "$NODE_BIN/node" && export PATH="$NODE_BIN:$PATH"
test "$(node -v)" = "v24.15.0"
npm ci
npm audit --json
npm audit --omit=dev --json
npm ls brace-expansion nanoid --all
```

Expected: install exits 0; both audits report zero vulnerabilities; the dependency tree contains no
`brace-expansion` below 1.1.18 or within 4.0.0–5.0.8 and no `nanoid` below 3.3.18.

- [ ] **Step 5: Run dependency-sensitive guards**

Run:

```bash
NODE_BIN="$HOME/.nvm/versions/node/v$(tr -d '[:space:]' < .nvmrc)/bin"
test -x "$NODE_BIN/node" && export PATH="$NODE_BIN:$PATH"
test "$(node -v)" = "v24.15.0"
npm run typecheck
npm run guard:lint:src
npm run guard:node-pin-consistency
```

Expected: all commands PASS.

- [ ] **Step 6: Commit the advisory remediation**

```bash
git add package-lock.json
git commit -m "chore(deps): patch transitive audit findings"
```

---

### Task 3: Final exact-tree verification and owning-lane handoff

**Files:**
- Verify only: all files changed since `066041258e0c1f43338f9e2a8e12c0ebf4934e59`

**Interfaces:**
- Consumes: the two implementation commits from Tasks 1 and 2
- Produces: a local, reviewable commit range with exact verification receipts; no remote mutation

- [ ] **Step 1: Verify the final diff and commit metadata**

```bash
git diff --check 066041258e0c1f43338f9e2a8e12c0ebf4934e59..HEAD
git diff --stat 066041258e0c1f43338f9e2a8e12c0ebf4934e59..HEAD
git log --format='%H%n%an <%ae>%n%s%n%b' \
  066041258e0c1f43338f9e2a8e12c0ebf4934e59..HEAD
```

Expected: only the approved spec/publication audit, two-site Python repair/tests, and lockfile remediation; no prohibited attribution or unrelated files.

- [ ] **Step 2: Run the branch release gate**

```bash
NODE_BIN="$HOME/.nvm/versions/node/v$(tr -d '[:space:]' < .nvmrc)/bin"
test -x "$NODE_BIN/node" && export PATH="$NODE_BIN:$PATH"
test "$(node -v)" = "v24.15.0"
npm run verify:release
```

Expected: exit 0. Any masked, skipped-required, interrupted, or partial run is inconclusive.

- [ ] **Step 3: Re-run security and focused behavior gates after the release gate**

```bash
NODE_BIN="$HOME/.nvm/versions/node/v$(tr -d '[:space:]' < .nvmrc)/bin"
test -x "$NODE_BIN/node" && export PATH="$NODE_BIN:$PATH"
test "$(node -v)" = "v24.15.0"
npm audit --json
/opt/homebrew/bin/python3.12 -m pytest -q \
  deploy/scripts/tests/test_bot_errors_health_check_health_projection.py
```

Expected: zero npm vulnerabilities and all projection tests PASS.

- [ ] **Step 4: Prepare the local handoff**

Record:

```text
PR #: 3332
Base head: 066041258e0c1f43338f9e2a8e12c0ebf4934e59
Local branch: fix/pr3332-anonymous-projection-ceiling
Commit range: 066041258e0c..HEAD
Blast radius: health-check Python implementation/tests, package-lock transitive patches, approved internal spec/audit registration
Local verification: exact command results
GitHub checks: advisory only until the owning lane harvests and pushes a new head
Decision: deliver local commits; do not merge or push
Follow-up: owning lane reviews/harvests, then re-gates the new remote head
```
