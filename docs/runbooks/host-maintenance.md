# Host Maintenance Runbook

Manual host-level maintenance steps surfaced by the harness-maintenance daily
probe. These need root or interactive auth, so they are **documented, not
automated** — the probe reports the drift; an operator applies the fix.

Run the probe's dry-run check any time to see current findings on hosts where
`deploy/setup.sh` installed the wrapper (it does so on both Linux/systemd and
macOS/launchd hosts):

```
~/.local/bin/whatsoup-harness-maintenance --check
```

On macOS, `deploy/setup.sh` also renders the `com.whatsoup.harness-maintenance`
launchd timer plist into `~/Library/LaunchAgents` (not loaded — see the
"macOS (launchd) Maintenance Timers" section of
[docs/runbook.md](../runbook.md#2-service-management)). To run the probe
ad hoc without the wrapper:

```
cd <repo checkout>
deploy/scripts/harness-maintenance.sh --check
```

Every run, scheduled or ad hoc, writes its final state to
`~/.cache/whatsoup/harness-maintenance/state.json` (one event per finding) and
appends to `run.log` beside it. Exit codes: `0` every step clean, `1` a step
failed or was inconclusive (the state is `degraded`) or the state could not be
written, `3` a partial agent CLI install that needs reconciliation by hand.

### What `--check` does and does not do

`--check` validates, inventories and plans, then reports. It is safe to run on
a live host:

- **Writes only** its state directory (`state.json`, `run.log`) and a
  temporary directory removed on exit; npm's cache is pointed into that
  temporary directory.
- **Runs only** the pinned node on this repo's scripts, `plutil`, read-only
  `systemctl` verbs (`list-units`, `show-environment`, `show`, `is-active`),
  read-only npm verbs (`--version`, `config get`, `view`, `ls`), `apt list`,
  `ps` (uid, elapsed time and executable name only) and
  `scripts/check-unit-drift.sh`.
- **Never** installs (not even npm's dry-run install smoke, so the npm cooldown
  verdict is marked configuration only), merges or backs up `~/.npmrc`, sends
  an alert, or executes a harness binary: not the agent CLI (so no plugin or
  MCP listing, which can refresh MCP authentication), not codex or opencode
  (their versions come from npm package metadata; anything else is reported
  `unknown`), not local MCP binaries and not runtime `--version` probes (those
  are reported by path).

The boundary is enforced by
`tests/deploy/harness-maintenance-check-boundary.test.ts`.

## Agent CLI update path

The nightly job updates the native agent CLI only when every service instance
resolves the installer-managed launcher `~/.local/bin/claude` and that
launcher is the native layout; any pin, unknown or missing instance holds the
update. The target is the newest release older than `npm.cooldown_minutes`
(never a downgrade or prerelease). The install runs from the verified previous
binary; a failed install or postcheck swaps the launcher link back to that
binary (never a network reinstall) and still ends `degraded`. Event statuses
under the `claude` component: `install-attempted`, `updated`,
`rollback-attempted`, `rollback-verified` (exit 1), `rollback-failed` (exit 3:
reconcile the launcher by hand), plus `held`, `current`, `unmanaged-layout`,
`missing`, `unknown` and, in `--check`, `drift`.

### The cooldown is advisory while the CLI can update itself

The release-age cooldown governs only this job's installs. A long-running CLI
session can update itself on its own schedule and move the launcher link;
`DISABLE_AUTOUPDATER` has been seen not to stop that path, while
`DISABLE_UPDATES` did. The job **observes this and enforces nothing**; each
surface is its own event:

| Component / status | Surface |
|--------------------|---------|
| `claude-launcher` `moved` / `appeared` / `disappeared` / `unchanged` / `first-observation` | The launcher as this run found it, before any install, against the previous run's `baseline` event. A change did not come from the job's install transaction (warning alert under `harness-maintenance:claude-launcher`; not sent in `--check`). |
| `claude-update-policy` `instance` | Per instance: `DISABLE_UPDATES`, `DISABLE_AUTOUPDATER` and a relocated `CLAUDE_CONFIG_DIR` from the service definition (launchd: plist on disk = next launch, the loaded job environment is not read; systemd: the loaded unit), and from that config directory's settings on disk: `installMethod`, `autoUpdates` and the settings `env` flags. Only set/unset is recorded, never a value. |
| `claude-update-policy` `job-env` | This maintenance job's own environment. |
| `claude-update-policy` `advisory` / `disabled` / `none` / `unknown` | Summary: which instances start the CLI without `DISABLE_UPDATES` (service environment or settings env). `DISABLE_AUTOUPDATER` alone is not counted. |
| `claude-processes` `observed` | Count of this user's native-layout CLI processes and those running over 30 minutes. No command line is read or recorded. |

A `moved` launcher or an `advisory` summary is a finding for the host owner.
Disabling self-updates on a host is a separate, explicitly authorized change;
this job never edits settings or service definitions.

## Google Chrome (apt) upgrade

The probe reports `apt [drift]` when `google-chrome-stable` has a newer candidate
(e.g. `147 → 148`). Chrome is an apt package, so upgrade it in place:

```
sudo apt update
sudo apt install --only-upgrade google-chrome-stable
google-chrome --version   # confirm the new version
```

Restart any long-lived Chrome/automation sessions afterward so they pick up the
new binary.

## Google Drive MCP re-authentication

The scheduled (non-`--check`) run's `mcp-servers` event reports the claude.ai
Google Drive MCP as `! Needs authentication` when its OAuth token has expired;
read it from the last run's `state.json`. `--check` does not list MCP servers
(it reports `mcp-servers` as `skipped`). Re-auth is interactive (browser
consent):

1. List MCP servers and confirm the Drive entry needs auth:
   ```
   claude mcp list   # look for "Google Drive … Needs authentication"
   ```
2. Trigger the OAuth flow for the Drive server — start an interactive `claude`
   session and re-authenticate the Google Drive MCP when prompted, completing the
   browser consent with the intended Google account.
3. Re-run `claude mcp list` and confirm `Google Drive … ✓ Connected`.

If the browser consent fails headlessly, run it from a desktop session where a
real browser can complete the redirect.

## Related

- MCP/ops findings and their fixes: `docs/specs/2026-05-30-mcp-ops-hygiene-design.md`
- Harness-maintenance system: `docs/specs/2026-05-29-harness-maintenance-design.md`
