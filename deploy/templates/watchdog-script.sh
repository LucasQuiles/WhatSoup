#!/usr/bin/env zsh
# watchdog-script.sh — template for com.whatsoup.BOT_NAME-watchdog
#
# Replace before installing:
#   BOT_NAME      — e.g. rb-bot, ml-bot, ew-bot
#   USERNAME      — macOS user account (the bot operator account)
#   BOT_HEALTH    — health endpoint URL for THIS bot (check port map in
#                   docs/runbooks/macos-host-setup.md before assuming 9099)
#   FLEET_HEALTH  — fleet console URL for THIS host (standard 9099; except
#                   some hosts run the fleet API on a non-default port — see the host port map)
#   NODE_BIN      — absolute path to pinned node binary, e.g.
#                   __HOME__/.nvm/versions/node/v24.15.0/bin/node
#
# Install to: ~/.local/bin/BOT_NAME-watchdog
# chmod +x that file after writing.
#
# Derived from a hardened production watchdog (2026-06-11).
# That version fixed a set -u bug where `local job_label` was referenced
# before assignment — the ensure_loaded function below avoids that by
# accepting both args on a single line.

set -u

HOME_DIR="__HOME__"
LOG_DIR="$HOME_DIR/Library/Logs/whatsoup"
LOG="$LOG_DIR/BOT_NAME-watchdog.log"
# Single-instance lock. Lives in the user-owned LOG_DIR (not /tmp): a
# predictable world-writable path would let any local user pre-create it and
# silently disable the watchdog. The dir holds a pid stamp for staleness
# detection (see acquire_mutex).
LOCK="$LOG_DIR/BOT_NAME-watchdog.lock"
# Present while the bot's provider credential was last conclusively dead
# (decision-block exit 3). Cleared ONLY by affirmative fresh primary recovery
# (exit 0); inconclusive evidence (exits 4/5) retains it — presence means
# "dead until proven recovered", not "dead as of the last cycle". External
# alert paths may stat this file; no in-repo consumer exists.
CRED_MARKER="$LOG_DIR/BOT_NAME-credential-dead.marker"
WD_FINAL="ok"
WD_EXIT=0

BOT_LABEL="com.whatsoup.BOT_NAME"
FLEET_LABEL="com.whatsoup.whatsoup-fleet"
BOT_PLIST="$HOME_DIR/Library/LaunchAgents/$BOT_LABEL.plist"
FLEET_PLIST="$HOME_DIR/Library/LaunchAgents/$FLEET_LABEL.plist"

BOT_HEALTH="http://127.0.0.1:BOT_PORT/health"
FLEET_HEALTH="http://127.0.0.1:FLEET_PORT/"

# Use the pinned node binary — never /usr/bin/env node (see macOS-host-setup runbook).
NODE_BIN="__HOME__/.nvm/versions/node/v24.15.0/bin/node"

PATH="$HOME_DIR/.local/bin:$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="$HOME_DIR" PATH

mkdir -p "$LOG_DIR"

# If the log cannot be opened, no state line (including the final one) can
# ever be recorded — running on would be unobservable. Fail loudly at entry;
# launchd ignores the exit code, but tests and operators must see it.
if ! : >> "$LOG" 2>/dev/null; then
  print -u2 -- "watchdog: cannot open log file $LOG"
  exit 1
fi

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { print -- "$(ts) $*" >> "$LOG"; }

# mkdir-based mutex with pid-stamp + age staleness. Held only while the
# stamped pid is alive AND the lock is younger than stale_after seconds; a
# dead holder, an unreadable/garbage pid, or an aged-out lock is reclaimed
# (rename-then-remove so concurrent reapers cannot free a freshly re-acquired
# lock; a sub-second reap race can still let two contenders through — the
# cooldown stamp bounds the harm to one duplicate kickstart).
acquire_mutex() {
  local dir="$1" stale_after="$2" attempt holder_pid mtime age
  for attempt in 1 2; do
    if mkdir "$dir" 2>/dev/null; then
      print -- $$ > "$dir/pid" 2>/dev/null || true
      return 0
    fi
    holder_pid="$(cat "$dir/pid" 2>/dev/null || true)"
    case "$holder_pid" in
      (<->) ;;
      (*) holder_pid="" ;;
    esac
    # python3 is already a hard dependency (the decision block); BSD/GNU stat
    # flag portability is not.
    mtime="$(python3 -c 'import os, sys; print(int(os.stat(sys.argv[1]).st_mtime))' "$dir" 2>/dev/null || true)"
    case "$mtime" in
      (<->) ;;
      (*) mtime=0 ;;
    esac
    age=$(( $(date +%s) - mtime ))
    if [ -n "$holder_pid" ]; then
      if kill -0 "$holder_pid" 2>/dev/null && [ "$age" -le "$stale_after" ]; then
        return 1
      fi
    elif [ "$age" -le "$stale_after" ]; then
      # No pid stamp yet: a racer may be mid-acquisition. Reclaim only aged.
      return 1
    fi
    log "reclaiming stale lock $dir (holder pid ${holder_pid:-none}, age ${age}s)"
    if ! mv "$dir" "$dir.reap.$$" 2>/dev/null; then
      continue
    fi
    rm -rf "$dir.reap.$$" 2>/dev/null || true
  done
  return 1
}

# #2515: the diagnostic health body is auth-gated; unauthenticated reads get
# the minimal public liveness envelope, whose missing whatsapp/turn_capability
# fields would read as restart-worthy (connected=false/state=None) and starve
# the CREDENTIAL-DEAD branch of turn_capability entirely. Send the instance
# bearer from tokens.env when one resolves; the token reaches curl argv only,
# never the log.
BOT_TOKENS_ENV="$HOME_DIR/.config/whatsoup/instances/BOT_NAME/tokens.env"
WHATSOUP_HEALTH_TOKEN=""
[ -r "$BOT_TOKENS_ENV" ] && WHATSOUP_HEALTH_TOKEN="$(sed -n 's/^WHATSOUP_HEALTH_TOKEN=//p' "$BOT_TOKENS_ENV" | head -1)"
AUTH_ARGS=()
[ -n "$WHATSOUP_HEALTH_TOKEN" ] && AUTH_ARGS=(-H "Authorization: Bearer $WHATSOUP_HEALTH_TOKEN")

# Single-instance lock: if another watchdog invocation is still running, exit
# — but say so in the log, and reclaim stale locks (a SIGKILLed prior run must
# not disable the watchdog forever).
if ! acquire_mutex "$LOCK" 600; then
  log "another watchdog invocation is running; exiting"
  exit 0
fi
trap 'rm -rf "$LOCK" 2>/dev/null || true' EXIT

# Rotate log if it exceeds 1 MB.
if [ -f "$LOG" ]; then
  size=$(wc -c < "$LOG" 2>/dev/null || echo 0)
  if [ "${size:-0}" -gt 1048576 ]; then
    tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
  fi
fi

# Final-log state ladder (upgrade-only). The last log line of each run is the
# single machine-readable outcome; a higher-priority state must not be
# overwritten by a later, lower-priority one (the fleet check runs after the
# bot check, and a credential verdict outranks a restart outcome). Strict >
# means equal-rank states keep the FIRST writer, so a bot restart outcome
# outranks a fleet one within the tier.
wd_rank() {
  case "$1" in
    CREDENTIAL-DEAD) print 4 ;;
    RESTARTED|RESTART-SUPPRESSED|RESTART-FAILED) print 3 ;;
    CREDENTIAL-UNKNOWN) print 2 ;;
    *) print 1 ;;
  esac
}
wd_note() {
  if [ "$(wd_rank "$1")" -gt "$(wd_rank "$WD_FINAL")" ]; then
    WD_FINAL="$1"
  fi
}

domain="gui/$(id -u)"

# Ensure a launchd job is loaded; bootstrap from its plist if not.
ensure_loaded() {
  local job_label="$1" plist="$2"
  if ! launchctl print "$domain/$job_label" >/dev/null 2>&1; then
    log "$job_label not loaded; bootstrapping"
    launchctl bootstrap "$domain" "$plist" >> "$LOG" 2>&1 || true
  fi
}

launchd_reports_permanent_stop() {
  local job_label="$1" launchd_state
  launchd_state="$(launchctl print "$domain/$job_label" 2>/dev/null)" || return 1
  print -r -- "$launchd_state" | awk '
    /^[[:space:]]*state[[:space:]]*=/ {
      state_count++
      state_value = $0
      sub(/^[^=]*=[[:space:]]*/, "", state_value)
      sub(/[[:space:]]*$/, "", state_value)
    }
    /^[[:space:]]*last exit (code|status)[[:space:]]*=/ {
      exit_count++
      exit_value = $0
      sub(/^[^=]*=[[:space:]]*/, "", exit_value)
      sub(/[[:space:]]*$/, "", exit_value)
    }
    END {
      if (state_count == 1 && state_value == "stopped" && exit_count == 1 && exit_value == "78") exit 0
      exit 1
    }
  '
}

# Restart a job with a 5-minute cooldown to avoid restart storms.
restart_label() {
  local job_label="$1" reason="$2"
  local stamp="$LOG_DIR/$job_label.last-restart"
  local rlock="$LOG_DIR/$job_label.restart.lock"
  local now last
  if launchd_reports_permanent_stop "$job_label"; then
    log "$job_label unhealthy but restart suppressed after permanent launchd exit code 78: $reason"
    wd_note RESTART-SUPPRESSED
    return 0
  fi
  # Serialize the cooldown-check/kickstart critical section per label: the
  # fleet console's label is shared by every bot watchdog on the host, and
  # same-cadence watchdogs would otherwise pass the cooldown check together
  # and double-kick it.
  if ! acquire_mutex "$rlock" 120; then
    log "$job_label restart already in progress by another watchdog; skipping"
    wd_note RESTART-SUPPRESSED
    return 0
  fi
  now=$(date +%s)
  last=0
  [ -r "$stamp" ] && last=$(cat "$stamp" 2>/dev/null || echo 0)
  case "$last" in
    (<->) ;;
    (*)
      log "ignoring unparseable restart cooldown stamp for $job_label"
      last=0
      ;;
  esac
  if [ $((now - last)) -lt 300 ]; then
    log "$job_label unhealthy but restart suppressed by cooldown: $reason"
    wd_note RESTART-SUPPRESSED
    rm -rf "$rlock" 2>/dev/null || true
    return 0
  fi
  log "restarting $job_label: $reason"
  if launchctl kickstart -k "$domain/$job_label" >> "$LOG" 2>&1; then
    wd_note RESTARTED
    # Arm the cooldown only for a restart that actually happened; a failed
    # kickstart must retry next cycle, not sit suppressed for 5 minutes.
    if ! print -- "$now" > "$stamp" 2>>"$LOG"; then
      log "ERROR: failed to write restart cooldown stamp for $job_label; cooldown not armed"
      WD_EXIT=1
    fi
  else
    log "ERROR: kickstart failed for $job_label; service was not restarted"
    wd_note RESTART-FAILED
    WD_EXIT=1
  fi
  rm -rf "$rlock" 2>/dev/null || true
}

ensure_loaded "$BOT_LABEL" "$BOT_PLIST"
ensure_loaded "$FLEET_LABEL" "$FLEET_PLIST"

# --- Bot health check ---
# Capture the body EVEN on an HTTP error status. A logged-out / terminally
# auth-failed bot returns HTTP 503 *with* a body carrying
# whatsapp.connection.auth_failure_class — `curl --fail` would discard that body
# and send us down the "unreachable" restart path, restart-looping a bot a
# restart cannot fix. So: no --fail; capture body + code; treat only a real
# TRANSPORT failure (no HTTP response at all) as unreachable, and let the
# decision block below act on the body (incl. the terminal-no-restart branch).
bot_resp="$(curl --silent --show-error --max-time 8 "${AUTH_ARGS[@]}" -w $'\n%{http_code}' "$BOT_HEALTH" 2>>"$LOG")"
curl_rc=$?
bot_code="${bot_resp##*$'\n'}"
bot_json="${bot_resp%$'\n'*}"
if [ "$curl_rc" -ne 0 ] || [ -z "$bot_code" ]; then
  restart_label "$BOT_LABEL" "health endpoint unreachable"
elif [ -z "$bot_json" ]; then
  restart_label "$BOT_LABEL" "empty health body (http=$bot_code)"
else
  BOT_JSON="$bot_json" BOT_CODE="$bot_code" python3 - <<'PY' 2>>"$LOG"
import datetime as dt
import json
import os
import sys

data = json.loads(os.environ["BOT_JSON"])
http_code = os.environ.get("BOT_CODE")
expected_instance_name = "BOT_NAME"
status = data.get("status")
service_mode = data.get("service_mode")
generated_at = data.get("generated_at")
# A truthy non-object instance is an unrecognized future shape: read nothing
# from it, and (below) never let it satisfy the recovery conjunction — a
# malformed shape must classify unknown, not crash into the restart path.
instance_raw = data.get("instance")
instance = instance_raw if isinstance(instance_raw, dict) else {}
instance_shape_valid = instance_raw is None or isinstance(instance_raw, dict)
whatsapp = data.get("whatsapp") or {}
conn = whatsapp.get("connection") or {}
connected = whatsapp.get("connected") is True
state = conn.get("state")
last_pong = conn.get("last_pong_at")
auth_failure_class = conn.get("auth_failure_class")
try:
    generated_time = dt.datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    generated_age = (dt.datetime.now(dt.timezone.utc) - generated_time).total_seconds()
    generated_is_fresh = -5 <= generated_age <= 60
except (AttributeError, TypeError, ValueError):
    generated_is_fresh = False

# A compatibility drain is a deliberate, health-visible stop before transport,
# recovery, providers, or timers exist. Restarting cannot make an older binary
# understand a future schema and must not auto-roll back a hot journal. Accept
# only the exact fail-closed body; a forged/partial mode still fails liveness.
if service_mode == "inspection_only":
    startup_block = data.get("startup_block") or {}
    sqlite = data.get("sqlite") or {}
    runtime = data.get("runtime") or {}
    runtime_agent = runtime.get("agent") or {}
    admission = data.get("admission") or {}
    reason = startup_block.get("code")
    latest = sqlite.get("schema_migration_latest")
    required = sqlite.get("schema_migration_required")
    required_is_valid = type(required) is int and required > 0
    migration_relationship_is_valid = (
        reason == "future_schema"
        and type(latest) is int
        and required_is_valid
        and latest > required
        and sqlite.get("sql_inspection_available") is True
    ) or (
        reason == "engine_recovery_required"
        and latest is None
        and required_is_valid
        and sqlite.get("sql_inspection_available") is False
    )
    exact_drain = (
        http_code == "503"
        and status == "unhealthy"
        and generated_is_fresh
        and instance.get("name") == expected_instance_name
        and type(instance.get("pid")) is int
        and instance.get("pid") > 0
        and instance.get("mode") == "inspection_only"
        and instance.get("socket_path") is None
        and reason in ("future_schema", "engine_recovery_required")
        and startup_block.get("retryable") is False
        and startup_block.get("operator_action_required") is True
        and sqlite.get("compatibility") == reason
        and sqlite.get("schema_ready") is False
        and sqlite.get("database_writes_allowed") is False
        and sqlite.get("artifact_inspection_available") is True
        and migration_relationship_is_valid
        and admission.get("provider_turns") == "blocked"
        and admission.get("synthetic_turns") == "blocked"
        and runtime_agent.get("started") is False
        and runtime_agent.get("admission") == "blocked"
        and runtime_agent.get("reason") == reason
        and "durability" in data
        and data.get("durability") is None
        and connected is False
        and whatsapp.get("account_jid") == "not connected"
        and state == "not_started"
        and conn.get("reconnect_phase") is None
        and type(conn.get("reconnect_attempts")) is int
        and conn.get("reconnect_attempts") == 0
        and conn.get("last_disconnect_reason") == "startup_schema_gate"
        and conn.get("last_status_code") is None
        and auth_failure_class == "none"
    )
    if exact_drain:
        # Accepted drains classify unknown-quiescent (exit 4): no restart,
        # credential marker retained — a drain carries no credential evidence.
        print(
            f"database compatibility drain reason={reason!r}: operator action required, not restarting",
            file=sys.stderr,
        )
        sys.exit(4)
    print("malformed database compatibility drain health body", file=sys.stderr)
    sys.exit(1)

# Terminal auth failures cannot be fixed by a restart — the bond is gone
# server-side (device_removed / 401), pairing is required, or the local auth
# store is unrestorably corrupt. Kicking the bot here only replays the
# cold-start burst against a dead bond every cooldown window (the restart-loop
# risk on a logged-out instance, e.g. ml-bot/mini8). Stop and wait for a human
# relink. The bot emits its own one-shot `whatsapp_device_bond_lost` critical
# alert at logout time, so the watchdog stays silent (no duplicate page) and
# simply declines to restart. Mirrors `authFailureIsUnhealthy` in
# src/core/health.ts; the class is surfaced at whatsapp.connection.auth_failure_class.
TERMINAL_AUTH_FAILURES = (
    "pairing_required",
    "serverside_logout_irreversible",
    "local_corruption_unrestorable",
)
if auth_failure_class in TERMINAL_AUTH_FAILURES:
    # Terminal transport-auth states classify unknown-quiescent (exit 4): no
    # restart, credential marker retained — a logout says nothing about the
    # provider credential.
    print(
        f"terminal auth_failure_class={auth_failure_class!r}: human relink required, not restarting",
        file=sys.stderr,
    )
    sys.exit(4)

STALE_PONG_SECONDS = 360
RECOVERING_STATES = ("connecting", "reconnecting", "cooldown")

# Parse the pong age once. `None` means absent; `pong_parse_failed` means a
# value was present but unparseable (fail closed — never silently pass).
pong_age = None
pong_parse_failed = False
if last_pong:
    try:
        parsed = dt.datetime.fromisoformat(str(last_pong).replace("Z", "+00:00"))
        pong_age = (dt.datetime.now(dt.timezone.utc) - parsed).total_seconds()
    except (ValueError, TypeError):
        pong_parse_failed = True

# A bot that is disconnected but actively *recovering* (connecting/reconnecting/
# cooldown) with FRESH liveness (a recent pong) is making progress on its own.
# Restarting it interrupts the reconnect, resets the cold-start clock, and (on
# agent bots) replays the startup notification — the self-sustaining restart
# loop observed on rb-bot/mini7. Such a bot is exempt from the connectivity
# triggers below; its only restart paths remain a stale pong or a hard status.
recovering_with_fresh_pong = (
    not connected
    and state in RECOVERING_STATES
    and pong_age is not None
    and not pong_parse_failed
    and pong_age <= STALE_PONG_SECONDS
)

reasons = []
# `degraded` is a soft signal (e.g. binary-model-probe-failed) that a restart
# cannot fix; restarting on it just resets the cold-start clock and re-fires the
# alert burst. Only a hard-down status warrants a restart here.
if status not in ("healthy", "degraded"):
    reasons.append(f"status={status!r}")
# Connectivity triggers — suppressed only while recovering with a fresh pong.
if not recovering_with_fresh_pong:
    if not connected:
        reasons.append("whatsapp.connected=false")
    if state != "connected":
        reasons.append(f"state={state!r}")
# A stale pong is an authoritative liveness failure regardless of state; a
# malformed pong fails closed and is treated as restart-worthy.
if pong_age is not None and pong_age > STALE_PONG_SECONDS:
    reasons.append(f"last_pong_age={pong_age:.0f}s")
elif pong_parse_failed:
    reasons.append("last_pong_unparseable")

if reasons:
    print("; ".join(reasons), file=sys.stderr)
    sys.exit(1)

# Provider credential state is evaluated only after liveness passes:
#   exit 3 — dead: a current normalized auth-required signal. A restart cannot
#       mint a credential (the 12-day mini11 outage logged "ok"); the shell
#       logs CREDENTIAL-DEAD and creates/retains the marker.
#   exit 0 — recovered: affirmative fresh primary proof. The ONLY exit that
#       clears the marker — absence of evidence is not recovery.
#   exit 4 — unknown, no fallback window active. Stderr-silent: a healthy idle
#       bot goes usability-stale within the 30-min probe TTL and a non-agent
#       instance has no turn_capability at all; both land here every cycle.
#   exit 5 — unknown while an independent fallback window is active
#       (fallbackReason non-null — presence, not value).
# Exits 4/5 never restart and never touch the marker; the shell ORs exit 5
# with marker presence to pick the CREDENTIAL-UNKNOWN final log state.
turn_capability_raw = data.get("turn_capability")
turn_capability = turn_capability_raw if isinstance(turn_capability_raw, dict) else {}
model_status = turn_capability.get("model_usability_status")
model_usable = turn_capability.get("model_usable")
model_usable_stale = turn_capability.get("model_usable_stale")
last_success = turn_capability.get("last_successful_turn_at")
last_error_class = turn_capability.get("last_turn_error_class")
last_error = turn_capability.get("last_turn_error_at")
fallback_reason = instance.get("fallbackReason")


def comparable_time(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


success_time = comparable_time(last_success)
error_time = comparable_time(last_error)
auth_error_superseded = (
    last_error_class == "auth-required"
    and success_time is not None
    and error_time is not None
    and success_time > error_time
)
auth_error_current = last_error_class == "auth-required" and not auth_error_superseded
credential_dead_signal = None
if model_status == "credential-unavailable":
    credential_dead_signal = "turn_capability.model_usability_status=credential-unavailable"
elif fallback_reason == "auth-required":
    credential_dead_signal = "instance.fallbackReason=auth-required"
elif auth_error_current:
    credential_dead_signal = (
        "turn_capability.last_turn_error_class=auth-required with no later successful turn"
    )
if credential_dead_signal:
    print(f"CREDENTIAL-DEAD: {credential_dead_signal} — reauth required", file=sys.stderr)
    sys.exit(3)

credential_recovered = (
    instance_shape_valid
    and model_usable is True
    and model_usable_stale is False
    and model_status == "usable"
    and fallback_reason is None
)
if credential_recovered:
    sys.exit(0)

if fallback_reason is not None:
    print(
        "CREDENTIAL-UNKNOWN: inconclusive credential evidence during an active "
        f"fallback window (fallbackReason={fallback_reason!r})",
        file=sys.stderr,
    )
    sys.exit(5)
sys.exit(4)
PY
  py_rc=$?
  if [ "$py_rc" -eq 3 ]; then
    # marker: BOT_NAME-credential-dead.marker — deliberately no restart on this
    # branch (a restart cannot fix auth; see the exit-3 decision-block comment).
    log "CREDENTIAL-DEAD: claude credential unavailable — reauth required; restart suppressed"
    if [ ! -e "$CRED_MARKER" ]; then
      if ! touch "$CRED_MARKER" 2>>"$LOG"; then
        # The verdict stands; the ERROR line and the nonzero invocation exit
        # carry the failure, and the next scheduled run retries the create.
        log "ERROR: failed to create credential marker $CRED_MARKER; retrying next cycle"
        WD_EXIT=1
      fi
    fi
    wd_note CREDENTIAL-DEAD
  elif [ "$py_rc" -eq 4 ] || [ "$py_rc" -eq 5 ]; then
    # Inconclusive credential evidence: never restart, never touch the marker.
    # Surface CREDENTIAL-UNKNOWN only when there is something to surface — a
    # retained marker or an active fallback window (exit 5). A quiescent
    # unknown (healthy idle bot past the usability-probe TTL, or a non-agent
    # instance with no turn_capability) stays "ok".
    if [ "$py_rc" -eq 5 ] || [ -e "$CRED_MARKER" ]; then
      wd_note CREDENTIAL-UNKNOWN
    fi
  elif [ "$py_rc" -ne 0 ]; then
    restart_label "$BOT_LABEL" "unhealthy JSON response"
  else
    if [ -e "$CRED_MARKER" ]; then
      if ! rm -f "$CRED_MARKER" 2>>"$LOG"; then
        # Recovery verdict stands (final state "ok"); the ERROR line and the
        # nonzero invocation exit carry the failure for the next cycle's retry.
        log "ERROR: failed to clear credential marker $CRED_MARKER; retrying next cycle"
        WD_EXIT=1
      fi
    fi
  fi
fi

# --- Fleet console health check ---
if ! curl --fail --silent --show-error --max-time 8 "$FLEET_HEALTH" >/dev/null 2>>"$LOG"; then
  restart_label "$FLEET_LABEL" "fleet console unreachable"
fi

log "$WD_FINAL"
exit "$WD_EXIT"
