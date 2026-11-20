# Microsoft 365 token backup job retired

The `com.whatsoup.ms365-token-backup` launchd job is retired from the standard.
Every day it copied the Microsoft 365 MCP token cache, in plain text, into a
backup folder. The job was already retired on the hosts; this change removes it
from the repository's standard so that no install creates it again.

## What changed

- `deploy/managed-components.json` no longer lists the job as a protective
  service, and `deploy/setup.sh` never installed it. Its two templates,
  `deploy/templates/com.whatsoup.ms365-token-backup.plist` and
  `deploy/templates/ms365-token-backup.sh`, stay tracked until they can be
  deleted. `.gitattributes` marks both `export-ignore`, so no release export
  carries them, and no setup step, deploy script or manifest references them.
- New instances cannot take the name `ms365-token-backup`: instance creation
  refuses it, because the instance would get the retired label. An instance that
  already has that name, found by its config under the instance config root,
  is checked as that instance by every check below, never as the retired job.
- `scripts/check-launchd-drift.sh` (`npm run guard:launchd-drift`) reports a
  leftover plist (`~/Library/LaunchAgents/com.whatsoup.ms365-token-backup.plist`)
  or script (`~/.local/bin/ms365-token-backup`) as `retired:` drift, names the
  file to remove and exits 1. It checks only that each file exists: no other
  scan opens the retired plist, and discovery never treats it as a bot instance
  (an operator who names it with `--instance` gets the instance checks instead).
  It checks the files of the user running it, and only when that user's
  LaunchAgents folder exists.
- `npm run release:activate-host` refuses a host that still has the plist
  installed or the job loaded in the running user's launchd domain. The failed
  precondition is `retired:com.whatsoup.ms365-token-backup`. Its detail says to
  boot the job out when it is loaded, names the plist launchd loaded it from when
  that differs from the canonical one, and names the canonical plist and the
  script when they exist. Single-instance `release:activate` does not check for
  the retired job.
- The BOT ERRORS health check reports the job when launchd has it loaded, idle
  or running, as `FAIL retired_service ms365-token-backup` in the daily summary.
  It reads only the launchd jobs of the user running the check, on that host.
  It runs only on the profile path: config inventory on, the instance config
  root present, at least one instance declared in the profile, and
  `allowUnprofiledInstances` not set. An unloaded plist or a script alone gives
  no finding, and a systemd unit of that name is an ordinary service.

## What each Mac host must do before its next login or restart

The plist sets `RunAtLoad`. A plist left in `~/Library/LaunchAgents` is loaded
again at the next login or restart and runs the job once at that moment, so
booting the job out is not enough.

1. If the job is loaded, boot it out:
   `launchctl bootout gui/$(id -u)/com.whatsoup.ms365-token-backup`.
2. Remove `~/Library/LaunchAgents/com.whatsoup.ms365-token-backup.plist` and
   `~/.local/bin/ms365-token-backup`, and any other plist that
   `release:activate-host` names as the one the job was loaded from.
3. Run `npm run guard:launchd-drift`. It must print no `retired:` line.

`npm run release:activate-host` refuses the host until these steps are done.

## Not changed

The backup folder the job wrote, `~/.ms365-mcp-backups`, is left alone. Whether
to delete it is a separate decision. No check in this change reads, moves or
deletes it. Deleting the two template files from the repository is still owed.
