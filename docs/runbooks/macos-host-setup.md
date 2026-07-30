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

mini7 uses the LaunchDaemon pattern; mini8 and mini9 use Tailscale.app.
Do not mix patterns on a single host.

### LaunchDaemon pattern — socket pitfall

The `tailscale` CLI dials `/var/run/tailscaled.socket` by default. If the
plist passes `--socket=/var/run/tailscale/tailscaled.sock` (note the extra
`tailscale/` path component), the CLI cannot reach the daemon even though the
data plane works fine.

Fix: remove the `--socket` argument from the plist so the daemon binds the
default path. After editing the plist, **`launchctl kickstart` does not re-read
the plist** — you must `bootout` then `bootstrap` (or use `launchctl unload` /
`launchctl load`).

```sh
# Correct reload after plist edit (GUI domain example):
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
appropriate service name) that resolves the node binary from NVM:

```sh
#!/bin/bash
exec "$HOME/.nvm/versions/node/v24.15.0/bin/node" \
  "$HOME/LAB/WhatSoup/deploy/fleet" "$@"
```

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
| WhatSoup Console (fleet) | **9099** | Standard across monitored macOS hosts |
| ew-bot health endpoint | **9098** | mini9; kept below the fleet console port |
| rb-bot health endpoint | **9095** | mini7 |
| ml-bot health endpoint | **9098** | mini8 |

When adding a host to monitoring or writing a watchdog, verify the port map
rather than assuming only the fleet standard. Instance health ports must stay
inside the `[9090, 9098]` band and must not squat the fleet console port
(`9099`).
