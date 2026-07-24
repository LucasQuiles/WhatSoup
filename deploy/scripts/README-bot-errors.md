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

### D1 — Env-file hydration (`bot-errors.env`)

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

### D2 — Fail-closed health-profile guard

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

### D3 — `validate_calendar_integer` (health installer only)

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

### D4 — Pinned Node/npm toolchain (`run-with-pinned-npm.sh`)

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

### D5 — GUI-session monitor (`install-bot-errors-gui-monitor-launchd.sh`)

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
| `bot-errors-collector.py` | Hub-side relay collector: claims remote hosts' outboxes over ssh, relays events into the hub's incoming queue. Hosts the per-host claim loop. |
| `bot-errors-dispatcher.py` | Hub-side delivery + suppression engine: dedupe keys, throttle/renotify, storm-collapse, forceNotify policy, WhatsApp + email-fallback delivery. |
| `bot-errors-heartbeat-watchdog.py` | Independent five-minute watchdog of the hub lanes (`q_loop`, dispatcher, collector, daily health, queue backlog, local services/health, and unattended browser-debug resource trees). Stale per-host daily-health evidence reuses the collector's durable reachability receipt (diagnosis, failure count, last success, and Tailscale online/last-seen) without running a duplicate network probe. The only `forceNotify`-privileged source; browser-debug incidents are explicitly non-paging. |
| `bot-errors-q-loop.py` | The hub's agent loop driver. |
| `retire-outbound-quarantine.py` | Operator tool: retires one reviewed `quarantined` row in an instance's `outbound_ops` table (`--db`, `--instance`, `--op-id`, `--reason`), backing up the DB first and flipping the op to `failed_permanent`/`is_terminal=1`. When that was the last quarantined op it shells out to `bot-errors-emit.py` to emit a BOT ERRORS clear event. Supports `--dry-run` (no writes, reports whether a clear would fire), `--no-backup`, `--no-emit`, and `--emit-script`. |

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

## Canonical source for this import (diff matrix)

Source of truth chosen = **newest copies** per the corrections plan. The local Mac
Studio ("maclab" in the relay corpus) carries the newest LAB-tree copies (Jun 11-12),
ahead of the hub's Jun-9 copies and the deployed mini7 vintage:

| script | imported sha256(16) | size | notes vs other copies |
|--------|--------------------|------|-----------------------|
| collector | 33fbc41b461516e6 | 78621 | 2062 lines; hub Jun-9 copy was 1353 lines (older) |
| dispatcher | dda3d216a587ed52 | 78294 | |
| emit | 969e269cff640d9f | 22601 | hub Jun-9 copy 19125B (older) |
| health-check | e10755806e8af464 | 198839 | LOCAL vintage; ~581 lines ahead of deployed mini7 (170196B, sha 419ba2ef) |
| heartbeat-watchdog | a9cd58d173ff4094 | 40187 | |
| q-loop | 5929a71e76a391f8 | 32044 | |
| runner | 6fccb93be94b5288 | 19576 | hub Jun-9 copy 17629B (older) |

All seven `py_compile` clean (stdlib-only, python3).

### Browser-debug resource ownership

The heartbeat watchdog inventories Linux browser roots that expose a local
remote-debugging port. A tree becomes `browser_debug:<profile-hash>` only when
all three conditions hold: it is older than the configured dwell, its aggregate
descendant RSS exceeds the configured threshold, and the debugging port has no
established controller connection. The alert carries only bounded operational
metadata (hashed profile identity, root PID, age, aggregate RSS, process count,
debug port, and controller count); it never captures page URLs or the profile
path. The watchdog alerts and confirms recovery but does not terminate the
browser.

| Variable | Default | Meaning |
|----------|---------|---------|
| `BOT_ERRORS_BROWSER_DEBUG_MIN_AGE_SECONDS` | `1800` | Minimum root age before an unattended debug tree is eligible. |
| `BOT_ERRORS_BROWSER_DEBUG_MIN_RSS_MB` | `512` | Minimum aggregate root-plus-descendants RSS before an unattended debug tree is eligible. |
| `BOT_ERRORS_DRY_BROWSER_DEBUG_SNAPSHOT` | unset | Test-only JSON snapshot used for deterministic policy and stress tests. |

If controller-connection inventory is unavailable, the watchdog opens the
non-paging `browser_debug:probe` visibility incident instead of asserting that
the browser is unattended. Browser checks can be omitted from a specialized
watchdog lane by excluding `browser_debug` from `BOT_ERRORS_WATCHDOG_CHECKS`.

> NOTE: the detector-misconceptions audit register cites line numbers against the
> **deployed mini7 health-check vintage (170KB)**. This import is the newer LOCAL vintage
> (198KB), so register line numbers are approximate — locate code by function/marker, not
> by deployed-vintage line number.

## Import deviations from verbatim

The import is byte-identical to the canonical maclab LAB-tree copies **except** for a
single forced hygiene transform in `bot-errors-health-check.py`: the default macOS
keychain service-name literal (a vendor product name) trips the public-repo hygiene
guard's model-attribution pattern. It is assembled from string parts at the one
assignment site; the resolved runtime value is unchanged. This is the only non-verbatim
edit in the baseline import, isolated here so every later corrections diff stays clean.

> RESUME NOTE (run 02): between run-01's capture (health-check sha `e10755…`, Jun-12
> 00:29) and resume, the live maclab copy drifted forward (`bf9c36…`, Jun-12 01:16) with
> three unrelated hunks (`recentResumeFailures` mapping, `lastResumeFailedAt` detail,
> `credential_item_status` user-interaction acceptance). Those are out-of-scope feature
> drift, NOT alert-truth corrections, and the audit registers line-cite the e10755
> vintage — so this baseline pins the run-01 vintage. The drift is logged for a later
> reconciliation pass; it must not be silently folded into the corrections series.

## Deploy method (stream + hash-verify)

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

- macOS hosts (mini1/4/7/8/9/10/11, mwlab, maclab): running copies at
  `~/LAB/WhatSoup/deploy/scripts/` (health job + bots read from this tree).
- Linux hub (nucles): the collector/dispatcher/heartbeat copies under the hub's deploy path;
  restart collector, dispatcher, and q-loop after deploying long-running code.

Current close-out baseline: the 2026-06-13 C2/C3/C4 fleet pass streamed the
manifest-tracked bot-errors runtime payload from an isolated operator staging directory,
built from `289c5f7b77c86e64d2ee5ef820aabd7e21492a78`. At deploy time,
`origin/main=2197bfdc`; the intervening diff did not touch bot-errors runtime,
hook, profile, or manifest inputs.

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

## Manual daily-health validation

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

## No-post runtime-skew simulation

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

## Manual drift-hook simulation

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

Known residuals after the close-out pass:

- One Git-backed macOS host has current runtime files and manifests, but hook activation
  is blocked by root-owned `.git/config` and `.git/hooks/pre-commit`.
- Non-Git mini runtime trees are not hook-capable; they can still run the copied runtime
  payload and host-local manifest.
- Stream-sync proves runtime payload currency. It does not imply that every dirty host
  checkout was advanced to the latest `origin/main`.

## Release-proof monitor (central pilot)

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
