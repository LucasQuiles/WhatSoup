# SystemD Unit Reconciliation

## Problem

The checked-in `deploy/*.service|*.timer` units have drifted from the live
units installed at `~/.config/systemd/user/`, in both directions. Running the
full `deploy/setup.sh` would `cp` the repo units over the live ones and
`daemon-reload`, silently dropping live-only operational settings. This blocks
`setup.sh` as a deploy path (the harness-maintenance work had to install via a
targeted subset to avoid the regression). Separately, the Reply Guarantee units
exist in the repo but were never installed on the host, so that feature is dark.

Goal: make the repo the single source of truth by folding every legitimate
live-only setting back into the checked-in units, externalizing host-specific
values, deploying the missing units, then re-enabling `setup.sh` as the safe,
idempotent deploy path.

## Evidence (drift surface, 2026-05-30)

`diff deploy/<unit> ~/.config/systemd/user/<unit>`:

### `whatsoup@.service` (17 deltas)
- **Live-only (keep):** `EnvironmentFile=-%h/.config/whatsoup/secrets.env`;
  `MemoryHigh=4G`; `MemoryMax=6G`.
- **Repo-only (keep):** `ExecStartPre=%h/.local/bin/whatsoup-ensure-node` and
  its rationale comment.
- Both already carry the resilience-spec hardening (`StartLimitBurst=10`,
  `RestartSteps=5`, `RestartMaxDelaySec=120`, `KillMode=mixed`), so those are
  not in conflict. All live-only values are generic (no host specifics).

### `whatsoup-fleet.service` (15 deltas)
- **Live-only:** `Restart=always`; `Environment=FLEET_BIND_ADDRESS=<host tailnet
  IP>` (host-specific Tailscale address).
- **Repo-only:** `ExecStartPre=…ensure-node`; `Restart=on-failure`.

### `whatsoup-heal-notify@.service` (2 deltas)
- Only `ExecStart` path differs: repo uses `%h/LAB/WhatSoup/…` (portable), live
  uses a hardcoded absolute home path instead of `%h`. The repo version is the
  correct one; no repo change needed, just redeploy.

### `whatsoup-reply-guarantee.{service,timer}` (not installed live)
- Repo service runs `node deploy/hooks/drain-stuck-replies.mjs --once` and
  requires `WHATSOUP_REPO_ROOT`. Timer drains every 60s (`OnUnitActiveSec=60`).
- These were never deployed, so stuck replies are not being drained by a timer.

## Design

### Decision: repo is SSOT; host-specific values are externalized

Generic operational settings live in the checked-in unit. Anything tied to a
specific host (currently only `FLEET_BIND_ADDRESS`) moves to a gitignored
per-host EnvironmentFile, so the repo unit is identical across hosts.

### Step 1 — Reconcile `deploy/whatsoup@.service`

Add the three live-only generic settings to the repo unit:

```ini
EnvironmentFile=-%h/.config/whatsoup/secrets.env
# Memory limits — each instance runs ~1.5GB normally.
MemoryHigh=4G
MemoryMax=6G
```

Keep `ExecStartPre=…ensure-node`. Result: repo unit becomes a superset; no
live-only setting is lost on the next deploy.

### Step 2 — Reconcile `deploy/whatsoup-fleet.service`

- Keep `ExecStartPre=…ensure-node`.
- Adopt `Restart=always` (a long-lived API daemon should restart on clean exit
  too, not only on failure).
- Externalize the bind address:
  ```ini
  EnvironmentFile=-%h/.config/whatsoup/fleet.env
  ```
  Create `~/.config/whatsoup/fleet.env` on the host with the host's
  `FLEET_BIND_ADDRESS` value. Add `deploy/fleet.env.example` documenting
  the variable. The live `Environment=FLEET_BIND_ADDRESS=…` line is removed from
  the repo unit.

### Step 3 — `whatsoup-heal-notify@.service`

No repo change. The repo unit (portable `%h`) supersedes the live hardcoded
path on redeploy.

### Step 4 — Deploy the Reply Guarantee units

`setup.sh` installs `whatsoup-reply-guarantee.{service,timer}`, sets
`WHATSOUP_REPO_ROOT` (via the unit's environment or a drop-in), and enables the
timer. Verify the drain runs and `whatsoup-reply-guarantee.timer` is active.

### Step 5 — Re-enable `setup.sh` as the safe deploy path

With the repo units reconciled, `setup.sh`'s `cp … && daemon-reload` no longer
regresses live settings. Add a `--check` / diff mode to `setup.sh` (or a
companion `scripts/check-unit-drift.sh`) that reports repo↔live unit drift
without copying, so future drift is caught by the harness-maintenance probe
(which already reports unit *state*; extend it to also flag *content* drift for
managed units).

## Implementation plan

1. **Snapshot** current live units to `/tmp` for rollback evidence.
2. Edit `deploy/whatsoup@.service` (Step 1) and `deploy/whatsoup-fleet.service`
   (Step 2); add `deploy/fleet.env.example`; gitignore `*/whatsoup/fleet.env`.
3. Add `scripts/check-unit-drift.sh` (compares `deploy/<unit>` to
   `~/.config/systemd/user/<unit>` for the managed set; nonzero on drift) and a
   `guard:unit-drift` npm script; wire it into CI.
4. Extend the harness-maintenance probe to call the drift check and record a
   `systemd-content-drift` finding.
5. Create host file `~/.config/whatsoup/fleet.env` with the bind address.
6. **Controlled rollout** (gated, off-peak):
   - `cp` reconciled units to `~/.config/systemd/user/`; `daemon-reload`.
   - Install + enable `whatsoup-reply-guarantee.timer`.
   - Restart the fleet service and each `whatsoup@<instance>` **one at a time**,
     verifying health between restarts (a restart drops that instance's
     WhatsApp session briefly; stagger to avoid a fleet-wide gap).
7. Verify: zero drift from `check-unit-drift.sh`, all instances active,
   reply-guarantee timer active and draining.

## Testing

- `scripts/check-unit-drift.sh` unit test against fixture pairs (in-sync and
  drifted).
- `shellcheck`, `bash -n` on `setup.sh` and new scripts.
- Dry-run: `setup.sh --check` reports the reconciled set as in-sync after Step 2.

## Rollout & rollback

Rollout is per-instance and reversible: the `/tmp` snapshot restores any unit;
`daemon-reload` + restart reverts. The reply-guarantee timer can be disabled
independently. Gate the live restart window on explicit approval.

## Open questions

- `Restart=always` vs `on-failure` for `whatsoup@` instances (this spec keeps
  the resilience-spec `on-failure` for templates, `always` only for the fleet
  daemon). Confirm during review.
