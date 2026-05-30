# Codex-Node npm Cooldown Hardening

## Problem

The harness-maintenance npmrc cooldown (`min-release-age=10080`, 7 days) is the
supply-chain defense-in-depth layer for Codex updates. But Codex runs on NVM
Node `24.13.0`, whose npm is `11.8.0` — a version that does **not** recognize
`min-release-age`. On that node npm logs `Unknown user config "min-release-age"`
and ignores the key, so the npmrc layer is dormant exactly where Codex installs
happen. The 7-day cooldown is currently enforced only by the harness-maintenance
runtime gate (`ensure_npm_version_eligible`). That gate is solid and tested, but
the defense-in-depth layer should also be live, and the recurring warning is
noise.

## Evidence

- Codex wrapper target: `~/.nvm/versions/node/v24.13.0/bin/codex` (npm 11.8.0).
- `min-release-age` is absent from npm 11.8 (`npm help` has no entry); present
  on Node 24.15.0's npm 11.12.1 and on current npm 11.16.0.
- With the key set, npm 11.8 prints on every invocation:
  `npm warn Unknown user config "min-release-age". This will stop working in the
  next major version of npm.`
- The harness-maintenance dry-run already captures this under
  `npm-global:24.13.0`.

## Design

### Decision: bump npm on Node 24.13.0 (keep Codex on its pinned node)

Upgrade the Codex node's npm `11.8.0 → 11.16.0` (current). This activates
`min-release-age`, removes the warning, and keeps Codex on its pinned node (no
runtime-node migration, no change to the wrapper). Migration to Node 24.15.0 was
considered but rejected for this cycle — it changes Codex's runtime node for a
benefit the npm bump achieves more narrowly.

### Decision: add a guard so this can't silently regress

The npm bump is an environment action; nothing in the repo prevents the npm from
being downgraded or the node from changing back. Add a harness-maintenance check
that asserts the Codex node's npm recognizes `min-release-age`, and records a
`codex-npm-cooldown` finding (warn) when it doesn't — turning a silent dormant
layer into a visible, alerting one.

## Implementation plan

1. **Env action (runbook):** on the host,
   `PATH=~/.nvm/versions/node/v24.13.0/bin:$PATH npm install -g npm@latest`,
   then verify `npm --version ≥ 11.12` and
   `npm config get min-release-age` returns `10080` with **no** unknown-config
   warning.
2. **Smoke:** run a non-mutating `codex --version` (via the NVM binary,
   `CODEX_NO_DEFAULTS=1`) to confirm the npm bump didn't disturb Codex.
3. **Repo guard:** in `deploy/scripts/harness-maintenance.sh`, add a
   `check_codex_npm_cooldown` step that runs `<codex-node-npm> config get
   min-release-age` and inspects stderr for `Unknown user config`; record
   `codex-npm-cooldown [ok|degraded]` and `send_alert warn` on degraded (skipped
   in `--check`-only? no — report in both, alert only outside check).
4. **Manifest:** add a `codex_node` field to `deploy/managed-components.json`
   capturing the expected node path and an `npm_min_version`, so the guard reads
   the threshold from config.
5. **Tests:** extend `tests/scripts/harness-maintenance-guard.test.ts` (or a new
   case) for the cooldown-recognition parse — fixture stderr with and without the
   warning.

## Testing

- Guard unit test: warning-present stderr → `degraded`; clean → `ok`.
- `guard:harness-maintenance`, `typecheck:scripts`, focused tests green.
- Post-bump host check: `min-release-age` honored, no warning in the
  `npm-global:24.13.0` probe output.

## Rollout & rollback

The npm bump is reversible (`npm install -g npm@11.8.0`). The guard is additive
and detect-only. No production-runtime impact (Codex is spawned per session, not
a long-lived service).

## Out of scope

Migrating Codex to Node 24.15.0 / retiring 24.13.0 (node-sprawl reduction) — a
separate cleanup if desired later.
