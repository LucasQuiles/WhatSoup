# Codex-Node npm Cooldown Hardening

## Problem

The harness-maintenance npmrc cooldown (`min-release-age=7`, 7 days) is the
supply-chain defense-in-depth layer for Codex updates. But Codex runs on NVM
Node `24.13.0`, whose npm is `11.8.0` — a version that does **not** recognize
`min-release-age`. On that node npm logs `Unknown user config "min-release-age"`
and ignores the key, so the npmrc layer is dormant exactly where Codex installs
happen. The 7-day cooldown is currently enforced only by the harness-maintenance
runtime gate (`ensure_npm_version_eligible`). That gate is solid and tested, but
the defense-in-depth layer should also be live, and the recurring warning is
noise.

An additional verification pass found a unit mismatch in the previously deployed
template: npm's `min-release-age` is measured in **days**, not minutes. The repo
must keep the runtime gate at `cooldown_minutes=10080` while writing
`min-release-age=7` to `.npmrc`.

## Evidence

- Codex wrapper target: `~/.nvm/versions/node/v24.13.0/bin/codex` (npm 11.8.0).
- `min-release-age` is absent from npm 11.8 (`npm help` has no entry); present
  in current npm 11.
- With the key set, npm 11.8 prints on every invocation:
  `npm warn Unknown user config "min-release-age". This will stop working in the
  next major version of npm.`
- The harness-maintenance dry-run already captures this under
  `npm-global:24.13.0`.
- With `min-release-age=10080`, npm versions that honor the key reject normal
  installs with an effective cutoff in 1998. With `min-release-age=7`, the same
  established-package dry-run succeeds.

## Design

### Decision: bump npm on Node 24.13.0 (keep Codex on its pinned node)

Upgrade the Codex node's npm `11.8.0 → current` after correcting the managed
`.npmrc` to `min-release-age=7`. This activates `min-release-age`, removes the
warning, and keeps Codex on its pinned node (no runtime-node migration, no
change to the wrapper). Migration to Node 24.15.0 was considered but rejected
for this cycle — it changes Codex's runtime node for a benefit the npm bump
achieves more narrowly.

### Decision: add a guard so this can't silently regress

The npm bump is an environment action; nothing in the repo prevents the npm from
being downgraded or the node from changing back. Add a harness-maintenance check
that asserts the managed npmrc uses the day-based value, the Codex node's npm no
longer reports `min-release-age` as unknown, and an established-package dry-run
install is not blocked by the cooldown. Record a `codex-npm-cooldown` finding
(warn) when it is degraded — turning a silent dormant layer into a visible,
alerting one.

## Implementation plan

1. **Repo hotfix:** set `deploy/npmrc.hardened` to `min-release-age=7` and keep
   `deploy/managed-components.json.npm.cooldown_minutes=10080` for the runtime
   gate.
2. **Host hotfix:** re-apply the corrected npmrc on the host, then verify
   `npm install is-number@7.0.0 --dry-run --ignore-scripts --package-lock=false
   --no-save` succeeds under Node 24.15.0.
3. **Env action (runbook):** on the host,
   `PATH=~/.nvm/versions/node/v24.13.0/bin:$PATH npm install -g npm@latest`,
   then verify `npm --version ≥ 11.12` and no unknown-config warning appears.
4. **Smoke:** run a non-mutating `codex --version` (via the NVM binary,
   `CODEX_NO_DEFAULTS=1`) to confirm the npm bump didn't disturb Codex.
5. **Repo guard:** in `deploy/scripts/harness-maintenance.sh`, add a
   `check_codex_npm_cooldown` step that checks the managed `.npmrc`, inspects npm
   stderr for `Unknown user config`, and runs a bounded dry-run install of an
   established package; record `codex-npm-cooldown [ok|degraded]` and
   `send_alert warn` on degraded (skipped in `--check`-only? no — report in
   both, alert only outside check).
6. **Manifest:** add `npmrc_min_release_age_days` and a `codex_node` field to
   `deploy/managed-components.json` so the guard reads the npmrc day value and
   npm threshold from config.
7. **Tests:** extend `tests/scripts/harness-maintenance-guard.test.ts` for the
   cooldown-recognition parse — fixture the old-npm warning, the 10080 day-unit
   failure, and the corrected 7-day success.

## Testing

- Guard unit test: warning-present stderr → `degraded`; 10080 day-unit dry-run
  failure → `degraded`; corrected `min-release-age=7` → `ok`.
- `guard:harness-maintenance`, `typecheck:scripts`, focused tests green.
- Post-bump host check: no warning in the `npm-global:24.13.0` probe output and
  `codex-npm-cooldown [ok]`.

## Rollout & rollback

The npm bump is reversible (`npm install -g npm@11.8.0`). The npmrc hotfix is
reversible by restoring the previous backup, though `10080` should not be
restored because it blocks installs on npm versions that honor the key. The
guard is additive and detect-only. No production-runtime impact (Codex is
spawned per session, not a long-lived service).

## Out of scope

Migrating Codex to Node 24.15.0 / retiring 24.13.0 (node-sprawl reduction) — a
separate cleanup if desired later.
