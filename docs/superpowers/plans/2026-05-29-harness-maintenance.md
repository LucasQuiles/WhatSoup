# Harness Maintenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add daily, supply-chain-aware harness maintenance for the runtime host.

**Architecture:** A manifest describes managed harnesses and detect-only probes. A TypeScript guard validates the manifest and cooldown decisions. A deploy shell script runs dry-run checks, applies hardened npm settings, performs Tier 1 guarded updates, records state, and alerts through the existing alert wrapper. Systemd user units schedule the job.

**Tech Stack:** Bash, systemd user timers, Node 24 strip-types scripts, Vitest, npm 11 release cooldown settings.

---

### Task 1: Guard And Manifest

**Files:**
- Create: `scripts/harness-maintenance-guard.ts`
- Create: `tests/scripts/harness-maintenance-guard.test.ts`
- Create: `deploy/managed-components.json`
- Modify: `package.json`

- [ ] Write manifest validation and npm cooldown helper tests covering 7-day eligibility, held fresh releases, invalid manifests, and floating `@latest` detection.
- [ ] Implement pure functions in `scripts/harness-maintenance-guard.ts`.
- [ ] Add `guard:harness-maintenance` to `package.json`.
- [ ] Run `npm test -- tests/scripts/harness-maintenance-guard.test.ts --pool=forks`.

### Task 2: Deploy Runner And Units

**Files:**
- Create: `deploy/scripts/harness-maintenance.sh`
- Create: `deploy/npmrc.hardened`
- Create: `deploy/harness-maintenance.service`
- Create: `deploy/harness-maintenance.timer`
- Modify: `deploy/setup.sh`

- [ ] Implement `--check` dry-run mode and default mutating mode.
- [ ] Apply `deploy/npmrc.hardened` without overwriting an existing different `~/.npmrc` without a timestamped backup.
- [ ] Probe Tier 2 surfaces as detect-only findings.
- [ ] Update Tier 1 harnesses only when not in `--check`, using exact versions and smoke checks.
- [ ] Wire scripts and units into `deploy/setup.sh`.
- [ ] Run `bash -n deploy/scripts/harness-maintenance.sh deploy/setup.sh`.

### Task 3: Verification And Commit

**Files:**
- All changed files.

- [ ] Run `npm run guard:harness-maintenance`.
- [ ] Run `deploy/scripts/harness-maintenance.sh --check --json`.
- [ ] Run focused tests.
- [ ] Run repo hygiene staged guard.
- [ ] Commit locally on `feat/harness-maintenance` without pushing.

### Self-Review

- Spec coverage: Tier 1 harnesses, Tier 2 probes, 7-day npm cooldown, hardened npmrc, systemd timer, state file, setup wiring, and tests are covered.
- Scope control: Playwright floating `@latest` is reported by the probe but not pinned in this PR.
- Alert scope: v1 emits on-change/failure/update findings through the existing alert command; no weekly digest is added.
