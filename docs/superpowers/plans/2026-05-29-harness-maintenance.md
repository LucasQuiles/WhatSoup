# Harness Maintenance Implementation Plan

**Status:** completed - implemented on branch feat/harness-maintenance with local verification; not yet pushed or deployed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

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

- [x] Write manifest validation and npm cooldown helper tests covering 7-day eligibility, held fresh releases, invalid manifests, and floating `@latest` detection.
- [x] Implement pure functions in `scripts/harness-maintenance-guard.ts`.
- [x] Add `guard:harness-maintenance` to `package.json`.
- [x] Run `npm test -- tests/scripts/harness-maintenance-guard.test.ts --pool=forks`.

### Task 2: Deploy Runner And Units

**Files:**
- Create: `deploy/scripts/harness-maintenance.sh`
- Create: `deploy/npmrc.hardened`
- Create: `deploy/harness-maintenance.service`
- Create: `deploy/harness-maintenance.timer`
- Modify: `deploy/setup.sh`

- [x] Implement `--check` dry-run mode and default mutating mode.
- [x] Apply `deploy/npmrc.hardened` without overwriting an existing different `~/.npmrc` without a timestamped backup.
- [x] Probe Tier 2 surfaces as detect-only findings.
- [x] Update Tier 1 harnesses only when not in `--check`, using exact versions and smoke checks.
- [x] Wire scripts and units into `deploy/setup.sh`.
- [x] Run `bash -n deploy/scripts/harness-maintenance.sh deploy/setup.sh`.

### Task 3: Verification And Commit

**Files:**
- All changed files.

- [x] Run `npm run guard:harness-maintenance`.
- [x] Run `deploy/scripts/harness-maintenance.sh --check --json`.
- [x] Run focused tests.
- [x] Run repo hygiene staged guard.
- [x] Commit locally on `feat/harness-maintenance` without pushing.

### Self-Review

- Spec coverage: Tier 1 harnesses, Tier 2 probes, 7-day npm cooldown, hardened npmrc, systemd timer, state file, setup wiring, and tests are covered.
- Scope control: Playwright floating `@latest` is reported by the probe but not pinned in this PR.
- Alert scope: v1 emits on-change/failure/update findings through the existing alert command; no weekly digest is added.
