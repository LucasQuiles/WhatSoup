# bot-errors pipeline — lineage, deploy method, and host map

The `bot-errors-*.py` scripts in this directory are the WhatSoup fleet's alert
detection, collection, dispatch, and delivery pipeline. Until this import they had
**no upstream git home** — the authoritative copies lived only as non-git snapshot
trees on each fleet host (`~/LAB/WhatSoup/deploy/scripts/` on the Macs, the hub copies
on the Linux collector host). This README establishes the repo as the source of truth.

## Launchd installer scripts

| Installer | Purpose |
|-----------|---------|
| `install-bot-errors-launchd.sh` | Installs the dispatcher, deadman, and health agents on macOS bot/relay hosts (three plists in one run). |
| `install-bot-errors-health-launchd.sh` | Installs only the daily health timer on a host that does not run the full dispatcher stack. Accepts `BOT_ERRORS_HEALTH_HOUR` / `BOT_ERRORS_HEALTH_MINUTE` overrides. |
| `install-bot-errors-gui-monitor-launchd.sh` | Installs the external GUI-session monitor on the central hub. OS-aware: writes a systemd service+timer pair on Linux or a launchd plist on macOS. Accepts `--dry-run`. |

### NORMATIVE — D1 Env-file hydration (`bot-errors.env`)

All `install-bot-errors-*launchd.sh` scripts read configuration from
`~/.config/whatsoup/bot-errors.env` (overridable via `BOT_ERRORS_ENV_FILE`).
The file is **not shell-sourced or eval'd**. Values are extracted by an
`awk`-based `read_env_value()` helper that finds the first line matching
`KEY=` at column 1 and returns the remainder verbatim:

```awk
awk -v key="$key" '
  /^[[:space:]]*#/ { next }
  index($0, key "=") == 1 { value=substr($0, length(key) + 2); found=1 }
  END { if (found) printf "%s", value }
' "$ENV_FILE"
```

Consequences for the env file:

- Values are raw strings. Shell syntax in the value (variable references like
  `$HOME`, command substitutions like `$(...)`, quotes, backslash escapes) is
  **not interpreted**. What is written is what is used.
- Inline comments after a value are included in the value. Write one
  `KEY=value` per line with no trailing content.
- Shell quoting is not needed and has no effect: `KEY="value"` stores the
  literal string `"value"` including the double-quote characters.
- Lines whose first non-space character is `#` are skipped.
- If a key appears more than once, the last matching line wins (awk overwrites
  `value` on each match and prints it at END).

Lookup priority: shell environment variable (already set in the caller's
environment) takes precedence over the env-file value, which takes precedence
over the hardcoded default. This is handled by `env_or_default()` in each
installer, which checks `${!key:-}` before calling `read_env_value`.

`deploy/setup.sh` uses the same `awk` pattern (named `read_env_file_value`)
to read and patch the env file during initial setup.

### NORMATIVE — D2 Fail-closed health-profile guard

Every `install-bot-errors-*launchd.sh` installer and the Linux path of
`deploy/setup.sh` will exit with code 2 if `BOT_ERRORS_HEALTH_PROFILE` is
missing, not a regular file, or not readable by the current user (`! -r`).
This check runs **before any plist is written or any service is registered**.

Exact guard in the installer scripts:

```bash
if [[ -z "$HEALTH_PROFILE" || ! -f "$HEALTH_PROFILE" || ! -r "$HEALTH_PROFILE" ]]; then
  echo "missing BOT_ERRORS_HEALTH_PROFILE; expected readable profile path" >&2
  exit 2
fi
```

In `deploy/setup.sh` this is enforced by `require_readable_bot_errors_health_profile()`,
which calls `resolve_bot_errors_health_profile()` (env file, then environment
variable, then a hostname-derived default under `deploy/health-profiles/`) and
exits 2 with a descriptive message if the resolved path fails the same three
conditions.

The installers attempt to auto-detect a host profile at
`<REPO_ROOT>/deploy/health-profiles/<hostname-lowercase>.json` before
falling back to the env file, but this auto-detection only populates
`HEALTH_PROFILE` if the file already exists — it does not suppress the guard.

### NORMATIVE — D3 `validate_calendar_integer` (health installer only)

`install-bot-errors-health-launchd.sh` exposes `BOT_ERRORS_HEALTH_HOUR`
(default `7`) and `BOT_ERRORS_HEALTH_MINUTE` (default `20`) to control when
the daily health timer fires. Both values are validated before plist
interpolation by `validate_calendar_integer`:

```bash
validate_calendar_integer(){
  local name="$1" value="$2" min="$3" max="$4"
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "invalid $name; expected integer $min..$max" >&2
    exit 2
  fi
  local numeric=$((10#$value))
  if (( numeric < min || numeric > max )); then
    echo "invalid $name; expected integer $min..$max" >&2
    exit 2
  fi
}
```

Validation rules:

- `BOT_ERRORS_HEALTH_HOUR` — must match `^[0-9]+$` and be in the range 0–23
  inclusive. Exit code 2 otherwise.
- `BOT_ERRORS_HEALTH_MINUTE` — must match `^[0-9]+$` and be in the range
  0–59 inclusive. Exit code 2 otherwise.

The `10#` prefix forces decimal interpretation so leading zeros (e.g. `09`)
are not treated as octal in the range check. Both values are passed to the
launchd `StartCalendarInterval` dict verbatim as integers; the installer exits
before writing the plist if validation fails.

### NORMATIVE — D4 Pinned Node/npm toolchain (`run-with-pinned-npm.sh`)

`scripts/run-with-pinned-npm.sh` resolves npm via the same pinned-Node
mechanism used by all other WhatSoup scripts: it sources
`deploy/lib/resolve-node.sh` and calls `whatsoup_resolve_node` to locate the
`node` binary for the version pinned in `.nvmrc`. It then derives `npm` as the
binary next to that resolved `node` (or accepts an override via
`WHATSOUP_NPM`). If the resolved npm is not executable the script exits 1 with
a FATAL message before passing any arguments to npm.

The `verify:release` npm script routes two sub-package installs and tests
through this wrapper to ensure they run under the same toolchain as the rest
of the project:

```
bash scripts/run-with-pinned-npm.sh --prefix tools/whatsoup_guard ci
bash scripts/run-with-pinned-npm.sh --prefix tools/whatsoup_guard run typecheck
bash scripts/run-with-pinned-npm.sh --prefix tools/whatsoup_guard test
bash scripts/run-with-pinned-npm.sh --prefix console ci
bash scripts/run-with-pinned-npm.sh --prefix console run lint
bash scripts/run-with-pinned-npm.sh --prefix console run build
```

This prevents `npm ci` in either sub-package from silently picking up a
system-installed Node/npm that differs from the version required by
`package.json#engines.node`. The wrapper does **not** fall back to a system
npm if the pinned one is missing; it fails closed with a clear error message
asking you to install the pinned version or set `WHATSOUP_NODE`.

### NORMATIVE — D5 GUI-session monitor (`install-bot-errors-gui-monitor-launchd.sh`)

The GUI-session monitor detects when a bot user's GUI session has ended,
taking the bot's launchd agents down silently with it. Because the monitored
bots are per-user macOS GUI LaunchAgents, no in-session watchdog can survive
a user logout. The monitor must therefore run on a **different, always-on
host** (the central hub) and probe each bot host over SSH read-only.

#### Installation

```bash
bash deploy/scripts/install-bot-errors-gui-monitor-launchd.sh [--dry-run]
```

- `--dry-run` renders the unit/plist to stdout without writing any file or
  calling `launchctl`/`systemctl`. Use this to inspect the generated
  configuration before committing to installation.
- Without `--dry-run`, the script auto-detects the hub's scheduler: it
  installs a systemd `.service` + `.timer` pair on Linux and a macOS launchd
  plist on Darwin. If neither `systemctl` nor a Darwin kernel is found, it
  exits 2.
- Before installing (non-dry-run), the script calls `--config-check` on the
  monitor script itself to validate the configuration.

#### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BOT_ERRORS_GUI_MONITOR_LABEL` | `com.bot-errors.gui-session-monitor` | launchd label / systemd unit name. Must match `^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$` (enforced by `validate_label`; exit 2 on violation). |
| `BOT_ERRORS_GUI_MONITOR_INTERVAL_SECONDS` | `300` | Probe interval in seconds. Written into `StartInterval` (launchd) or `OnUnitActiveSec` (systemd). |
| `BOT_ERRORS_EXPECTED_FLEET` | _(required)_ | Path to a hub-private JSON file listing the expected fleet members. Must point outside the repo root. Read by `bot-errors-gui-session-monitor.py` at runtime. |
| `BOT_ERRORS_GUI_MONITOR_USERS` | _(optional)_ | Comma-separated `host=user` overrides for SSH login names when the default `$USER` differs on the target host. |
| `BOT_ERRORS_GUI_MONITOR_SSH_TIMEOUT_SECONDS` | `15` | Per-host SSH connection timeout in seconds. |
| `BOT_ERRORS_GUI_MONITOR_FAILURE_THRESHOLD` | _(optional)_ | Consecutive-failure count before the monitor emits an alert. Non-positive values are treated as 1. |
| `BOT_ERRORS_GUI_MONITOR_STATE` | _(optional)_ | Directory for monitor state files (cooldown timestamps, last-seen records). Falls back to `$BOT_ERRORS_STATE_DIR/gui-session-monitor`. |
| `BOT_ERRORS_STATE_DIR` | `~/.local/state/bot-errors` | Base state directory; used to derive log paths and the default monitor state directory. |

All optional variables are only included in the generated unit/plist when
non-empty; the monitor script reads them from the process environment at
runtime using `os.environ.get`.

The monitor script also accepts `--dry-run` and `--config-check` flags when
invoked directly:
- `--config-check` — validates config only; does not SSH, write state, or
  emit events. The installer calls this automatically before a live install.
- `--once` — runs a single probe cycle (the default mode scheduled by the
  unit/plist).

#### Relationship to the hub deadman watcher

`docs/runbooks/` contains a separate runbook for the **Hub Deadman Watcher**,
a complementary monitor that probes the hub's collector/dispatcher health
from a bot relay host. Its status as of the last update is
**DESIGN ONLY — not yet installed**.

The two monitors cover orthogonal failure modes:

| Monitor | Runs on | Watches | Failure mode covered |
|---------|---------|---------|----------------------|
| GUI-session monitor | Central hub | Bot relay hosts | Bot-user GUI session ends; bot launchd agents go silent |
| Hub deadman | Bot relay host | Hub collector/dispatcher | Hub itself crashes or stops draining; alerts are swallowed |

The GUI-session monitor (#901) is an independent, installed component.
The hub deadman remains a design document pending the host-ops batch
referenced in its OBJECTIVES row.

#### Label safety (`validate_label`)

`validate_label` was added to all three `install-bot-errors-*launchd.sh`
installers in #904 to prevent path-traversal via the launchd label. It is
called on the label value before any plist write:

```bash
validate_label(){
  local name="$1" value="$2"
  if [[ ! "$value" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$ ]]; then
    echo "invalid $name: label must match ^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?\$  (no '/', '..', whitespace or shell metacharacters)" >&2
    exit 2
  fi
}
```

This applies to:
- `BOT_ERRORS_LABEL_PREFIX` in `install-bot-errors-launchd.sh`
- `BOT_ERRORS_HEALTH_LABEL` in `install-bot-errors-health-launchd.sh`
- `BOT_ERRORS_GUI_MONITOR_LABEL` in `install-bot-errors-gui-monitor-launchd.sh`

Characters permitted: ASCII alphanumeric, `.`, `-`, `_`. The label must start
and end with an alphanumeric character. Exit code 2 on violation.

## Scripts

| Script | Role |
|--------|------|
| `bot-errors-runner.py` | Per-bot error runner: invokes the agent loop, captures failures, emits alert events to the local outbox. |
| `bot-errors-emit.py` | Alert emission helper: builds alert event JSON (severity, dedupe key, evidence) and writes it to the local outbox. |
| `bot-errors-health-check.py` | Daily health probe: inventories each instance/service, derives FAIL/WARN lines (auth-bond, queue age, DNS, tooling, config), emits a daily-health summary event. Largest script; hosts the auth-bond daily-layer derivation. |
| `bot-errors-collector.py` | Hub-side relay collector: claims remote hosts' outboxes over ssh, relays events into the hub's incoming queue. Hosts the per-host claim loop. Per-remote `consecutiveFailures` drives two independent, threshold-gated signals off the same counter: `relay_host_down`/`relay_host_recovered` at `RELAY_BACKOFF_FAILURE_THRESHOLD` (backoff-schedule entry/exit) and, earlier and lower-confidence, a typed `collector_remote_unreachable` alert at `BOT_ERRORS_COLLECTOR_FAILURE_ESCALATE_THRESHOLD` (default 2) naming the remote, its failure count, last error class, and last-success age — cleared with a real `eventType="clear"` on the next successful collection, so a persistently uncollectable remote (spoke events aging unseen in its outbox) escalates through the normal dispatcher incident path instead of silently stalling. |
| `bot-errors-dispatcher.py` | Hub-side delivery + suppression engine: dedupe keys, throttle/renotify, storm-collapse, forceNotify policy, WhatsApp + email-fallback delivery. |
| `bot-errors-heartbeat-watchdog.py` | Independent five-minute watchdog of the hub lanes (`q_loop`, dispatcher, collector, daily health, queue backlog, local services/health, and unattended browser-debug resource trees). Stale per-host daily-health evidence reuses the collector's durable reachability receipt (diagnosis, failure count, last success, and Tailscale online/last-seen) without running a duplicate network probe. The only `forceNotify`-privileged source; browser-debug incidents are explicitly non-paging. |
| `bot-errors-q-loop.py` | The hub's agent loop driver. |
| `retire-outbound-quarantine.py` | Fail-closed operator tool for one reviewed outbound quarantine. Its default inspection returns only bounded metadata plus an opaque evidence digest. An apply requires that exact digest, matching `--expected-disposition`, fixed acknowledgement, and `--confirm-op-id`; it creates an owner-only backup, changes `status`/`is_terminal`, preserves versioned evidence byte-for-byte, and records a bounded audit receipt in `outbound_quarantine_retirements`. It never replays an operation or emits a BOT ERRORS clear; runtime recovery remains the contributor-aware clear authority. |

### Collector remote SSH user-mapping (login user MUST be the bot/outbox owner)

`bot-errors-collector.py` reaches each `--remote <host>` by running its capture
step **over `ssh <host>`** (the hub's `~/.ssh/config` resolves the login user).
The remote capture reads that host's outbox under the **logged-in user's**
`$HOME/.local/state/bot-errors/` and writes claim/write-marker state there, so it
assumes **the ssh login user == the user that runs the bot and owns the outbox.**
Every host must satisfy this: the hub's ssh alias for a host must log in as the
operator account that runs the instance, so the alias always lands in the home
directory where that instance's outbox actually lives.

**Failure mode this prevents.** If the hub's ssh alias for a host logs in as some
account *other* than the bot operator (for example a generic per-host login while
the bot itself runs under a named operator account), the collector reads the
empty outbox in the **login** user's `$HOME/.local/state/bot-errors/` and never
sees the operator's real outbox. Alerts — including credential-expiry
`auth-required` events — then accumulate **undelivered** while every
`collectorRemote` sweep reports success against the wrong, empty outbox: a silent
hole with no `relay_host_down`, because the pull itself "succeeded". This exact
mismatch was observed in production and went undetected for weeks. Fix: point the
host's ssh alias at the operator account (`User <operator>`) so login user == bot
user. **Provisioning check for any new bot host:** confirm `ssh <alias>` from the
hub lands as the operator user and that `ls ~/.local/state/bot-errors/outbox`
shows that user's live queue.

**`BOT_ERRORS_RELAY_EXEC_<HOST>` is a remote user-switch *prefix*, not an ssh
replacement.** `remote_python_command` builds `ssh … <host> <RELAY_EXEC_prefix>
python3 - …` (env key = host name uppercased, non-alphanumerics → `_`), so the
value runs **after** ssh lands, as a command prefix. Switching effective user
after login (e.g. `sudo -u <operator>`) does **not** fix a user mismatch:
write/claim paths are still computed for the *login* user, so the capture fails
with `PermissionError` on the login user's state dir. Fix the alias's `User`
instead.

### NORMATIVE — Queue-event envelope v2 compatibility

New queue writers emit `schemaVersion: 2` with one disjoint variant: an
`incident_alert` (`alert` plus `critical`, `error`, or `warning`), an
`incident_recovery` (`clear` plus `info`), or an `observation`
(`observation` plus `info`). Informational requests through the TypeScript
alert API are canonically emitted as `observation`; they are never stored as
an `alert`/`info` pair.

Schema-v1 records remain read-compatible only at dispatcher ingress, and only
the legacy `alert` and `clear` tags are accepted. A valid queued, relayed,
reclaimed-after-restart, or write-failure-recovered v1 record is normalized to
v2 before dedupe, incident mutation, formatting, delivery, or archival.
Historical archives are retained as written; replaying one routes through the
same ingress normalization. Unsupported v1 or v2 combinations are quarantined
without delivery or state mutation, with only the bounded classifier reason in
quarantine metadata. Invalid write-failure breadcrumbs are quarantined before
duplicate suppression; they cannot be replay-suppressed as if they were valid
delivery records.

### Relay archive census (read-only)

`remote_archive_census()` in `bot-errors-collector.py` reports how much
terminal relay archive a remote host is holding, without reading any of it
aloud. It scans exactly the two archive directories the collector's own
remote scripts write under the given root — `relayed/` and
`writefail-relayed/` — and reports each of them, plus a combined total, as
eight aggregates: artifact count, total bytes, oldest and newest artifact age
in seconds, the number of artifacts that no longer parse as a JSON event
record, the number of listed entries the census could not look at, the number
that were already gone, and the number of distinct producer source kinds (a
cardinality, not the values).
Nothing else under the root is scanned, so archive volume is
never conflated with live `outbox/` backlog. No symlink is ever followed, at
either level: an archive directory that is itself a symlink is refused with
status `refused_symlink` and contributes nothing, and inside a real archive
directory only regular files are counted, so a symlinked entry and a nested
directory are both skipped.

**An unavailable directory is never reported as an empty one.** A directory
the census could not list reports status `unavailable` with an errno class of
`permission`, `missing` or `other`, and every one of its aggregates is null
rather than zero — "nothing to retain" and "I cannot see what is there" drive
opposite operator decisions. An entry the census could not look at is
reported in `unusableEntryCount` and an entry that was already gone in
`vanishedEntryCount`; neither contributes a count, a size or an age, because
every aggregate comes from an entry that was opened and measured through the
descriptor, so a directory that measured nothing reports null aggregates and
`partial` rather than a zero. The archive directory is opened once with
`O_DIRECTORY|O_NOFOLLOW` so every listing, stat and read is addressed to that
descriptor rather than to a name that could be repointed between the check
and the use. A non-zero count in either column makes the block `partial`,
including one that is only `vanishedEntryCount`: entries that were in the
listing are missing from the aggregates beside it, so the block cannot call
itself complete. Whenever any directory is not `ok`, the combined total
carries status `partial` and sums only the directories that produced a count,
including a zero, so an incomplete answer cannot be mistaken for a complete
one; when none produced one, the total's aggregates are null rather than
zero, beside the counts of what could not be looked at and what was gone.
The output carries no host, account, instance, user, message text, path,
errno message or identifier, and the failure path is deliberately quiet for
the same reason — a census whose traceback prints the remote root would
defeat its own purpose. Arguments are parsed inside that guard, so even a
malformed clock argument yields the fixed failed payload and a non-zero exit
rather than a traceback naming what was passed. **The census deletes
nothing.** It performs no
retention, no compaction, no rewriting and no move; it only counts what is
already there. Retention thresholds, terminal-status rewriting and any
deletion path remain unimplemented and are gated separately (issue #2459).

### Controller diagnostic envelope

The q-loop, collector, dispatcher, heartbeat watchdog, and deadman write new
diagnostic records through `lib/controller_log.py`. Each record uses the
versioned controller-log envelope documented in
[`docs/architecture/controller-log-envelope-v1.md`](../../docs/architecture/controller-log-envelope-v1.md):
canonical UTC observation time, component and record kind, level/outcome,
process run identity, per-iteration cycle identity, process-local sequence,
explicit durability class, and metadata-only details.

These JSONL streams are `diagnostic_best_effort`; controller state, queues, and
outboxes remain authoritative. A diagnostic append failure cannot replace a
domain result or replay completed work. Instead, the writer atomically replaces
a bounded sink-health receipt under the controller state root and emits
coalesced metadata-only stderr at the first and power-of-two consecutive
failures. A later successful append records one recovery receipt. Existing
legacy JSONL is retained and classified `legacy_unversioned`; it is not
rewritten or assigned invented correlation fields.

### Collector capture-failure escalation: per-transition semantics

`collector_remote_unreachable` (alert at `consecutiveFailures >= BOT_ERRORS_COLLECTOR_FAILURE_ESCALATE_THRESHOLD`,
default 2) is deliberately **per-transition-honest**, not flap-suppressing: it
alerts on every new failure episode and clears on every genuinely successful
collection, one collection at a time. It does not require the same N
consecutive successes that `relay_host_down`'s backoff recovery does
(`recovery_successes`, default 2) before clearing — a single successful
collection resolves the capture failure for that moment, and the escalation
reflects that honestly.

This means a remote that flaps through `RELAY_BACKOFF_FAILURE_THRESHOLD`
(default 3) can produce more `collector_remote_unreachable` transitions than
`relay_host_down` transitions over the same window: `relay_host_down` stays
open across a single recovering poll (it needs the fuller N-successes
streak), while the escalation clears and can re-open on the very next
failure. **This asymmetry is intentional**, not a bug — the two signals have
different thresholds and different confirmation semantics by design, so
behaving differently under a flap is expected. A genuinely flapping remote is
bounded by the dispatcher's existing flap-storm machinery
(`BOT_ERRORS_FLAP_TRIP_THRESHOLD`/`BOT_ERRORS_FLAP_WINDOW_SECONDS`, default 5
trips per 600s, collapses into one storm digest) rather than by holding this
event open across a real recovery.

One implication worth flagging for on-call: because `collector_remote_unreachable`
(threshold 2) and `relay_host_down` (threshold 3) are different sources —
and therefore different dispatcher incident keys — **one persistently dead
remote opens two separate incidents**, not one. This is intentional (each
signal has its own threshold/confirmation semantics, per above), but it
means the notification count for a single dead host is 2, not 1; don't
read the second page as a different host.


## Per-conversation incident scoping

The dispatcher keys incidents on `machine|instance|source`. For a fault that
belongs to ONE conversation that key is too coarse: the first conversation to
fail opens the incident, and every later conversation failing under the same
instance matches the same key and is suppressed as a duplicate. A chat that
goes permanently dead then produces no operator signal at all, because a
different chat already holds the incident open.

An alert naming a conversation the open incident does not yet represent
therefore forces one notification. The incident key is unchanged, so recovery
still matches and existing incident-state files need no migration.

**How the conversation travels.** The producer emits `conversationScope`: the
version tag `cs1_` followed by 16 lowercase hex characters, a bounded
non-reversible digest minted at the emission boundary
(`src/lib/alert-evidence.ts`). A raw conversation identifier is never emitted
and never enters incident state. Untagged values are rejected outright, with
no legacy form accepted. The tag exists because bare hex is ambiguous: decimal
digits are hex digits, so a raw conversation local part satisfies any plain
hex test.

**Privacy.** The digest is not a secret. It is PBKDF2 with a fixed public salt
at 1,000 iterations truncated to 64 bits, so offline enumeration of a numeric
conversation-key space stays tractable, and because the digest input carries
no instance context the same conversation yields the same token across
instances and is correlatable by anyone who can read BOT ERRORS output. Treat
it as a routing and de-duplication token, never as a confidentiality boundary.

**Representation means delivered.** A conversation is recorded as represented
only after a successful send, alongside `mark_incident_sent`. An alert that
fails every route and dead-letters does not mark its conversation covered, so
that conversation's next distinct alert is still forced.

**Overflow.** Past the per-key cap the sidecar records an overflow marker and
stops treating untracked conversations as new. Without it, eviction recycles
conversations into "new" status and one large incident becomes a permanent
alert loop. Past the cap an operator already knows the incident is large.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BOT_ERRORS_CONVERSATION_SCOPED_SOURCES` | `agent_turn_admission_rejected` | Comma-separated sources this gate applies to. A source not listed behaves exactly as before. |
| `BOT_ERRORS_CONVERSATION_SCOPE_RETENTION_SECONDS` | `604800` (7d) | How long a conversation stays represented. Past it the conversation can force again. |
| `BOT_ERRORS_CONVERSATION_SCOPE_MAX_PER_KEY` | `256` | Conversations tracked per incident key, and event ids per conversation. Exceeding it sets the overflow marker. |
| `BOT_ERRORS_CONVERSATION_SCOPE_MAX_KEYS` | `128` | Incident keys carrying a scope sidecar at once. Bounds the state file against a long tail of historical keys. Eviction past the cap tombstones each evicted key in `conversationScopesEvicted` for one retention window; the gate treats an absent key as represented only for a key with a live tombstone, so a never-evicted key still pages once. |

**Rollback.** Setting `BOT_ERRORS_CONVERSATION_SCOPED_SOURCES` to an empty
value disables the gate entirely: every event behaves as it did before this
change, and the sidecar is swept away by the normal state lifecycle -- the
sweep runs on both incident-state save paths, the controller-backed
`IncidentStateCycle.commit()` that production takes and the RESTORE-COMPAT
`save_incident_state` wrapper. `conversationScopesEvicted` tombstones expire on their own retention window
rather than with the sidecar, and the `conversationScopesOverflow` telemetry
record is never swept at all: it is a cumulative count that survives an empty
sidecar by design. No state migration is
needed in either direction.


## NORMATIVE — Alert source and ownership index

This table is the canonical index for the in-repository BOT ERRORS runtime.
Update it whenever a producer, scheduler, relay, or incident-state owner changes.
The systemd cadence is shown directly; the launchd installers above own the
equivalent macOS schedules. `deploy/bot-errors-runtime-manifest.json` owns
deployed-file parity, `deploy/managed-components.json` owns install metadata,
and `deploy/bot-errors-expected-fleet.json` owns the sanitized monitoring scope.

| Signal lane | Detection owner | Scheduler / cadence | Relay and incident owner |
|-------------|-----------------|---------------------|--------------------------|
| Runtime lifecycle, provider, transport, and delivery events | Runtime call sites writing through `src/lib/bot-errors-outbox.ts` / `src/lib/emit-alert.ts`; generic command failures may use `bot-errors-runner.py` | Event-driven in the owning WhatSoup service | Local durable outbox; collector relays remote events; dispatcher owns dedupe, incident state, suppression, and final delivery |
| Turn-recovery supervisor liveness | `src/runtimes/agent/turn-recovery-deadman.ts`, reading successful scan health outside the supervisor timer | Independent in-process cadence every 15 seconds, with 45-second startup grace and staleness threshold | Deadman owns checked alert/clear derivation; dispatcher owns dedupe, incident state, and delivery |
| Remote host outbox collection | `bot-errors-collector.py` | `bot-errors-collector.service`, daemon poll every 30 seconds | Collector owns claim/ack/relay receipts; dispatcher owns the resulting incident lifecycle |
| Durable dispatch and notification delivery | `bot-errors-dispatcher.py` | `bot-errors-dispatcher.service`, daemon poll every 30 seconds | Dispatcher is the sole owner of dedupe keys, throttling, renotify, storm collapse, incident open/clear state, and delivery fallback |
| Dispatcher deadman | `bot-errors-health-check.py --deadman --max-state-age 180` | `bot-errors-deadman.timer`, every 5 minutes | Health check emits the incident; dispatcher delivers it |
| Hub-lane heartbeat and queue backlog | `bot-errors-heartbeat-watchdog.py --once` | `bot-errors-heartbeat-watchdog.timer`, every 5 minutes | Watchdog owns detection and is the only force-notify producer; dispatcher owns incident state and delivery |
| Capability, configuration, auth-bond, provider-probe, and per-instance daily health | `bot-errors-health-check.py --daily`, wrapped by `bot-errors-runner.py` | `bot-errors-health-check.timer`, daily at 07:15 in the checked-in systemd unit | Health check owns inventory and per-instance failure/clear derivation; dispatcher owns incident state and delivery |
| Runtime release staleness | `bot-errors-release-proof-run.sh runtime-staleness` | First run after 19 minutes, then 30 minutes after completion, with up to 2 minutes jitter | Release-proof monitor owns detection; dispatcher owns incident state and delivery |
| Git tree provenance | `bot-errors-release-proof-run.sh tree` | First run after 7 minutes, then 30 minutes after completion, with up to 2 minutes jitter | Release-proof monitor owns detection; dispatcher owns incident state and delivery |
| Agent coordination loop | `bot-errors-q-loop.py` | `bot-errors-q-loop.service`, continuously supervised | Coordination only; it is explicitly not the incident bus and does not replace dispatcher ownership |
| External GUI-session loss | `bot-errors-gui-session-monitor.py` installed by `install-bot-errors-gui-monitor-launchd.sh` | Default 300-second external-host probe interval | External monitor owns detection; normal outbox/dispatcher path owns incident state and delivery |

An alert source observed in BOT ERRORS but absent from this table and from the
runtime manifest is not automatically a WhatSoup-owned producer. Resolve its
host unit or external repository before assigning ownership or changing its
clear policy.

### Producer provenance (test-traffic backstop)

Every producer stamps `runtime.provenance` so the dispatcher can tell verifier
and falsifier traffic from a genuine incident. `is_test_provenance_event` in
`bot-errors-dispatcher.py` screens on `runtime.provenance.test` being exactly
`true`; a matching event is refused before ordinary incident processing, the
original is retained in suppressed audit state, and one bounded meta-alert is
emitted. This is a backstop, not the producer-authority boundary #2391 asks for.

`test` is derived from **strong runner signals only** — `VITEST`,
`VITEST_WORKER_ID`, `JEST_WORKER_ID`, `PYTEST_CURRENT_TEST`, plus
`VITEST_POOL_ID` in the TypeScript producer, whose routing already honours it.
`NODE_ENV=test` is recorded in `signals` but is deliberately **not** sufficient
to mark an event as test traffic: an informational environment value must not be
able to silence a production alert.

| Producer | Stamps provenance |
|----------|-------------------|
| `src/lib/bot-errors-outbox.ts` (`producer: typescript-outbox`) | yes |
| `deploy/hooks/post-tool-use-log.mjs` (`post-tool-use-hook`) | yes |
| `deploy/scripts/bot-errors-emit.py` (`python-emit`) | yes |
| `deploy/scripts/bot-errors-health-check.py` | yes |
| `deploy/scripts/bot-errors-runner.py` | yes |
| `deploy/scripts/bot-errors-collector.py` | **no** — relays remote events |
| `deploy/scripts/bot-errors-heartbeat-watchdog.py` | **no** |

The two unstamped producers are a known residual gap: traffic they originate
cannot reach the dispatcher backstop. Adding a producer without a provenance
stamp re-opens that hole silently, so stamp it at the shared event builder
rather than per call site.

## Runtime-agent health signal dispositions

The scheduled health checker reads
`src/lib/fault-taxonomy-registry.json` for its ordered runtime-agent numeric
field contract. Each registered field declares its evidence label, signal kind,
and whether a positive value represents current risk or diagnostic evidence.
The checker does not infer severity from numeric type.

Cumulative totals, historical maxima, and terminal audit counts remain visible
without independently adding `runtime_agent_at_risk`. Active episode counts and
declared current gauges still add that marker. If the registry is missing,
malformed, or uses an unsupported schema or disposition, the health line warns
with a bounded registry error class and does not invent per-field severity.

The registry is both deployer-managed and SHA-pinned in
`deploy/bot-errors-runtime-manifest.json`; changing the checker contract without
shipping the matching registry fails the local manifest and deployer guards.

## OPERATIONAL — Held ambiguous send outcomes (`outcome_unknown`)

The dispatcher sends to the chat transport before it can record that the send
succeeded. If the process dies in that window, or the response is lost, nothing
on disk proves whether the operator was paged. The transport supplies no
idempotency key, so a resend cannot be deduplicated remotely and would page a
second time for one incident.

Such an event is **held** rather than resent: its durable `delivery.status`
becomes `outcome_unknown`, it stays in `processing/`, and it is exempt from the
reclaim pass that returns other claimed files to `outbox/`. A held event is
never archived under `sent/` and is never dropped.

**How a held event surfaces.** Three signals fire, none of which names the
event:

- one record in `logs/dispatch.jsonl` with record kind
  `delivery_outcome_unknown_held`. It is written before the durable record is
  published, so a hold whose publication does not reach disk is retried and
  logs the line again: expect at most one duplicate line per retried hold, and
  never a duplicate send. Once the record is on disk the line is not repeated,
  including across restarts. It is deliberately anonymous: the controller log
  projects unlisted strings away, so it carries bounded metadata (`attempts`,
  `held`) and no event id. Read `processing/` to find out which item is held;
- the health check's `processing` queue line, which warns at 1 entry for 60 s
  and goes critical at 10 entries for 300 s, and stays critical for as long as
  the file is parked;
- the heartbeat watchdog's `queue:processing` alert.

**Inspect.** Held events are the files in `processing/` whose
`delivery.status` reads `outcome_unknown`. Each also carries
`delivery.outcomeUnknownAt` and a redacted, truncated
`delivery.outcomeUnknownReason`.

The dispatcher writes these records as compact JSON, so the pattern must not
assume a space after the colon:

```bash
grep -lE '"status": ?"outcome_unknown"' "$BOT_ERRORS_STATE_DIR"/processing/*
```

**Release for a re-send.** Only after confirming from the BOT ERRORS chat that
the alert never arrived. Set `delivery.status` back to `"queued"` and move the
file into `outbox/` under its original name (the `.json.<pid>.processing`
suffix drops back to `.json`). The next cycle treats it as an ordinary queued
event. Its attempt counter is kept, but the backoff is **reset**: recording the
hold clears `nextAttemptAtEpoch`, so a released item is retried on the next
cycle rather than waiting out the delay its attempt count would otherwise
impose. Status is the only field to edit — the dispatcher clears its internal
send marker on the next attempt.

**Dead-letter.** If the alert did arrive, or is no longer actionable, move the
file into `dead-letter/` with the `.dead_letter.json` suffix the exhausted-retry
path uses. It leaves `processing/` and is not delivered.

A held event occupies a `processing/` slot until an operator acts, which is why
the queue signals above stay raised. They report that the queue is not draining;
they do not distinguish a held item from a backlog, so read `processing/` to
tell which it is.

## Test suites + CI gates

Two independent pytest-runner scripts gate `deploy/scripts/tests/` in `quality.yml`, and
they answer different questions — neither replaces the other:

| Script | Question it answers | quality.yml step |
|--------|---------------------|-------------------|
| `run-sentinel-tests.sh` | Do the pin/selfcheck/sentinel/gui-session-monitor modules hold their 98%-branch-coverage floor, plus the deployer/installer static+mutation guards and the runtime-receipt gate? | "BOT ERRORS sentinel coverage and deployer mutation gate" |
| `run-bot-errors-full-suite.sh` | Does every test in `deploy/scripts/tests/` still pass — the full dispatcher behavioral suites (`open_renotify_suppression`, `transient_tiering`, the `f5`/`f7`/`f11`/`f12`/... fault-taxonomy suites, `autoclose_honesty`, `inhibition`, `daily_health_freshness_ledger`, and everything else, ~59 files) — not just the curated coverage-floor subset? | "BOT ERRORS full behavioral suite gate" |

Before `run-bot-errors-full-suite.sh` existed, the dispatcher behavioral suites ran in NO
CI gate at all: `run-sentinel-tests.sh` only ever exercised the six coverage-floor modules
above, so a regression in, say, `open_renotify_suppression` or `transient_tiering` could
merge through `quality.yml` undetected — dispatcher.py was protected in CI only by static
guards (runtime-manifest/critical-surface/simulation-matrix/fleet-bot-hardening-parity),
never by running its own behavioral tests. `run-bot-errors-full-suite.sh` closes that gap
by directory-collecting `deploy/scripts/tests/` with no `--cov` flags (it is a blanket
regression net, not a coverage-floor gate, so a newly added `test_bot_errors_*.py` file is
swept in automatically with no script edit required). Wall-clock cost: roughly +25s on top
of the existing curated gate (measured on origin/main, `1330 passed in ~15-25s` depending
on cache warmth).

## Provenance

Import history (sha256 matrix, deviation notes, RESUME NOTE) lives in
[IMPORT-LOG.md](./IMPORT-LOG.md) — a one-time record, not a living contract.

## NORMATIVE — Deploy method (stream + hash-verify)

Fleet minis have **no GitHub access**. Deploys are content-pushed from an operator machine:
stream each script over ssh to the host's running location, then hash-verify on the host.
This section describes the mechanics only; fleet mutation still requires a separately named
owner approval that scopes the target hosts, restart surface, stop condition, and no-secret-output
handling.

Authorization gate: before any fleet mutation, record the named owner, approval reference,
operator, source SHA, explicit host list, whether deploy/proof/restart are each authorized,
and the abort condition. A past close-out baseline is not authorization for a new C2/C3 run.
Owner-accepted exceptions must be written into the approval before that row is touched;
they can cover reachability, restart, hook, or verification residuals only when the owner
approval text names the exact waived field. Backup failure, copy failure, manifest
write/hash failure, raw secret output, or authorization ambiguity remains a hard abort.

- macOS bot/relay hosts: running copies at `~/LAB/WhatSoup/deploy/scripts/`
  (health job + bots read from this tree).
- Linux collector hub: the collector/dispatcher/heartbeat copies under
  the hub's deploy path; restart collector, dispatcher, and q-loop after
  deploying long-running code.

The deploy contract is:

1. Take a per-host backup before mutation; abort if the backup path or restore proof cannot
   be recorded.
2. Copy the manifest-tracked bot-errors scripts, `deploy/bot-errors-runtime-manifest.json`,
   `.husky/pre-commit`, expected-fleet data, and health profiles to the running tree; abort
   on any copy error or missing payload hash.
3. Write a host-local runtime manifest at
   `~/.config/whatsoup/bot-errors-runtime-manifest.json` and point services at it with
   `BOT_ERRORS_RUNTIME_MANIFEST`; abort if the written manifest hash cannot be verified.
4. On Git-backed hosts, stamp `expected_head_sha` with the host checkout's actual HEAD so
   daily health detects real runtime skew without false mismatches from dirty host trees.
   Stamp immediately after the payload copy. Abort on Git-backed hosts if `git rev-parse HEAD`
   fails; non-Git runtime trees may report `git_head_sha: not_a_git_repository`.
5. Activate the drift hook with `core.hooksPath=.husky` where the Git config and hooks
   directory are writable. If either path is not writable, abort unless the owner pre-accepted
   that row as a hook exception; for an accepted hook exception, run the manual drift-hook
   simulation below and record its expected successful shape instead of treating hook
   activation as complete.
6. Restart long-running hub services after copying code. Timer-invoked health, deadman,
   and heartbeat jobs load the new code on their next fire. Confirm restarted services report
   active state through the service manager plus `/health` or equivalent independent probe
   before proceeding; abort on restart failure unless the owner pre-accepted the row as an
   exception.
7. Verify every active runtime path against the manifest, then check outbox/writefail
   queues and service restart counters. Abort on any hash mismatch, write-fail increase,
   runtime-skew critical result, linked-device/auth regression, or provider regression without
   an owner-accepted exception.

Per-row close-out evidence must record: backup path and restore proof, copied payload hash,
host-local runtime manifest path and hash, expected/source SHA, service manager action and
post-action state, `/health` or equivalent health evidence, provider/effective-provider
state, linked-device/auth state, pre/post BOT ERRORS queue/outbox/writefail counts,
archive/drain evidence, runtime-skew result, and any owner-accepted exception wording.
Each field needs timestamped host-local output, hash, count, exit status, or artifact path;
placeholder or summary-only entries do not satisfy close-out.

Current stability evidence, refreshed read-only on 2026-06-13 14:03 ET:

- All probed active runtime paths matched `8/8` host-local runtime manifest hashes.
- `outbox` and `writefail` were empty on every probed host.
- The hub collector, dispatcher, q-loop, and health timer were active; `processing`,
  `dead-letter`, and `quarantine` were empty.
- Dev and relay hosts had the expected health or dispatcher launchd jobs loaded.
- Non-Git runtime trees still report `git_head_sha: not_a_git_repository`; that is
  expected for stream-synced non-Git trees with a source SHA in the host-local manifest.
- An isolated daily CLI simulation can prove runtime-skew event classification without
  touching live queues: match should write a temp-outbox `info` event, and a synthetic
  mismatch should write a temp-outbox `critical` event containing
  `git_head_sha_mismatch`.

## OPERATIONAL — Manual daily-health validation

Do not wait for the randomized systemd timer when validating a deploy or close-out fix.
Trigger the same oneshot service the timer uses, then prove the dispatcher drained the
events:

```bash
ssh <hub-host> 'systemctl --user start bot-errors-health-check.service'
ssh <hub-host> 'journalctl --user -u bot-errors-health-check.service -u bot-errors-dispatcher.service --since "10 minutes ago" --no-pager'
```

The expected successful shape is:

- `bot-errors-health-check.service` exits `status=0/SUCCESS`.
- The health check emits the daily-health summary, per-instance `daily-health-fail`
  events, and any reachable-source clear events into the production outbox.
- The dispatcher logs the same event count with `failed=0`; the hub queue directories
  `outbox`, `processing`, `dead-letter`, `writefail`, and `quarantine` are empty after
  the drain.
- Sent and suppressed archives use lifecycle suffixes such as `.json.<epoch>.sent` and
  `.json.<epoch>.suppressed`; count files with `find`, not `*.json` globs.
- A stamped Git-backed runtime manifest should produce a `git_head_sha: ... expected=...
  match` evidence line. If `expected_head_sha` is unset, runtime-skew is only observable,
  not enforcing.

## OPERATIONAL — No-post runtime-skew simulation

Use this when validating #809/C4a without posting to the production outbox. It exercises
the same `--daily` CLI path that writes daily-health events, but isolates `HOME`,
`BOT_ERRORS_STATE_DIR`, and `BOT_ERRORS_OUTBOX_DIR` under a temp directory.

```bash
tmp=$(mktemp -d "${TMPDIR:-/tmp}/whatsoup-c4a-no-post.XXXXXX")
head=$(git rev-parse HEAD)
profile='{"_explicitProfile":true,"role":"simulation","expectDispatcher":false,"expectQLoop":false,"expectPersonalSocket":false,"expectPersonalTools":false,"expectConfigInventory":false,"expectPluginInventory":false,"expectRuntimeManifest":true,"expectAlertTarget":false,"expectRustDesk":false,"expectFleetApi":false,"expectSourceUpdateAccess":false,"expectProviderProbe":false,"treeProvenanceFetch":false,"instances":[],"requiredCredentialFiles":[]}'

run_runtime_skew_case() {
  case_name="$1"
  expected_sha="$2"
  state="$tmp/$case_name/state"
  mkdir -p "$tmp/home" "$tmp/tmp" "$state/outbox"
  manifest='{"schemaVersion":1,"expected_head_sha":"'"$expected_sha"'","files":[]}'

  env -i \
    PATH="${PATH:-/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin}" \
    HOME="$tmp/home" \
    TMPDIR="$tmp/tmp" \
    BOT_ERRORS_STATE_DIR="$state" \
    BOT_ERRORS_OUTBOX_DIR="$state/outbox" \
    BOT_ERRORS_RUNTIME_MANIFEST_JSON="$manifest" \
    BOT_ERRORS_HEALTH_PROFILE_JSON="$profile" \
    BOT_ERRORS_DRY_SERVICE_STATUS=inactive \
    BOT_ERRORS_DRY_CLOCK_STATUS=synced \
    BOT_ERRORS_DRY_CLOCK_OFFSET_MS=0 \
    BOT_ERRORS_DRY_DISK_FREE_BYTES=10737418240 \
    BOT_ERRORS_DRY_DISK_TOTAL_BYTES=107374182400 \
    python3 deploy/scripts/bot-errors-health-check.py --daily
}

run_runtime_skew_case match "$head"
run_runtime_skew_case mismatch "0000000000000000000000000000000000000000"
rg -n 'git_head_sha|git_head_sha_mismatch|"severity"|"summary"|outboxPolicy' "$tmp"
```

The expected successful shape is: the match case writes one temp event with severity
`info` and `git_head_sha ... match`; the mismatch case writes one temp event with
severity `critical` and `FAIL git_head_sha ... git_head_sha_mismatch`; both events report
`outboxPolicy` as `explicit-outbox`. This proves runtime-skew event classification only.
Use the deploy contract and host manifest verification above to prove file-hash parity.

## OPERATIONAL — Manual drift-hook simulation

If a host's Git config cannot activate `.husky/pre-commit`, prove the copied hook behavior
with a temporary index instead of waiting for a real commit. This exercises the staged-file
trigger and leaves the real index/worktree untouched:

```bash
ssh <mac-host> 'cd ~/LAB/WhatSoup &&
  before=$(git status --short --branch | shasum | awk "{print \$1}") &&
  tmp=$(mktemp /tmp/whatsoup-precommit-index.XXXXXX) &&
  trap '"'"'rm -f "$tmp"'"'"' EXIT &&
  GIT_INDEX_FILE="$tmp" git read-tree HEAD &&
  blob=$(git rev-parse HEAD:package.json) &&
  GIT_INDEX_FILE="$tmp" git update-index --cacheinfo 100755,"$blob",package.json &&
  GIT_INDEX_FILE="$tmp" .husky/pre-commit &&
  after=$(git status --short --branch | shasum | awk "{print \$1}") &&
  test "$before" = "$after"'
```

The expected successful shape is: `guard:repo:staged` passes, the architectural-drift
block runs, drift failures are printed as warn-only recommendations, the hook exits 0,
and the real status hash is unchanged. This is behavior evidence only; it does not replace
`core.hooksPath=.husky` on writable Git-backed hosts.

## Deployment history

See [DEPLOY-LOG.md](./DEPLOY-LOG.md) — past close-out baselines, residuals, and fleet-pass receipts.

## NORMATIVE — Release-proof monitor (central pilot)

Monitor-only detection of tree provenance drift and runtime code staleness on
the in-place-git central pilot host. Design:
`docs/superpowers/specs/2026-07-11-central-hub-release-proof-pilot-design.md`.

### Components

- `bot-errors-release-proof-run.sh tree|runtime-staleness` — scheduler runner.
  Reads `~/.config/whatsoup/bot-errors-release-proof.env` as data (never
  sourced), validates `BOT_ERRORS_RELEASE_PROOF_MODE=observe|emit`, takes a
  shared non-blocking lock, and invokes exactly one detector from the
  versioned bundle. Exits: 0 valid observation, 1 event-write failure,
  2 usage/mode/dependency error, 75 lock contention (recorded skip; units
  treat it as success via `SuccessExitStatus=75`).
- `install-bot-errors-release-proof.sh` — narrow installer with
  `dry-run` / `install --mode observe` / `set-mode` / `verify` /
  `rollback --receipt <dir>`. Manages ONLY the bundle under
  `~/.local/lib/whatsoup/release-proof/<sha>/`, the `current` symlink, the
  mode file, isolated receipts under
  `~/.local/state/whatsoup/release-proof-installer/receipts/`, the four
  monitor units, and the two monitor timer enablements. The supplied SHA must
  equal the source checkout's clean `HEAD`; existing same-SHA bundles are
  immutable and reused only after exact verification. Managed destination
  roots reject symlink components; rollback accepts only complete receipts
  bound to the expected host; failed new bundles remain as forensic evidence.
  `install` accepts only observe mode; emit is a separate `set-mode` after the
  observe soak. Dry-run performs zero writes.
- Units: `bot-errors-tree-provenance.{service,timer}`,
  `bot-errors-runtime-staleness.{service,timer}` — oneshot, 30-minute
  `OnUnitInactiveSec` cadence with distinct bootstrap offsets, resource-capped
  (`MemoryMax=128M`, `TasksMax=32`), sandboxed, and forbidden from naming any
  application/fleet/dispatcher unit.
- `python3 deploy/scripts/bot-errors-runtime-staleness.py --observe-only
  [--json] [--critical]` — canonical non-emitting manual diagnostic. Its
  versioned JSON report contains only bounded execution, inventory, verdict,
  count, and failure-class fields. Exit `0` means a complete current or
  not-running observation, `1` means complete with staleness, and `2` means
  evidence was incomplete or a probe failed. `--critical` requires an
  affirmative observation of the complete critical-file set.

### Single tree producer (B3)

`bot-errors-tree-provenance.py` has two possible schedulers: the standalone
timer above (source `tree-provenance`) and the daily-health embedding
(`tree_provenance_inventory`, daily-health sources). Dispatcher incident
identity is machine|instance|source, so the two DO NOT deduplicate. During
the pilot the standalone timer is the ONLY producer: the daily-health profile
keeps `expectTreeProvenance=false` on the pilot host, and the installer has
no code path that touches the daily-health integration. Alert and clear state
for tree findings is owned by the standalone `tree-provenance` source.

### Drift verification scope

The pilot always passes all four monitor unit names explicitly:

    bash scripts/check-unit-drift.sh --unit \
      bot-errors-tree-provenance.service bot-errors-tree-provenance.timer \
      bot-errors-runtime-staleness.service bot-errors-runtime-staleness.timer \
      --wrapper

plus `install-bot-errors-release-proof.sh verify`, which additionally checks
loaded fragment paths and drop-ins via `systemctl --user show`, and requires
both monitor timers to be enabled and active.

`check-unit-drift.sh` also accepts `--no-wrappers`, which skips wrapper
verification entirely instead of checking the default `whatsoup-ensure-node`
wrapper (or an explicit `--wrapper NAME:REL_PATH` list). It is mutually
exclusive with `--wrapper` and may not be repeated; combining the two, or
repeating either flag, exits `2` before any check runs. Use it only for a
host/context where the pilot units run without the wrapper layer, so there
is nothing for the script to verify.

### Producer cadence receipt (dark, no reader yet)

Each release-proof producer owns one versioned receipt file, republished twice
per cycle -- once at cycle start and once at the cycle's outcome -- under the
state root the units already grant write access to, through
`deploy/scripts/lib/producer_cadence_receipt.py`. One file per producer:
`release-proof-cadence-tree-provenance.json` and
`release-proof-cadence-runtime-staleness.json`. Two files keep the clocks
independent, so a partial write of one producer cannot corrupt the other.

Fields, all bounded tokens, ISO-8601 UTC stamps or integers -- no path,
hostname, process identifier or command output ever enters a receipt:

| Field | Meaning |
| ----- | ------- |
| `schemaVersion` | receipt schema generation; a reader that does not know the version must refuse rather than guess |
| `producer` | systemd unit name, from a closed two-value vocabulary |
| `producerToken` | the wrapper's `tree` / `runtime-staleness` token for the same producer |
| `lastInvocationAt` | every call stamps this, including a skipped cycle |
| `lastAttemptAt` | advances when the producer's owned cycle actually starts |
| `lastSuccessfulObservationAt` | advances only after a complete observation is durably written |
| `outcome` | `in_progress`, `success`, `probe_error`, `emit_failure`, `lock_skip` |
| `stage` | earliest stage reached: `pre_exec`, `cycle_start`, `observation`, `durable_write`, `complete` |
| `mode` | `emit` or `observe`, so observe-mode evidence is never read as emit-mode proof |
| `fetchStatus` | `requested` (refresh landed), `refused` (refresh asked for and not obtained), `not_attempted` (has a fetch step, did not use it this cycle), `not_applicable` (has no fetch step at all) |
| `durableWrite` | what became of the write the success clock rests on: `written`, `not_owed`, `failed`, `not_reached` |
| `invocationContext` | `scheduled` when the service manager supplied an invocation identifier, `manual` when it did not, `unknown` when the variable was present but blank. Only the presence is published, never the identifier |

The two clocks are separate on purpose. A producer that starts every cycle and
fails every observation looks alive under a single clock; separating them makes
that state readable. A cycle the shared lock refused advances neither clock and
records `lock_skip`, so permanent lock contention shows as a stalled attempt
clock rather than as success. No producer code path reaches `lock_skip` yet:
the wrapper that detects lock contention is a separate change, so today that
outcome exists in the writer and its tests only.

#### Observe-mode success is weaker evidence, and unevenly so

An observe-mode cycle advances the success clock in both producers, but the two
are not symmetric and an evaluator must not weight them alike. `durableWrite`
is the field that carries the difference.

For `bot-errors-tree-provenance`, observe mode never writes anything durable.
Emitting the outbox event is that producer's only durable write and observe
mode skips it entirely, so every observe-mode success records
`durableWrite: not_owed`. The success clock there means "the inspection
completed", not "an observation was durably written".

For `bot-errors-runtime-staleness`, observe mode usually still writes. The
per-instance high-water mark is written inside the probe in both modes, so a
cycle that observed at least one running instance records
`durableWrite: written`. Only a cycle in which every discovered instance was
stopped records `not_owed`, and an all-stopped fleet is an ordinary incident
state rather than an exotic one.

This matters because the installer refuses any mode but `observe` at install
time, so an observe soak is the window in which the evaluator's dwell would be
calibrated. Within it the tree producer's success clock is the weaker of the
two on every cycle.

Nothing reads these receipts yet. There is no watchdog check, no dwell and no
alert -- those arrive with the evaluator, which also has to decide what a
receipt that never appears means on a host where the units are not installed.
Receipt failures are swallowed by both producers: a dark liveness receipt must
never break the domain guard it observes. A swallowed failure prints one
bounded line per failed publication on stderr, so it is greppable rather than
silent:

```
tree_provenance cadence_receipt_error <ExceptionClassName>
runtime-staleness cadence_receipt_error <ExceptionClassName>
```

A producer whose receipts stop advancing while these lines appear in the
journal has a writable-state problem, not a dead timer. A producer whose
receipts stop advancing with no line at all is not necessarily a dead timer: it
means nothing reached this file. Among the reasons are a timer that never
fired, a wrapper that refused the cycle before the detector launched (a held
lock exits 75, a bad mode file or a missing dependency exits 2), a process that
died before its first stamp, and a state-directory override that moved the
receipt somewhere else. A missing or unwritten receipt reads as empty rather
than as an error, so the receipt alone cannot separate them; the unit's own
result and the wrapper's stderr can.

Mode-lock is the first kind and not the second. The durable reader refuses any
group- or world-accessible bit on the receipt file, which a restore from backup
or a manual copy can introduce; the producer swallows that refusal like any
other, so the line does appear and the receipt freezes at its last good value.
The token carries only the exception class, so a single `DurableWriteError`
covers a mode-locked receipt, a corrupted payload and a payload that is not a
JSON object alike. Stat the file to separate them: `0600` and `0700` are
accepted, `0640`, `0604` and `0660` are not.
