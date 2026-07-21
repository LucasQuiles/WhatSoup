# Watchdog Target Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect an installed per-instance watchdog whose rendered health endpoint disagrees with the instance's configured health port before it can repeatedly restart a healthy bot.

**Architecture:** Extend the existing `watchdog_currency_inventory` check; do not create another monitor or registry. The config inventory passes its already-resolved per-instance health ports to a pure watchdog-target parser, and the existing daily BOT ERRORS health path reports missing, ambiguous, or mismatched targets with bounded remediation metadata.

**Tech Stack:** Python 3, rendered bash watchdogs, pytest, existing BOT ERRORS runtime manifest and deploy parity gates.

## Global Constraints

- The instance config/profile resolution remains the source of truth for the expected port.
- The installed watchdog script remains the source of truth for the observed target.
- Missing watchdog files retain the existing skip behavior; installation coverage is a separate inventory concern.
- Missing, malformed, multiple, or mismatched installed targets warn explicitly and never report clean parity.
- No health token, request header, or script body is emitted in evidence.
- Runtime manifest and deploy-script hashes change in the same commit.

---

### Task 1: Parse and compare installed watchdog targets

**Files:**
- Modify: `deploy/scripts/bot-errors-health-check.py`
- Modify: `deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py`

**Interfaces:**
- Produces: `watchdog_health_ports(script_text: str) -> set[int]`
- Changes: `watchdog_currency_inventory(expected_ports: dict[str, int | None]) -> list[str]`

- [ ] **Step 1: Write failing parity tests**

```python
def test_watchdog_currency_inventory_warns_on_health_port_mismatch(monkeypatch, tmp_path):
    monkeypatch.setattr(_mod, "HOST_PLATFORM", "darwin")
    monkeypatch.setattr(_mod.Path, "home", lambda: tmp_path)
    bindir = tmp_path / ".local" / "bin"
    bindir.mkdir(parents=True)
    (bindir / "loops-watchdog").write_text(
        'HEALTH_URL="http://127.0.0.1:9127/health"\n'
        'if status not in ("healthy", "degraded"):\n  restart\n'
    )
    out = _mod.watchdog_currency_inventory({"loops": 9090})
    assert any("target_port_mismatch expected=9090 observed=9127" in line for line in out)
```

Add independent tests for exact parity, missing target, multiple targets, invalid expected port, stale degraded-intolerant policy plus a target mismatch, and non-Darwin behavior.

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `/opt/homebrew/bin/pytest -q deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py -k watchdog_currency`

Expected: FAIL because the inventory accepts only a name list and does not inspect target ports.

- [ ] **Step 3: Implement the bounded parser and comparison**

```python
_WATCHDOG_HEALTH_TARGET_RE = re.compile(
    r"https?://(?:127[.]0[.]0[.]1|localhost|\[::1\]):([0-9]{1,5})/health(?:[^A-Za-z0-9_/-]|$)"
)

def watchdog_health_ports(script_text: str) -> set[int]:
    return {
        int(match.group(1))
        for match in _WATCHDOG_HEALTH_TARGET_RE.finditer(script_text)
        if 1 <= int(match.group(1)) <= 65535
    }
```

Compare the resulting set with the configured integer port. Emit one bounded `WARN watchdog_currency` line for `target_missing`, `target_ambiguous`, `target_port_mismatch`, or `config_health_port_unavailable`. Keep the existing stale-policy warning independent so both defects remain visible.

- [ ] **Step 4: Pass resolved ports from both inventory modes**

In the profiled branch, collect `watchdog_ports[name] = port if isinstance(port, int) else None` after profile/config precedence is resolved. In the unprofiled branch, collect the same value from each valid config. Call `watchdog_currency_inventory(watchdog_ports)` in both paths.

- [ ] **Step 5: Verify the focused behavior**

Run: `/opt/homebrew/bin/pytest -q deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py -k watchdog_currency`

Expected: all watchdog-currency tests pass, including simultaneous policy and target warnings.

- [ ] **Step 6: Commit**

```bash
git add deploy/scripts/bot-errors-health-check.py deploy/scripts/tests/test_bot_errors_health_check_provider_probe.py
git commit -m "fix(ops): detect watchdog target drift"
```

### Task 2: Preserve deployment and runtime parity

**Files:**
- Modify: `deploy/bot-errors-runtime-manifest.json`
- Modify: `deploy/scripts/whatsoup-bot-errors-deploy.sh`
- Modify: packaging/parity tests only if their managed-file contract changes.

**Interfaces:**
- Consumes: the final SHA-256 of `deploy/scripts/bot-errors-health-check.py`
- Produces: matching source-manifest and deployer pins.

- [ ] **Step 1: Prove the fail-closed hash drift**

Run: `bash scripts/run-with-pinned-node.sh scripts/check-bot-errors-runtime-manifest.ts`

Expected: FAIL with `hash-drift` for `deploy/scripts/bot-errors-health-check.py`.

- [ ] **Step 2: Update both canonical pins**

Run `shasum -a 256 deploy/scripts/bot-errors-health-check.py`, then replace that file's SHA in both `deploy/bot-errors-runtime-manifest.json` and the `FILES` array in `deploy/scripts/whatsoup-bot-errors-deploy.sh`. Do not modify unrelated pins.

- [ ] **Step 3: Run structural verification**

Run:

```bash
bash scripts/run-with-pinned-node.sh scripts/check-bot-errors-runtime-manifest.ts
bash deploy/scripts/whatsoup-bot-errors-deploy.sh verify "$PWD"
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/check-bot-errors-runtime-manifest.test.ts tests/scripts/bot-errors-health-check.test.ts --pool=forks
python3 -m py_compile deploy/scripts/bot-errors-health-check.py
git diff --check
```

Expected: every command exits 0; the deploy verifier reports `MATCH` for all managed files.

- [ ] **Step 4: Commit**

```bash
git add deploy/bot-errors-runtime-manifest.json deploy/scripts/whatsoup-bot-errors-deploy.sh
git commit -m "chore(ops): pin watchdog parity probe"
```
