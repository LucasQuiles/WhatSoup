# macOS Host Setup — WhatSoup Fleet

Canonical reference for provisioning a macOS host as a WhatSoup bot node.
Covers Tailscale, git identity, launchd conventions, and node pinning.

---

## Tailscale

### Single-daemon rule

Every host runs **exactly one** Tailscale daemon process. Two daemons sharing
the same Tailscale state directory corrupt each other and break inbound TCP
(ping continues to work, masking the problem).

The canonical install pattern depends on how the host was originally set up:

| Pattern | Indicator | Socket path |
|---|---|---|
| **LaunchDaemon** (CLI install) | `/Library/LaunchDaemons/com.tailscale.tailscaled.plist` | `/var/run/tailscaled.socket` (default) |
| **Tailscale.app** (GUI install) | `/Applications/Tailscale.app` present | managed by app |

Hosts differ: some use the LaunchDaemon pattern and others use Tailscale.app.
Identify the active backend before changing a host. Do not mix active backends
on a single host. An app process and its network extension are parts of one
backend, not evidence of two daemons. An installer that accepts only one backend
type is not a reason to add a second daemon or to migrate a healthy app
installation.

### LaunchDaemon pattern — socket pitfall

The `tailscale` CLI dials `/var/run/tailscaled.socket` by default. If the
plist passes `--socket=/var/run/tailscale/tailscaled.sock` (note the extra
`tailscale/` path component), the CLI cannot reach the daemon even though the
data plane works fine.

First identify the installed socket and its clients. Some hosts pass the explicit
socket path above and others use the default socket, so supply the matching CLI
`--socket` argument. Do not remove a working socket override without updating its
consumers. If a coordinated plist change is needed, **`launchctl kickstart` does
not re-read the plist** — use `bootout` then `bootstrap` in the correct launchd
domain.

```sh
# System LaunchDaemon reload after a coordinated plist edit:
sudo launchctl bootout system /Library/LaunchDaemons/com.tailscale.tailscaled.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.tailscale.tailscaled.plist
```

### Duplicate-daemon recovery

If `brew services start tailscale` was ever run on a LaunchDaemon host, a
second daemon (`homebrew.mxcl.tailscale`) is now loaded with its own fresh
state directory at `/Library/Tailscale`. Stop and disable it:

```sh
sudo brew services stop tailscale
# Verify only one tailscaled process remains:
pgrep -la tailscaled
```

### Verify

```sh
tailscale status          # should list peers
tailscale ip -4           # should return a 100.x.x.x address
```

---

## Git identity standard

All bot hosts configure a shared fleet identity so commits from automation
are not attributed to a personal account. Apply to every repo clone on the
host:

```sh
git -C ~/LAB/WhatSoup config user.name  "WhatSoup Fleet"
git -C ~/LAB/WhatSoup config user.email "whatsoup-fleet@invalid"
```

The `.invalid` TLD is intentional — it is not a real email address and
prevents accidental external delivery.

Do not set this globally (`--global`) on a host that is also used for personal
development.

---

## launchd conventions

### Label format

All WhatSoup services use the prefix `com.whatsoup.<thing>`. Use this prefix
consistently — do not use `com.whatsoup-fleet.*` or `com.fleetconsole.*`.

### RunAtLoad and KeepAlive

Protective-service plists that are maintained by hand must set:

```xml
<key>RunAtLoad</key>
<true/>
```

Without `RunAtLoad=true`, a hand-maintained protective service does not start
after reboot until the next scheduled interval fires or launchd is manually
triggered.

This rule covers hand-maintained protective services. It does not cover
scheduled jobs that ship with `RunAtLoad=false` and rely on their schedule
instead, for example:
`deploy/com.whatsoup.reply-guarantee.plist` (`StartInterval` 60),
`deploy/com.whatsoup.release-drift-check.plist` (`StartInterval` 300),
`deploy/templates/com.whatsoup.bot-errors-j1-collector.plist`
(`StartCalendarInterval`; a load must not produce an off-slot bundle), and
two agents that `deploy/scripts/install-bot-errors-launchd.sh` writes: the
BOT ERRORS heartbeat watchdog (`StartInterval` 300) and the daily BOT
ERRORS health check (`StartCalendarInterval`, 07:20).

Generated per-instance WhatSoup plists are a separate, code-owned contract;
do not copy the hand-maintained template into them. They retain an explicit
`RunAtLoad=false`, install only after successful pairing, and use:

```xml
<key>KeepAlive</key>
<dict>
  <key>Crashed</key>
  <true/>
  <key>SuccessfulExit</key>
  <false/>
</dict>
<key>ThrottleInterval</key>
<integer>60</integer>
```

The generated policy restarts crash-associated signals and nonzero ordinary
exits, with a bounded retry cadence. `KeepAlive` itself implies initial launch,
so the deferred installation order is part of the pairing safety contract. See
`docs/runbooks/macos-launchd-deployment.md` for the one-instance migration and
reload procedure.

### plist reload trap

`launchctl kickstart` (including `kickstart -k`) does **not** re-read the
plist file on disk. After editing a plist:

```sh
domain="gui/$(id -u)"
launchctl bootout "$domain" ~/Library/LaunchAgents/com.whatsoup.LABEL.plist
launchctl bootstrap "$domain" ~/Library/LaunchAgents/com.whatsoup.LABEL.plist
```

---

## Node pinning — wrapper pattern

**Never** reference `/opt/homebrew/bin/node` or `/usr/bin/env node` in a
plist. The Homebrew `node` binary tracks whatever version Homebrew has
installed. When Homebrew updates node, plists that call it directly start
running the new (potentially incompatible) version without any signal.

**Incident record:** mini7's fleet-console plist called
`/opt/homebrew/bin/node` directly. When Homebrew advanced to Node 26, the
`node --version` check in the fleet-console startup path printed a fatal
compatibility error and exited. launchd respawned into the same error
immediately. The observer was effectively dead from 2026-05-27 to 2026-06-09
(13 days) — all daily health summaries for that period were produced without
fleet-console data.

### Correct pattern

Install a pinned-node wrapper at `~/.local/bin/whatsoup-fleet` (or the
appropriate service name) that delegates to the repository's fleet launcher:

```sh
#!/bin/bash
exec /bin/bash "$HOME/LAB/WhatSoup/deploy/whatsoup-fleet" "$@"
```

`deploy/whatsoup-fleet` reads `.nvmrc` for its default NVM binary; a
non-empty `WHATSOUP_NODE` replaces that default. When the chosen binary is
not executable, including an unusable `WHATSOUP_NODE`, the launcher falls
back to `node` on `PATH`. It then requires the resolved Node major version
to be at least the `.nvmrc` major and below the upper bound of
`engines.node` in `package.json`, and launches `src/fleet/standalone.ts`
with native type stripping. Install the repository pin first and verify
the service's resolved binary.

Then reference only the wrapper in the plist `ProgramArguments`:

```xml
<key>ProgramArguments</key>
<array>
  <string>__HOME__/.local/bin/whatsoup-fleet</string>
</array>
```

The bot wrapper (`~/.local/bin/whatsoup`) follows the same pattern and resolves
`WHATSOUP_NODE` from the environment or NVM.

---

## Port map

| Service | Default port | Notes |
|---|---|---|
| WhatSoup Console (fleet) | **9099** | Common default; some hosts use another port |
| ew-bot health endpoint | **9098** | mini9; kept below the fleet console port |
| rb-bot health endpoint | **9095** | mini7 |
| ml-bot health endpoint | **9098** | mini8 |

When adding a host to monitoring or writing a watchdog, verify the port map
rather than assuming only the fleet standard. Instance health ports must stay
inside the `[9090, 9098]` band and must not squat the fleet console port
(`9099`).

---

## Monitoring and recovery checks

### Deployment identity

- One host does not imply one deployment artifact. Launch agents on one host can
  run different releases, and a reported commit alone does not identify a locally
  patched artifact. Keep each release path separate until a qualified deployment
  reconciles them.
- The SSH login account is not always the bot's service account. Read the service
  account's config, keychain context, home and GUI-domain launch agents; a
  successful SSH login does not qualify those surfaces.
- Hosts can use different Node version managers. Do not copy one manager's Node
  path onto a host that uses another.

### Monitor jobs and profiles

- A launchd job whose last exit code is 0 has run. That alone does not establish
  application health or successful alert delivery.
- Keep monitor scopes and release paths separate. Copying a `no-bot` profile from
  a checkout onto the active monitor removes bot coverage.
- Environment overrides and the private per-user health profile take precedence
  over tracked profile copies. Identify the active source before deploying a
  tracked change.
- A set `BOT_ERRORS_HEALTH_PROFILE` is authoritative: if the file it names is
  missing or unreadable, the check fails instead of falling back to another copy.
  The tracked profile copy is used only when that variable is unset and the
  private per-user profile is absent. A stale path in the variable therefore stops
  the check until the path is corrected.

### Watchdog acceptance

Prefer the fleet server's `/livez` endpoint when the installed server implements it.
Require JSON with `alive: true` and a positive PID that matches the fleet process,
and probe an invalid path as a negative control. Where `/livez` and an invalid
path return the same HTML page with HTTP 200, keep the legacy check until the
console receives a qualified upgrade; changing the URL alone would create a false
liveness claim.

An authenticated check of a fleet API route, such as `GET /api/version`, is also
valid. Without a token or ticket that route returns 401, which is expected and
does not justify a restart, so its watchdog must not restart on HTTP
authorization errors. A bot's `GET /health` differs: without credentials it
returns the public 200/503 envelope, not 401. A watchdog that checks only the
bot leaves fleet-process supervision as a separate gap.

### Health and recovery limits

Public health responses establish transport liveness only. Before declaring
application health, read `status_reasons` and `degradation_causes` from
authenticated health:

| Diagnostic finding | Recovery boundary |
|---|---|
| Turn finalization or completed-delivery identity debt | Inspect retained turn and delivery evidence before any data repair. Do not erase debt or resend messages to clear health; a connected transport does not establish completed delivery. |
| `degradation_silence_unproven` | Recovery evidence is missing; a restart that only clears the latch does not prove recovery. |
| `memory_readiness_unknown` | Qualify memory readiness through the installed release's diagnostics. |
| Healthy authenticated response | A point-in-time observation, not an end-to-end message test. |

A memory readiness value that a release captures once at startup and reuses in
health responses does not prove a current provider outage. Do not query the
provider live, rotate credentials or restart only to clear that warning.

A 503 after a recorded WhatsApp logout does not by itself confirm that the linked
device was removed. Read `auth_failure_class` from authenticated health and follow
the recovery table in [the main runbook](../runbook.md), section 5.3: re-pair
only for confirmed removal, with the phone owner's approval; for the parked and
uninspected 401 classes, check Linked Devices on the primary phone first.

The release observer (`scripts/live-release-observers.ts`) prints release
integrity and release currency separately. Exit status 0 means clean release
integrity, including when `release currency: target-differs` reports a
difference from the moving target branch; that difference is advisory. Exit
status 1 means integrity drift: drifted release files, or, when the observer
reads a bot's launchd job (`--launchd-plist`), a `WorkingDirectory` in that job
that names another release than the one the job runs
(`launchd-working-directory-mismatch`). Exit status 2 means an
inconclusive integrity or currency observation, or an alert that could not be
published, even when integrity also drifted. An observer from before
`target-differs` became advisory exits 1 for clean files and a differing target,
so read the `release integrity` line before treating exit 1 as drift.
