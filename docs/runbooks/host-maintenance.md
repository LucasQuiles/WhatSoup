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
cd ~/LAB/WhatSoup
deploy/scripts/harness-maintenance.sh --check
```

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

The probe reports the claude.ai Google Drive MCP as `! Needs authentication` when
its OAuth token has expired. Re-auth is interactive (browser consent):

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
