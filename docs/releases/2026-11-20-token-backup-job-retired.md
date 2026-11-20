# Microsoft 365 token backup job retired

The `com.whatsoup.ms365-token-backup` launchd job is retired from the standard.
Every day it copied the Microsoft 365 MCP token cache, in plain text, into a
backup folder. The job was already retired on the hosts; this change removes it
from the repository's standard so that no install creates it again.

## What changed

- `deploy/managed-components.json` no longer lists the job as a protective
  service. Nothing in the repository installs it or reads its templates;
  `deploy/setup.sh` never installed it.
- `scripts/check-launchd-drift.sh` (`npm run guard:launchd-drift`) reports a
  leftover plist or script as `retired:` drift, names the file to remove and
  exits 1. It never reads either file, and it no longer treats the plist as a
  bot instance.
- `npm run release:activate-host` refuses a host that still has the plist
  installed or the job loaded. The failed precondition is
  `retired:com.whatsoup.ms365-token-backup`, and its detail names the plist and
  the script to remove. Before this change, a leftover plist refused as
  `loaded:… not loaded`, and a loaded job passed as an unrelated job.
- The BOT ERRORS health check reports the job when launchd has it loaded, idle
  or running, as `FAIL retired_service ms365-token-backup` in the daily summary.
  It reads only the host that runs the check, and only when that host's health
  profile does not set `allowUnprofiledInstances`. Before this change, a running
  copy was skipped as a support service and an idle copy was not seen.

## What each Mac host must do before its next activation

1. If the job is loaded, boot it out:
   `launchctl bootout gui/$(id -u)/com.whatsoup.ms365-token-backup`.
2. Remove `~/Library/LaunchAgents/com.whatsoup.ms365-token-backup.plist` and
   `~/.local/bin/ms365-token-backup`.
3. Run `npm run guard:launchd-drift`. It must print no `retired:` line.

## Not changed

The backup folder the job wrote, `~/.ms365-mcp-backups`, is left alone. Whether
to delete it is a separate decision. No check in this change reads, moves or
deletes it.
