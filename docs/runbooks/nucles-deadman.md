# Nucles Deadman Watcher — Off-Host Liveness Monitor

Design document for OBJECTIVES row 22.
Status: DESIGN ONLY — not yet installed. Execution target: host-ops batch (OBJECTIVES row 21).

---

## Problem

Nucles is the single host that runs the WhatSoup alert collector and dispatcher
(bot-errors pipeline). If nucles itself is unhealthy — process crash, disk
pressure, or network partition — no bot on any mini can detect the failure. The
minis' own outbox relay routes *through* nucles, so a nucles-side failure silently
swallows all alerts, including any alert about nucles itself.

This is coverage-matrix gap N1: the only genuine unowned SPOF in the current
monitoring topology. All other gaps are partial-coverage or have a fallback path.

---

## Design

A LaunchAgent on **mini9** (eweintraub, the most consistently live and
monitored host) runs an hourly probe against nucles. Mini9 is preferred because:
- it carries the most complete protective-service stack as of 2026-06-11
- ew-bot has a human owner (Eli) who would notice if mini9 itself died
- mini7 (rachel) and mini8 (ml) are equally suitable fallbacks

### What to probe

The deadman checks two things:

1. **Collector/dispatcher liveness**: HTTP GET to the nucles bot-errors
   collector health endpoint (port configurable; see fleet-console or
   `~/.local/state/bot-errors/` on nucles). A 200 response with
   `{"status":"healthy"}` is passing. Non-200 or connection refused is failing.

2. **Outbox drain age**: SSH into nucles and check the mtime of the most-recent
   file in `~/.local/state/bot-errors/sent/` (hub operator account). If the newest file is older
   than `DRAIN_STALE_THRESHOLD` (default 2 hours), the dispatcher may be stuck.
   This catches a process that is alive and responding to health checks but has
   stopped draining.

Both checks must pass within `PROBE_TIMEOUT_SECONDS` (default 10) or the probe
is treated as failed.

### Alert channel requirement

The alert MUST NOT route through nucles. Valid independent channels:

| Channel | Mechanism | Notes |
|---|---|---|
| **WhatsApp direct** (preferred) | Send a WhatsApp message from mini9 directly to a personal phone using the local whatsapp-mcp helper, bypassing the bot-errors dispatcher entirely | Does not depend on nucles connectivity or health |
| **Email-direct** | `curl` or `sendmail` via a local SMTP relay (e.g. Resend API key stored in mini9 keychain, direct HTTPS POST) | Nucles-independent; requires a Resend or similar key on mini9 |
| **SMS via Twilio** | `curl` POST to Twilio API using the ml-bot subaccount credentials (stored in mini9 keychain) | Nucles-independent; credentials already exist on fleet |

The whatsapp-direct path is preferred because it uses no external service beyond
the WhatsApp network itself, and the personal number to alert is already known
to the fleet config. The email and SMS paths serve as fallbacks if WhatsApp
connectivity on mini9 is also disrupted.

### Plist skeleton

Label: `com.whatsoup.nucles-deadman`
Install path: `~/Library/LaunchAgents/com.whatsoup.nucles-deadman.plist`
Script: `~/.local/bin/nucles-deadman`

```xml
<key>StartCalendarInterval</key>
<dict>
  <key>Minute</key><integer>0</integer>
</dict>
```

(Fires at the top of every hour.)

```xml
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
```

### Script logic (pseudocode)

```
NUCLES_HOST=nucles (or Tailscale hostname / IP)
NUCLES_COLLECTOR_PORT=<configured>
PROBE_TIMEOUT=10
DRAIN_STALE_THRESHOLD=7200   # 2 hours in seconds
ALERT_COOLDOWN=3600          # 1 hour: suppress repeated alerts for the same failure

for each probe:
  1. curl --max-time $PROBE_TIMEOUT http://$NUCLES_HOST:$NUCLES_COLLECTOR_PORT/health
     -> fail if non-200 or no response

  2. ssh -o ConnectTimeout=$PROBE_TIMEOUT q@$NUCLES_HOST \
       'cd ~/.local/state/bot-errors/sent && stat -c %Y "$(ls -t | head -1)"'
     # NOTE single quotes: the $(ls ...) subshell MUST expand on nucles, not on mini9
     -> fail if mtime < now - DRAIN_STALE_THRESHOLD

if any probe failed AND cooldown not active:
  record failure timestamp in ~/.local/state/nucles-deadman/last-alert
  send alert via independent channel (WhatsApp-direct preferred)

if all probes passed AND last-alert exists:
  clear last-alert (recovery)
  send recovery notification
```

### SSH key requirement

The deadman script SSHs into nucles as the `q` user. Mini9 must have a
dedicated keypair authorized in `q@nucles:~/.ssh/authorized_keys`. Use a
read-only restricted key (`no-pty,no-X11-forwarding,command="stat ..."`) to
limit blast radius if mini9 is compromised.

Steps to provision (during host-ops batch):
1. On mini9: `ssh-keygen -t ed25519 -f ~/.ssh/nucles_deadman_ed25519 -N "" -C "nucles-deadman@mini9"`
2. On nucles: append the public key to `~/.ssh/authorized_keys` with a
   `command=""` restriction scoped to the mtime stat call.

### Dependency on nucles Tailscale

Mini9 reaches nucles via Tailscale (100.x.x.x). If Tailscale on mini9 is also
down, the deadman cannot probe nucles over that path. The deadman should attempt
the probe over both Tailscale IP and LAN IP (if on the same LAN) before
declaring a failure.

The deadman's own LaunchAgent on mini9 is itself watched by mini9's existing
BOT-watchdog infrastructure (the watchdog does not currently monitor the
deadman, but adding it to the ensure_loaded list is straightforward — add the
label and plist path to the watchdog's ensure_loaded calls).

---

## Managed-components registration

Once installed, register in `deploy/managed-components.json` under
`protective_services.entries`:

```json
{
  "name": "nucles-deadman",
  "label_pattern": "com.whatsoup.nucles-deadman",
  "install_path": "~/Library/LaunchAgents/com.whatsoup.nucles-deadman.plist",
  "script_install_path": "~/.local/bin/nucles-deadman",
  "schedule": "StartCalendarInterval hourly",
  "run_at_load": true,
  "keep_alive": false,
  "host": "mini9 (eweintraub)",
  "purpose": "Off-host liveness check for nucles collector/dispatcher. Alerts via independent channel (WhatsApp-direct) bypassing the nucles outbox path.",
  "probe": "launchctl print gui/$(id -u)/com.whatsoup.nucles-deadman"
}
```

---

## Limitations and open questions

- **mini9 is itself a SPOF**: if mini9 dies, the deadman dies with it. A second
  deadman on mini7 or mini8 would provide N+1 redundancy but doubles the SSH
  key provisioning footprint. Defer until the first instance is proven reliable.
- **Outbox drain age vs. actual delivery**: a stuck drain (check 2) catches
  dispatcher failures but not failures where messages are drained but not
  delivered (e.g., Resend API outage). The latter is out of scope for a deadman;
  it belongs in delivery-receipt tracking.
- **Cooldown calibration**: 1-hour cooldown suppresses alert spam during a
  prolonged outage. The tradeoff is that a recurring flap (nucles dies and
  recovers every 45 minutes) might be masked. The recovery notification clears
  the cooldown, so a true flap produces alert + recovery + alert... which is
  acceptable.
