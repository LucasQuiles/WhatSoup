#!/usr/bin/env bash
set -euo pipefail

# The job's own PATH as the service manager gave it, and the user-writable directories where
# harness binaries live. A --check run executes helpers only from the job's PATH with those
# directories (and empty or relative segments) removed, from its first command on, so nothing
# placed there can shadow a helper; harness binaries are still located there, by path only.
JOB_INHERITED_PATH="$PATH"
NPM_GLOBAL_PREFIX="${WHATSOUP_HARNESS_NPM_GLOBAL_PREFIX:-$HOME/.local/share/whatsoup/npm-global}"
NPM_GLOBAL_BIN_DIR="$NPM_GLOBAL_PREFIX/bin"
path_without_user_dirs() {
  local rest="$1:" segment out=""
  while [ -n "$rest" ]; do
    segment="${rest%%:*}"
    rest="${rest#*:}"
    case "$segment" in
      "$HOME/.local/bin"|"$HOME/.local/bin/"|"$NPM_GLOBAL_BIN_DIR"|"$NPM_GLOBAL_BIN_DIR/") continue ;;
      /*) out="${out:+$out:}$segment" ;;
    esac
  done
  printf '%s\n' "${out:-/usr/bin:/bin:/usr/sbin:/sbin}"
}
JOB_TOOL_PATH="$(path_without_user_dirs "$JOB_INHERITED_PATH")"
for arg in "$@"; do
  if [ "$arg" = --check ]; then
    export PATH="$JOB_TOOL_PATH"
  fi
done

# POSIX-portable symlink resolution (readlink -f is GNU-only, unavailable on macOS)
_resolve_symlinks() {
  local p="$1"
  while [ -L "$p" ]; do
    local dir="$(cd "$(dirname "$p")" && pwd)"
    p="$(readlink "$p")"
    [[ "$p" != /* ]] && p="$dir/$p"
  done
  echo "$(cd "$(dirname "$p")" && pwd)/$(basename "$p")"
}

SCRIPT_PATH="$(_resolve_symlinks "${BASH_SOURCE[0]}")"
REPO_ROOT="$(cd "$(dirname "$SCRIPT_PATH")/../.." && pwd)"
STATE_DIR="${WHATSOUP_HARNESS_MAINTENANCE_STATE_DIR:-$HOME/.cache/whatsoup/harness-maintenance}"
MANIFEST="${WHATSOUP_HARNESS_MAINTENANCE_MANIFEST:-$REPO_ROOT/deploy/managed-components.json}"
NPMRC_TEMPLATE="$REPO_ROOT/deploy/npmrc.hardened"
EVENTS_FILE=""
CHECK_ONLY=0
JSON_OUT=0
MODE="run"

usage() {
  cat <<'USAGE'
Usage: harness-maintenance.sh [--check] [--json]

  --check  Dry-run: validate, inventory, and report. Installs nothing, writes no
           configuration, sends no alert, and executes no harness binary.
  --json   Print final state JSON to stdout.
USAGE
}

# --check side-effect boundary (whole script; tested by
# tests/deploy/harness-maintenance-check-boundary.test.ts).
#
# Permitted inspection artifacts: the state directory with its state.json and
# run.log, and this run's temporary directory (removed on exit; npm's cache is
# pointed into it). Permitted commands: the pinned node running this repo's own
# scripts, plutil and read-only systemctl verbs (list-units, show-environment,
# show, is-active), read-only verbs of the pinned npm only (--version, config
# get, view, ls), apt list, ps (uid, elapsed time and executable name only),
# scripts/check-unit-drift.sh (file comparison only), and system helpers (awk,
# grep, mktemp, ...). Every command is taken from the job's own PATH with
# ~/.local/bin, the npm-global bin directory and relative segments removed, so
# nothing placed in those directories can shadow one. `npm view` reads the
# registry: a check run makes these read-only network requests, and npm sends
# any registry credentials ~/.npmrc holds with them. With the pinned npm absent,
# the npm checks are skipped and reported unknown.
#
# Not permitted: any install or dry-run install, the npmrc merge or backup, an
# alert, any npm other than the pinned one, and executing any harness or
# wrapper binary found on a PATH (the agent CLI, including its plugin and MCP
# listings, which can refresh MCP authentication; codex; opencode; local MCP
# binaries; runtime --version probes). Versions of npm-installed harnesses are
# read from package metadata; anything else is reported by path only.

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check)
      CHECK_ONLY=1
      MODE="check"
      shift
      ;;
    --json)
      JSON_OUT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
RUN_LOG="$STATE_DIR/run.log"
TMP_DIR="$(mktemp -d)"
EVENTS_FILE="$TMP_DIR/events.ndjson"
STATE_TMP="$TMP_DIR/state.json"
STATE_FILE="$STATE_DIR/state.json"
touch "$EVENTS_FILE"
if [ "$CHECK_ONLY" -eq 1 ]; then
  # Even read-only npm verbs fill npm's cache; a check run keeps that write in
  # its own temporary directory.
  export npm_config_cache="$TMP_DIR/npm-cache"
fi

NVMRC_NODE_VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc")"
# Reuse the deploy wrapper's Node compatibility gate so the maintenance harness
# cannot silently run TypeScript guards under an unsupported PATH node.
# shellcheck source=deploy/lib/resolve-node.sh
. "$REPO_ROOT/deploy/lib/resolve-node.sh"
DEFAULT_REPO_NODE_BIN="$HOME/.nvm/versions/node/v$NVMRC_NODE_VERSION/bin/node"
REPO_NODE_BIN="${WHATSOUP_NODE_BIN:-$DEFAULT_REPO_NODE_BIN}"
REPO_NODE_BIN_SOURCE="pinned"
if [ -n "${WHATSOUP_NODE_BIN:-}" ]; then
  REPO_NODE_BIN_SOURCE="env"
elif [ ! -x "$REPO_NODE_BIN" ]; then
  PATH_NODE_BIN="$(command -v node || true)"
  if [ -n "$PATH_NODE_BIN" ]; then
    REPO_NODE_BIN="$PATH_NODE_BIN"
    REPO_NODE_BIN_SOURCE="path"
    echo "WARN: pinned node v${NVMRC_NODE_VERSION} not found; using PATH node $REPO_NODE_BIN for harness maintenance" | tee -a "$RUN_LOG" >&2
  fi
fi
if ! whatsoup_validate_node_compatibility "$REPO_ROOT" "$REPO_NODE_BIN"; then
  echo "FATAL: Node is required to run harness maintenance guards" >&2
  exit 1
fi
if [ "$REPO_NODE_BIN_SOURCE" = "path" ] && ! whatsoup_check_node_pin "$REPO_ROOT" "$REPO_NODE_BIN"; then
  echo "WARN: resolved PATH Node major differs from .nvmrc pin; install v${NVMRC_NODE_VERSION} to remove fallback" | tee -a "$RUN_LOG" >&2
fi

CODX_NODE_BIN_DIR="${WHATSOUP_CODEX_NODE_BIN_DIR:-$HOME/.nvm/versions/node/v$NVMRC_NODE_VERSION/bin}"
ALERT_BIN="${WHATSOUP_ALERT_BIN:-$HOME/.local/bin/whatsapp-alert}"
PROBE_TIMEOUT_SECS="${WHATSOUP_HARNESS_MAINTENANCE_PROBE_TIMEOUT_SECS:-10}"
PROBE_OUTPUT_LINES="${WHATSOUP_HARNESS_MAINTENANCE_PROBE_OUTPUT_LINES:-200}"
REPO_NODE_BIN_DIR="$(dirname "$REPO_NODE_BIN")"
# Where a normal run looks for harness binaries: the npm-global and user bin directories first.
# A normal run also executes from it; --check only locates on it (harness_which) and keeps
# executing from JOB_TOOL_PATH. JOB_TOOL_PATH also locates service-manager and system tools
# (job_tool), never a service instance's PATH: an instance runs with its own service
# definition's PATH, not this job's.
HARNESS_PATH="$NPM_GLOBAL_BIN_DIR:$HOME/.local/bin:$REPO_NODE_BIN_DIR:$JOB_INHERITED_PATH"
if [ "$CHECK_ONLY" -eq 0 ]; then
  export PATH="$HARNESS_PATH"
fi
# The native installer's own launcher link. It is updated only when every
# service instance on this host resolves exactly this path (see
# claude_service_inventory); any other layout or pin holds the update.
CLAUDE_NATIVE_LAUNCHER="$HOME/.local/bin/claude"
# Files shared between steps (each step runs in a subshell). The instance environment file holds
# one line per inventoried instance and is rewritten by every inventory pass; it is absent when
# the service manager could not be read. The start file holds the launcher's facts before any step.
CLAUDE_INSTANCE_ENV_FILE="$TMP_DIR/claude-instance-env"
CLAUDE_LAUNCHER_START_FILE="$TMP_DIR/claude-launcher.start"
case "$(uname -s)" in
  Darwin) SERVICE_MANAGER_DEFAULT=launchd ;;
  *) SERVICE_MANAGER_DEFAULT=systemd ;;
esac
SERVICE_MANAGER="${WHATSOUP_HARNESS_SERVICE_MANAGER:-$SERVICE_MANAGER_DEFAULT}"
# shellcheck source=deploy/lib/runtime-path.sh
. "$REPO_ROOT/deploy/lib/runtime-path.sh"
# shellcheck source=deploy/lib/step-runner.sh
. "$REPO_ROOT/deploy/lib/step-runner.sh"
# External calls that can hang (registry lookups, the installer, a version
# probe) run under the repo's portable supervisor: stock macOS has no
# timeout(1), and the launchd job must not depend on one being installed.
# shellcheck source=deploy/lib/bounded-exec.sh
. "$REPO_ROOT/deploy/lib/bounded-exec.sh"
LOOKUP_TIMEOUT_SECS="${WHATSOUP_HARNESS_MAINTENANCE_LOOKUP_TIMEOUT_SECS:-120}"
INSTALL_TIMEOUT_SECS="${WHATSOUP_HARNESS_MAINTENANCE_INSTALL_TIMEOUT_SECS:-600}"
VERSION_TIMEOUT_SECS="${WHATSOUP_HARNESS_MAINTENANCE_VERSION_TIMEOUT_SECS:-30}"
STATE_WRITTEN=0

log() {
  echo "[harness-maintenance] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$RUN_LOG" >&2
}

json_escape_event() {
  "$REPO_NODE_BIN" - "$EVENTS_FILE" "$1" "$2" "$3" "${4:-}" "${5:-}" "${6:-}" <<'NODE'
const fs = require('node:fs');
const [eventsPath, component, status, message, before, after, target] = process.argv.slice(2);
fs.appendFileSync(eventsPath, `${JSON.stringify({
  at: new Date().toISOString(),
  component,
  status,
  message,
  before: before || undefined,
  after: after || undefined,
  target: target || undefined,
})}\n`);
NODE
}

record_event() {
  json_escape_event "$@"
  log "$1 [$2] $3"
}

# Returns nonzero instead of exiting so the caller can surface a failed write on
# its own. Each step checks its status explicitly because callers run it in a
# tested context, where errexit does not apply.
write_state() {
  local status="$1"
  rm -f "$STATE_TMP" || return 1
  "$REPO_NODE_BIN" - "$EVENTS_FILE" "$STATE_TMP" "$status" "$MODE" <<'NODE' || return 1
const fs = require('node:fs');
const [eventsPath, outPath, status, mode] = process.argv.slice(2);
const lines = fs.readFileSync(eventsPath, 'utf8').split(/\n/).filter(Boolean);
const events = lines.map((line) => JSON.parse(line));
const state = {
  schema_version: 1,
  run_at: new Date().toISOString(),
  mode,
  status,
  event_count: events.length,
  events,
};
fs.writeFileSync(outPath, `${JSON.stringify(state, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600,
});
NODE
  if [ -L "$STATE_FILE" ]; then
    echo "harness maintenance state target is a symlink; refusing to overwrite: $STATE_FILE" >&2
    rm -f "$STATE_TMP"
    return 1
  fi
  mv "$STATE_TMP" "$STATE_FILE" || return 1
  chmod 600 "$STATE_FILE" || return 1
  if [ "$JSON_OUT" -eq 1 ]; then
    cat "$STATE_FILE" || return 1
  fi
}

# finalize_state <status>: the one final state write for a run. A failed write
# is reported separately (log line and alert), so it can never pass for the
# run's own outcome.
finalize_state() {
  local status="$1" rc=0
  STATE_WRITTEN=1
  write_state "$status" || rc=$?
  if [ "$rc" -ne 0 ]; then
    log "state write failed rc=$rc for status=$status: $STATE_FILE"
    send_alert "job" "critical" "Harness maintenance state write failed" "The final status '$status' could not be written (rc=$rc). See $RUN_LOG"
    return 1
  fi
}

# send_alert <slug> <severity> <summary> <evidence>
#
# The <slug> namespaces the alert under a per-condition incident source
# ("harness-maintenance:<slug>"). Distinct operations (claude-update,
# codex-update, codex-cooldown-defense, job, ...) get distinct incident keys so
# a benign info notification (e.g. "Claude harness updated") can never be
# mutated into a persistent warn by an unrelated condition that fired in the
# same run (e.g. "Codex held by npm cooldown"). Previously every condition
# shared the flat "harness-maintenance" source, so the existing-incident repeat
# path in whatsapp-alert.sh collapsed them onto one key — flipping a transient
# info incident to persistent warn that could never auto-expire, then escalating
# daily. Slugging by operation (not by message) preserves correct intra-operation
# escalation: info "updated" and critical "rollback" for the SAME tool still
# share a key and escalate as intended. The "harness-maintenance:" prefix keeps
# prefix-based filtering and grouping intact for any human/dashboard consumer.
send_alert() {
  local slug="$1"
  local severity="$2"
  local summary="$3"
  local evidence="$4"
  if [ "$CHECK_ONLY" -eq 1 ]; then
    return 0
  fi
  if [ -x "$ALERT_BIN" ]; then
    "$ALERT_BIN" \
      --instance q \
      --source "harness-maintenance:$slug" \
      --severity "$severity" \
      --summary "$summary" \
      --evidence "$evidence" >/dev/null 2>&1 || true
  fi
}

# A failure outside any step (the steps run under whatsoup_run_step).
on_error() {
  local rc=$?
  trap - ERR
  record_event "harness-maintenance" "failed" "unexpected failure rc=$rc" || true
  if [ "$STATE_WRITTEN" -eq 0 ]; then
    finalize_state "failed" || true
  fi
  send_alert "job" "warning" "Harness maintenance failed" "Unexpected failure rc=$rc. See $RUN_LOG"
  exit "$rc"
}

# Any exit that reaches here without a final state (an explicit exit, a signal)
# still records one before the temporary directory goes away.
on_exit() {
  local rc=$?
  trap - ERR
  if [ "$STATE_WRITTEN" -eq 0 ]; then
    record_event "harness-maintenance" "failed" "exited before writing a final state rc=$rc" || true
    finalize_state "failed" || true
  fi
  rm -rf "$TMP_DIR"
}
trap on_error ERR
trap on_exit EXIT

parse_version() {
  grep -Eo '[0-9]+(\.[0-9]+){1,2}([-+._a-zA-Z0-9]*)?' | head -n 1
}

command_version() {
  local cmd="$1"
  shift
  if ! command -v "$cmd" >/dev/null 2>&1; then
    return 1
  fi
  "$cmd" "$@" 2>/dev/null | parse_version
}

# path_first_executable <PATH> <name>: print the first "<segment>/<name>" that is an executable
# regular file, as exec(3) PATH search would pick it, without running anything. Returns 1 when no
# segment has one and 2 when an empty or relative segment comes first: such a segment resolves
# against the service's working directory, which cannot be known statically.
path_first_executable() {
  local rest="$1:" name="$2" segment
  while [ -n "$rest" ]; do
    segment="${rest%%:*}"
    rest="${rest#*:}"
    case "$segment" in
      /*) ;;
      *) return 2 ;;
    esac
    if [ -f "$segment/$name" ] && [ -x "$segment/$name" ]; then
      printf '%s\n' "$segment/$name"
      return 0
    fi
  done
  return 1
}

# Service-manager and system tools come from the job's inherited PATH without the user-writable
# harness directories, never from the harness PATH, so nothing placed there can shadow them.
job_tool() {
  path_first_executable "$JOB_TOOL_PATH" "$1"
}

# harness_which <name>: the path a harness binary resolves to on the harness PATH, without running
# it. Check mode executes nothing from there, so it looks the binary up statically.
harness_which() {
  if [ "$CHECK_ONLY" -eq 1 ]; then
    path_first_executable "$HARNESS_PATH" "$1" || true
  else
    command -v "$1" || true
  fi
}

# --- Per-instance agent CLI resolution -------------------------------------------------------
#
# Every WhatSoup instance launches through deploy/whatsoup, which composes its PATH with
# whatsoup_effective_runtime_path from the service definition's own PATH and
# WHATSOUP_PATH_PREPEND. The binary an instance spawns is therefore the first executable
# `claude` on THAT path. It is found here without executing anything and classified with the
# guard's static --claude-resolve mode. Anything that cannot be determined is "unknown".

CLAUDE_CONSUMERS_FILE=""

# claude_consumer_record <name> <manager> <status> <bin> <kind> <version> <detail>
claude_consumer_record() {
  printf '%s\037%s\037%s\037%s\037%s\037%s\n' "$1" "$2" "$3" "$4" "$5" "$6" >> "$CLAUDE_CONSUMERS_FILE"
  case "$3" in
    resolved) record_event "claude-consumer" "resolved" "$1 via $2: $4 ($5${6:+ $6})" "" "" "" ;;
    *) record_event "claude-consumer" "$3" "$1 via $2: $7" ;;
  esac
}

# Stands for a variable that is not set at all, as opposed to one set to an empty value.
UNSET_MARK=$'\001unset'

# flag_class <value or UNSET_MARK or "?">: unset, set (only "1" or "true", any case), "?" (not
# readable), or set-unrecognized for any other value, including "0" and empty. Values themselves
# are never recorded.
flag_class() {
  local lower
  case "$1" in
    "$UNSET_MARK") echo unset ;;
    "?") echo "?" ;;
    *)
      lower="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
      case "$lower" in
        1|true) echo set ;;
        *) echo set-unrecognized ;;
      esac ;;
  esac
}

# claude_instance_env_record <name> <manager> <surface> <config dir> <DISABLE_UPDATES> <DISABLE_AUTOUPDATER>
# Observation only (see observe_claude_update_policy). Pass UNSET_MARK for an unset flag and "?"
# in every value field when the service environment could not be read.
claude_instance_env_record() {
  local config="$4"
  case "$config" in *$'\n'*|*$'\037'*) config="?" ;; esac
  printf '%s\037%s\037%s\037%s\037%s\037%s\n' "$1" "$2" "$3" "$config" "$(flag_class "$5")" "$(flag_class "$6")" \
    >> "$CLAUDE_INSTANCE_ENV_FILE"
}

# plist_flag <file> <key>: the value of an EnvironmentVariables entry, or UNSET_MARK when absent.
plist_flag() {
  plist_string "$1" "EnvironmentVariables.$2" || printf '%s' "$UNSET_MARK"
}

# claude_resolve_consumer <name> <manager> <inherited PATH> <prepend> <node>
claude_resolve_consumer() {
  local name="$1" manager="$2" inherited="$3" prepend="$4" node="$5"
  local composed bin rc classification kind version
  if [ -z "$inherited" ]; then
    claude_consumer_record "$name" "$manager" unknown "" "" "" "service definition sets no PATH"
    return 0
  fi
  [ -n "$node" ] || node="$HOME/.nvm/versions/node/v$NVMRC_NODE_VERSION/bin/node"
  if [ ! -x "$node" ]; then
    claude_consumer_record "$name" "$manager" unknown "" "" "" "launcher node $node is not executable"
    return 0
  fi
  rc=0
  composed="$(whatsoup_effective_runtime_path "$HOME" "$node" "$inherited" "$prepend" 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$composed" ]; then
    claude_consumer_record "$name" "$manager" unknown "" "" "" "runtime PATH composition rejected the service PATH or prepend"
    return 0
  fi
  rc=0
  bin="$(path_first_executable "$composed" claude)" || rc=$?
  case "$rc" in
    0) ;;
    1)
      claude_consumer_record "$name" "$manager" missing "" "" "" "no executable claude on the service PATH"
      return 0 ;;
    *)
      claude_consumer_record "$name" "$manager" unknown "" "" "" "service PATH has a relative segment before any claude"
      return 0 ;;
  esac
  rc=0
  classification="$(claude_classify "$bin")" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$classification" ]; then
    claude_consumer_record "$name" "$manager" unknown "$bin" "" "" "static classification of $bin failed"
    return 0
  fi
  kind="${classification%%$'\t'*}"
  version="${classification#*$'\t'}"
  claude_consumer_record "$name" "$manager" resolved "$bin" "$kind" "$version" ""
}

# claude_classify <abs path>: print "<kind>\t<configuredVersion>" from the static classifier.
claude_classify() {
  local out rc=0
  out="$("$REPO_NODE_BIN" --experimental-strip-types "$REPO_ROOT/scripts/harness-maintenance-guard.ts" \
    --claude-resolve --bin "$1" --home "$HOME" 2>/dev/null)" || rc=$?
  [ "$rc" -eq 0 ] || return 1
  # shellcheck disable=SC2016 # a JavaScript program; ${...} is a JS template, not shell.
  printf '%s' "$out" | "$REPO_NODE_BIN" -e '
let s = "";
process.stdin.on("data", (d) => { s += d; }).on("end", () => {
  const r = JSON.parse(s);
  if (typeof r.kind !== "string") process.exit(1);
  process.stdout.write(`${r.kind}\t${typeof r.configuredVersion === "string" ? r.configuredVersion : ""}`);
});'
}

# plist_string <file> <key path>: 0 and the value when present, 1 when absent or not a string.
plist_string() {
  "$PLUTIL_BIN" -extract "$2" raw -o - "$1" 2>/dev/null
}

# What a plist read with plutil shows: the environment of the next launch. The loaded job's
# environment would need `launchctl print`, which prints every value, so it is not read.
LAUNCHD_ENV_SURFACE="next launch; loaded job environment not read"

# release_wrapper_mismatch <argv0>: 0 when <argv0> is a release's deploy/whatsoup whose wrapper and
# PATH composition are byte-identical to this checkout's, so an instance started through it resolves
# the agent CLI exactly as claude_resolve_consumer computes. Otherwise 1 with the reason on stdout.
release_wrapper_mismatch() {
  local wrapper="$1" root
  case "$wrapper" in
    /*/deploy/whatsoup) ;;
    *)
      echo "instance runs $wrapper, which is neither the installed wrapper nor a release wrapper"
      return 1 ;;
  esac
  root="${wrapper%/deploy/whatsoup}"
  if [ ! -f "$wrapper" ] || ! cmp -s "$wrapper" "$REPO_ROOT/deploy/whatsoup" \
    || ! cmp -s "$root/deploy/lib/runtime-path.sh" "$REPO_ROOT/deploy/lib/runtime-path.sh"; then
    echo "instance runs release wrapper $wrapper, which is missing or differs from this checkout, so its PATH composition cannot be verified"
    return 1
  fi
}

claude_inventory_launchd() {
  local dir="$HOME/Library/LaunchAgents" file name label program arg1 path_value prepend node reason
  PLUTIL_BIN="$(job_tool plutil)" || {
    echo "plutil not found on the job PATH"
    return 1
  }
  for file in "$dir"/com.whatsoup.*.plist; do
    [ -e "$file" ] || continue
    name="${file##*/com.whatsoup.}"
    name="${name%.plist}"
    if ! "$PLUTIL_BIN" -lint "$file" >/dev/null 2>&1; then
      claude_consumer_record "$name" launchd unknown "" "" "" "$file is not a readable property list"
      claude_instance_env_record "$name" launchd "$LAUNCHD_ENV_SURFACE" "?" "?" "?"
      continue
    fi
    label="$(plist_string "$file" Label || true)"
    program="$(plist_string "$file" ProgramArguments.0 || true)"
    arg1="$(plist_string "$file" ProgramArguments.1 || true)"
    # An instance is identified by its label and instance-name argument, whatever it executes: the
    # release activation can point ProgramArguments[0] at a release's own wrapper. Other
    # com.whatsoup jobs (maintenance timers, watchdogs) do not pass their own name and are skipped.
    if [ "$label" != "com.whatsoup.$name" ] || [ "$arg1" != "$name" ]; then
      record_event "claude-consumer" "skipped" "${file##*/} is not an instance plist (label or instance argument differs)"
      continue
    fi
    path_value="$(plist_string "$file" EnvironmentVariables.PATH || true)"
    prepend="$(plist_string "$file" EnvironmentVariables.WHATSOUP_PATH_PREPEND || true)"
    node="$(plist_string "$file" EnvironmentVariables.WHATSOUP_NODE || true)"
    claude_instance_env_record "$name" launchd "$LAUNCHD_ENV_SURFACE" \
      "$(plist_string "$file" EnvironmentVariables.CLAUDE_CONFIG_DIR || true)" \
      "$(plist_flag "$file" DISABLE_UPDATES)" \
      "$(plist_flag "$file" DISABLE_AUTOUPDATER)"
    if [ "$program" != "$HOME/.local/bin/whatsoup" ] && ! reason="$(release_wrapper_mismatch "$program")"; then
      claude_consumer_record "$name" launchd unknown "" "" "" "$reason"
      continue
    fi
    claude_resolve_consumer "$name" launchd "$path_value" "$prepend" "$node"
  done
}

# systemd_assign <KEY=VALUE>: fold one assignment into SYSTEMD_ENV_*; returns 1 on a value this
# reader will not interpret (quotes, escapes, expansions).
systemd_assign() {
  local key="${1%%=*}" value="${1#*=}"
  case "$1" in *=*) ;; *) return 1 ;; esac
  case "$key" in
    PATH|WHATSOUP_PATH_PREPEND|WHATSOUP_NODE) ;;
    # Observed keys: only whether they are set matters, so a quoted value never makes the unit
    # unreadable; a config directory that cannot be read literally is recorded as "?".
    DISABLE_UPDATES) SYSTEMD_ENV_UPDATES="$value"; return 0 ;;
    DISABLE_AUTOUPDATER) SYSTEMD_ENV_AUTOUPDATER="$value"; return 0 ;;
    CLAUDE_CONFIG_DIR)
      case "$value" in
        *\"*|*\'*|*\\*|*\$*|*\`*) SYSTEMD_ENV_CONFIG="?" ;;
        *) SYSTEMD_ENV_CONFIG="$value" ;;
      esac
      return 0 ;;
    *) return 0 ;;
  esac
  case "$value" in
    *\"*|*\'*|*\\*|*\$*|*\`*) return 1 ;;
  esac
  case "$key" in
    PATH) SYSTEMD_ENV_PATH="$value" ;;
    WHATSOUP_PATH_PREPEND) SYSTEMD_ENV_PREPEND="$value" ;;
    WHATSOUP_NODE) SYSTEMD_ENV_NODE="$value" ;;
  esac
}

# systemd_unit_environment <show output>: apply Environment= then EnvironmentFiles= (which
# override it), after the manager environment already loaded by the caller.
systemd_unit_environment() {
  local line value token file flags
  while IFS= read -r line; do
    case "$line" in
      Environment=*)
        value="${line#Environment=}"
        case "$value" in *\"*|*\'*|*\\*) return 1 ;; esac
        set -f
        for token in $value; do
          systemd_assign "$token" || { set +f; return 1; }
        done
        set +f ;;
    esac
  done <<< "$1"
  while IFS= read -r line; do
    case "$line" in
      EnvironmentFiles=?*)
        value="${line#EnvironmentFiles=}"
        file="${value%% (*}"
        flags="${value#"$file"}"
        if [ ! -e "$file" ]; then
          case "$flags" in *ignore_errors=yes*) continue ;; esac
          return 1
        fi
        [ -f "$file" ] && [ -r "$file" ] || return 1
        systemd_environment_file "$file" || return 1 ;;
    esac
  done <<< "$1"
}

systemd_environment_file() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    # systemd ignores leading whitespace on an assignment line.
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in
      PATH=*|WHATSOUP_PATH_PREPEND=*|WHATSOUP_NODE=*) ;;
      DISABLE_UPDATES=*|DISABLE_AUTOUPDATER=*|CLAUDE_CONFIG_DIR=*) ;;
      *) continue ;;
    esac
    systemd_assign "$line" || return 1
  done < "$1"
}

claude_inventory_systemd() {
  local units unit name show manager_env manager_unreadable rc=0
  SYSTEMCTL_BIN="$(job_tool systemctl)" || {
    echo "systemctl not found on the job PATH"
    return 1
  }
  units="$("$SYSTEMCTL_BIN" --user list-units --all --type=service --no-legend --plain 'whatsoup@*.service' 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "systemctl list-units failed rc=$rc"
    return 1
  fi
  rc=0
  manager_env="$("$SYSTEMCTL_BIN" --user show-environment 2>/dev/null)" || rc=$?
  while IFS= read -r unit; do
    unit="${unit%% *}"
    case "$unit" in
      whatsoup@?*.service) ;;
      *) continue ;;
    esac
    name="${unit#whatsoup@}"
    name="${name%.service}"
    SYSTEMD_ENV_PATH="" SYSTEMD_ENV_PREPEND="" SYSTEMD_ENV_NODE=""
    SYSTEMD_ENV_UPDATES="$UNSET_MARK" SYSTEMD_ENV_AUTOUPDATER="$UNSET_MARK" SYSTEMD_ENV_CONFIG=""
    # Same precedence as the launcher composes (deploy/lib/runtime-path.sh): the user manager
    # environment first, then Environment=, then EnvironmentFiles=. A manager value this reader
    # cannot interpret, or a manager environment that cannot be read, makes the instance unknown:
    # a dropped prepend would hide a pin.
    manager_unreadable=0
    [ "$rc" -eq 0 ] || manager_unreadable=1
    if [ "$rc" -eq 0 ]; then
      while IFS= read -r line; do
        case "$line" in
          PATH=*|WHATSOUP_PATH_PREPEND=*|WHATSOUP_NODE=*) systemd_assign "$line" || manager_unreadable=1 ;;
          DISABLE_UPDATES=*|DISABLE_AUTOUPDATER=*|CLAUDE_CONFIG_DIR=*) systemd_assign "$line" || true ;;
        esac
      done <<< "$manager_env"
    fi
    if [ "$manager_unreadable" -eq 1 ]; then
      claude_consumer_record "$name" systemd unknown "" "" "" "user manager environment is not statically readable"
      claude_instance_env_record "$name" systemd "loaded unit" "?" "?" "?"
      continue
    fi
    if ! show="$("$SYSTEMCTL_BIN" --user show -p Environment -p EnvironmentFiles "$unit" 2>/dev/null)"; then
      claude_consumer_record "$name" systemd unknown "" "" "" "systemctl show failed for $unit"
      claude_instance_env_record "$name" systemd "loaded unit" "?" "?" "?"
      continue
    fi
    if ! systemd_unit_environment "$show"; then
      claude_consumer_record "$name" systemd unknown "" "" "" "unit environment for $unit is not statically readable"
      claude_instance_env_record "$name" systemd "loaded unit" "?" "?" "?"
      continue
    fi
    # `systemctl show` reports the unit as loaded, which is also its next launch unless the unit
    # file changed without a daemon-reload.
    claude_instance_env_record "$name" systemd "loaded unit" \
      "$SYSTEMD_ENV_CONFIG" "$SYSTEMD_ENV_UPDATES" "$SYSTEMD_ENV_AUTOUPDATER"
    claude_resolve_consumer "$name" systemd "$SYSTEMD_ENV_PATH" "$SYSTEMD_ENV_PREPEND" "$SYSTEMD_ENV_NODE"
  done <<< "$units"
}

# claude_service_inventory: fill CLAUDE_CONSUMERS_FILE with one line per instance
# (name, manager, status, bin, kind, configured version). Returns 1 with a reason on stdout when
# the service manager itself cannot be read; zero instances is a successful empty inventory.
claude_service_inventory() {
  local rc=0
  : > "$CLAUDE_INSTANCE_ENV_FILE"
  case "$SERVICE_MANAGER" in
    launchd) claude_inventory_launchd || rc=$? ;;
    systemd) claude_inventory_systemd || rc=$? ;;
    *)
      echo "unsupported service manager: $SERVICE_MANAGER"
      rc=1 ;;
  esac
  # An unreadable service manager is not an empty inventory.
  [ "$rc" -eq 0 ] || rm -f "$CLAUDE_INSTANCE_ENV_FILE"
  return "$rc"
}

codex_bin() {
  if [ -x "$CODX_NODE_BIN_DIR/codex" ]; then
    echo "$CODX_NODE_BIN_DIR/codex"
  else
    harness_which codex
  fi
}

# npm_bin: the pinned npm, or in a normal run the first npm on the PATH. Check mode runs no npm
# but the pinned one (see npm_skipped_in_check).
npm_bin() {
  if [ -x "$CODX_NODE_BIN_DIR/npm" ]; then
    echo "$CODX_NODE_BIN_DIR/npm"
  elif [ "$CHECK_ONLY" -eq 0 ]; then
    command -v npm || true
  fi
}

# npm_skipped_in_check <component>: 0, with an unknown event, when this is a check run and the
# pinned npm is absent; the caller then skips its npm checks.
npm_skipped_in_check() {
  if [ "$CHECK_ONLY" -eq 0 ] || [ -x "$CODX_NODE_BIN_DIR/npm" ]; then
    return 1
  fi
  record_event "$1" "unknown" "npm checks skipped: the pinned npm $CODX_NODE_BIN_DIR/npm is absent, and check mode runs no other npm"
}

# npm_package_version <bin> <package>: print the version from the package.json of <package> that
# contains the resolved <bin>, without executing anything. Returns 1 when <bin> does not resolve
# into that package (a native or hand-installed binary).
npm_package_version() {
  "$REPO_NODE_BIN" - "$1" "$2" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [bin, name] = process.argv.slice(2);
let dir;
try { dir = path.dirname(fs.realpathSync(bin)); } catch { process.exit(1); }
for (;;) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg && pkg.name === name && typeof pkg.version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(pkg.version)) {
      process.stdout.write(pkg.version);
      process.exit(0);
    }
  } catch {}
  const parent = path.dirname(dir);
  if (parent === dir) process.exit(1);
  dir = parent;
}
NODE
}

codex_current() {
  local bin
  bin="$(codex_bin)"
  if [ -z "$bin" ]; then
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    npm_package_version "$bin" @openai/codex || true
    return 0
  fi
  CODEX_NO_DEFAULTS=1 "$bin" --version 2>/dev/null | parse_version
}

opencode_bin() {
  if [ -x "$NPM_GLOBAL_BIN_DIR/opencode" ]; then
    echo "$NPM_GLOBAL_BIN_DIR/opencode"
  else
    harness_which opencode
  fi
}

opencode_current() {
  local bin
  bin="$(opencode_bin)"
  if [ -z "$bin" ]; then
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    npm_package_version "$bin" opencode-ai || true
    return 0
  fi
  "$bin" --version 2>/dev/null | parse_version
}

smoke_codex() {
  local bin
  bin="$(codex_bin)"
  [ -n "$bin" ] && CODEX_NO_DEFAULTS=1 "$bin" --version >/dev/null 2>&1
}

smoke_opencode() {
  local bin
  bin="$(opencode_bin)"
  [ -n "$bin" ] && "$bin" --version >/dev/null 2>&1
}

apply_npmrc() {
  if [ "$CHECK_ONLY" -eq 1 ]; then
    record_event "npmrc" "checked" "hardened npmrc would be applied from deploy/npmrc.hardened"
    return 0
  fi
  if [ -f "$HOME/.npmrc" ] && ! cmp -s "$NPMRC_TEMPLATE" "$HOME/.npmrc"; then
    local backup
    backup="$HOME/.npmrc.whatsoup-backup-$(date -u +%Y%m%dT%H%M%SZ)"
    cp "$HOME/.npmrc" "$backup"
    record_event "npmrc" "backup" "existing ~/.npmrc backed up" "$HOME/.npmrc" "$backup"
  fi
  "$REPO_NODE_BIN" --experimental-strip-types "$REPO_ROOT/scripts/npmrc-merge.ts" \
    "$NPMRC_TEMPLATE" "$HOME/.npmrc"
  record_event "npmrc" "applied" "hardened npm settings merged"
}

guard_manifest() {
  "$REPO_NODE_BIN" --experimental-strip-types "$REPO_ROOT/scripts/harness-maintenance-guard.ts" \
    --manifest "$MANIFEST" >/dev/null
  record_event "manifest" "ok" "managed components manifest validated"
}

manifest_npm_cooldown_minutes() {
  "$REPO_NODE_BIN" - "$MANIFEST" <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(String(manifest.npm.cooldown_minutes));
NODE
}

manifest_npmrc_min_release_age_days() {
  "$REPO_NODE_BIN" - "$MANIFEST" <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(String(manifest.npm.npmrc_min_release_age_days));
NODE
}

manifest_codex_npm_min_version() {
  "$REPO_NODE_BIN" - "$MANIFEST" <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(String(manifest.npm.codex_node.npm_min_version));
NODE
}

check_codex_npm_cooldown() {
  local npm
  if npm_skipped_in_check codex-npm-cooldown; then
    return 0
  fi
  npm="$(npm_bin)"
  if [ -z "$npm" ]; then
    record_event "codex-npm-cooldown" "missing" "npm not found for Codex node"
    send_alert "codex-cooldown-defense" "warning" "Codex npm cooldown check missing npm" "The Codex node npm binary was not found."
    return 0
  fi

  local expected_days min_version stderr_file npm_version smoke_dir smoke_rc=0 scope=""
  expected_days="$(manifest_npmrc_min_release_age_days)"
  min_version="$(manifest_codex_npm_min_version)"
  stderr_file="$(mktemp "$TMP_DIR/codex-npm-cooldown.stderr.XXXXXX")"
  smoke_dir="$(mktemp -d "$TMP_DIR/codex-npm-smoke.XXXXXX")"

  set +e
  npm_version="$(PATH="$CODX_NODE_BIN_DIR:$PATH" "$npm" --version 2>"$stderr_file" | tail -n 1)"
  local version_rc=$?
  PATH="$CODX_NODE_BIN_DIR:$PATH" "$npm" config get min-release-age >/dev/null 2>>"$stderr_file"
  local config_rc=$?
  if [ "$CHECK_ONLY" -eq 1 ]; then
    # The verdict below then covers npm's version and configuration only.
    scope=" (configuration only: the dry-run install smoke is not run in check mode)"
  else
    PATH="$CODX_NODE_BIN_DIR:$PATH" "$npm" install is-number@7.0.0 \
      --dry-run \
      --ignore-scripts \
      --package-lock=false \
      --no-save \
      --prefix "$smoke_dir" >/dev/null 2>>"$stderr_file"
    smoke_rc=$?
  fi
  set -e

  if [ "$version_rc" -ne 0 ] || [ -z "$npm_version" ]; then
    local err
    err="$(head -n "$PROBE_OUTPUT_LINES" "$stderr_file")"
    record_event "codex-npm-cooldown" "failed" "npm --version failed: $err"
    send_alert "codex-cooldown-defense" "warning" "Codex npm cooldown check failed" "npm --version failed for Codex node. $err"
    return 0
  fi
  if [ "$config_rc" -ne 0 ]; then
    local err
    err="$(head -n "$PROBE_OUTPUT_LINES" "$stderr_file")"
    record_event "codex-npm-cooldown" "failed" "npm config get min-release-age failed: $err"
    send_alert "codex-cooldown-defense" "warning" "Codex npm cooldown check failed" "npm config get min-release-age failed for Codex node. $err"
    return 0
  fi

  set +e
  local out
  out="$("$REPO_NODE_BIN" --experimental-strip-types "$REPO_ROOT/scripts/harness-maintenance-guard.ts" \
    --npm-cooldown-config \
    --npm-version "$npm_version" \
    --min-version "$min_version" \
    --expected-days "$expected_days" \
    --npmrc-file "$HOME/.npmrc" \
    --stderr-file "$stderr_file" \
    --install-exit-code "$smoke_rc" 2>&1)"
  local rc=$?
  set -e

  if [ "$rc" -eq 0 ] && [ -n "$scope" ]; then
    record_event "codex-npm-cooldown" "checked" "npm $npm_version is configured with min-release-age=${expected_days}d$scope"
    return 0
  fi
  if [ "$rc" -eq 0 ]; then
    record_event "codex-npm-cooldown" "ok" "npm $npm_version accepts min-release-age=${expected_days}d"
    return 0
  fi
  if [ "$rc" -eq 2 ]; then
    record_event "codex-npm-cooldown" "degraded" "npm $npm_version: $out$scope"
    send_alert "codex-cooldown-defense" "warning" "Codex npm cooldown defense dormant" "Codex node npm does not fully honor min-release-age. $out"
    return 0
  fi

  record_event "codex-npm-cooldown" "failed" "cooldown recognition guard failed: $out"
  send_alert "codex-cooldown-defense" "warning" "Codex npm cooldown check failed" "Cooldown recognition guard failed. $out"
}

npm_latest_version() {
  local pkg="$1"
  local npm
  npm="$(npm_bin)"
  if [ -z "$npm" ]; then
    return 1
  fi
  PATH="$CODX_NODE_BIN_DIR:$PATH" "$npm" view "$pkg" version 2>/dev/null | tail -n 1
}

ensure_npm_version_eligible() {
  local pkg="$1"
  local version="$2"
  local npm
  npm="$(npm_bin)"
  if [ -z "$npm" ]; then
    record_event "$pkg" "failed" "npm not found for cooldown check"
    return 1
  fi
  local time_json="$TMP_DIR/npm-time.json"
  PATH="$CODX_NODE_BIN_DIR:$PATH" "$npm" view "$pkg" time --json > "$time_json"
  set +e
  local out
  out="$("$REPO_NODE_BIN" --experimental-strip-types "$REPO_ROOT/scripts/harness-maintenance-guard.ts" \
    --version-eligible "$version" \
    --time-json "$time_json" \
    --json 2>&1)"
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    return 0
  fi
  if [ "$rc" -eq 2 ]; then
    record_event "$pkg" "held" "target version is younger than the cooldown" "" "" "$version"
    # A cooldown hold is the supply-chain defense working as designed: the target
    # is simply too new (younger than min-release-age) and will install itself
    # once it ages past the window. This is expected, self-resolving, and
    # non-actionable — emit as info (transient, auto-expiring) so it never
    # bumps the run's info update incident to warn, blocks auto-expiry, or
    # re-escalates every cycle.
    send_alert "${pkg##*/}-update" "info" "Harness update held by npm cooldown" "$pkg@$version is younger than the configured cooldown. The cooldown defense is working as intended and self-resolves when the version ages past the window. $out"
    return 2
  fi
  record_event "$pkg" "failed" "npm cooldown check failed: $out"
  send_alert "${pkg##*/}-update" "warning" "Npm cooldown check failed" "The maintenance job could not verify publish age for $pkg@$version. $out"
  return "$rc"
}

npm_latest_eligible_version() {
  local pkg="$1"
  local npm
  npm="$(npm_bin)"
  if [ -z "$npm" ]; then
    return 1
  fi
  local time_json cooldown_minutes
  time_json="$TMP_DIR/npm-time-${pkg//[^A-Za-z0-9_.-]/_}.json"
  cooldown_minutes="$(manifest_npm_cooldown_minutes)"
  PATH="$CODX_NODE_BIN_DIR:$PATH" "$npm" view "$pkg" time --json > "$time_json"
  "$REPO_NODE_BIN" --experimental-strip-types "$REPO_ROOT/scripts/harness-maintenance-guard.ts" \
    --latest-eligible-version \
    --time-json "$time_json" \
    --cooldown-minutes "$cooldown_minutes" 2>/dev/null | tail -n 1
}

install_opencode_npm() {
  local target="$1"
  local npm
  npm="$(npm_bin)"
  if [ -z "$npm" ]; then
    record_event "opencode" "failed" "npm not found for opencode-ai install" "" "" "$target"
    send_alert "opencode-update" "warning" "OpenCode harness install failed" "npm was not found; opencode-ai@$target could not be installed."
    return 1
  fi
  mkdir -p "$NPM_GLOBAL_PREFIX"
  chmod 700 "$NPM_GLOBAL_PREFIX"
  PATH="$CODX_NODE_BIN_DIR:$PATH" "$npm" install -g "opencode-ai@$target" \
    --ignore-scripts \
    --prefix "$NPM_GLOBAL_PREFIX"
  if ! smoke_opencode; then
    record_event "opencode" "failed" "opencode-ai install failed smoke check" "" "" "$target"
    send_alert "opencode-update" "critical" "OpenCode harness install failed" "opencode-ai@$target installed but opencode --version did not pass."
    return 1
  fi
  return 0
}

audit_npm_global() {
  local npm
  npm="$(npm_bin)"
  if [ -z "$npm" ]; then
    return 1
  fi
  PATH="$CODX_NODE_BIN_DIR:$PATH" "$npm" audit signatures --global >/dev/null 2>&1
  PATH="$CODX_NODE_BIN_DIR:$PATH" "$npm" audit --global --audit-level=high >/dev/null 2>&1
}

# claude_consumer_policy: decide from CLAUDE_CONSUMERS_FILE whether the shared launcher may be
# updated. Prints one \037-separated record "<verdict> <kind> <version> <message>"; verdict is one of
#   proceed   every instance resolves exactly the launcher; kind/version describe it
#   held      no instance uses the launcher, or an instance is pinned to another binary
#   unknown   an instance's binary could not be determined
#   missing   an instance has no claude on its service PATH
# The native installer rewrites only the launcher, so an install is safe to report as a service
# update only when every consumer runs it; a pinned instance is an owner decision and is held.
claude_consumer_policy() {
  local name manager status bin kind version
  local count=0 unknown="" missing="" pinned="" launcher_kind="" launcher_version=""
  while IFS=$'\037' read -r name manager status bin kind version; do
    [ -n "$name" ] || continue
    count=$((count + 1))
    case "$status" in
      unknown) unknown="$unknown $name" ;;
      missing) missing="$missing $name" ;;
      resolved)
        if [ "$bin" != "$CLAUDE_NATIVE_LAUNCHER" ]; then
          pinned="$pinned $name=$bin"
        else
          launcher_kind="$kind"
          launcher_version="$version"
        fi ;;
      *) unknown="$unknown $name" ;;
    esac
  done < "$CLAUDE_CONSUMERS_FILE"
  if [ -n "$unknown" ]; then
    printf 'unknown\037\037\037instance binary could not be determined for:%s\n' "$unknown"
  elif [ -n "$missing" ]; then
    printf 'missing\037\037\037no claude on the service PATH of:%s\n' "$missing"
  elif [ "$count" -eq 0 ]; then
    printf 'held\037\037\037no service instance uses the shared launcher; nothing to update\n'
  elif [ -n "$pinned" ]; then
    printf 'held\037\037\037instances resolve a binary other than the shared launcher:%s\n' "$pinned"
  else
    printf 'proceed\037%s\037%s\037%s service instance(s) resolve the shared launcher\n' "$launcher_kind" "$launcher_version" "$count"
  fi
}

update_claude() {
  local before="" after target action plan_file plan_rc npm time_json reason inventory_error
  local policy verdict kind message layout rc
  CLAUDE_CONSUMERS_FILE="$(mktemp "$TMP_DIR/claude-consumers.XXXXXX")"
  inventory_error="$TMP_DIR/claude-inventory.err"
  rc=0
  claude_service_inventory >"$inventory_error" || rc=$?
  if [ "$rc" -ne 0 ]; then
    record_event "claude" "unknown" "service inventory unavailable: $(head -n 5 "$inventory_error")"
    send_alert "claude-update" "warning" "Agent CLI inventory failed" "The maintenance job could not read the service manager, so no agent CLI update was attempted. $(head -n 5 "$inventory_error")"
    return 2
  fi
  policy="$(claude_consumer_policy)"
  IFS=$'\037' read -r verdict kind before message <<< "$policy"
  case "$verdict" in
    proceed) ;;
    held)
      record_event "claude" "held" "$message"
      case "$message" in
        *"other than the shared launcher"*)
          send_alert "claude-update" "warning" "Agent CLI update held by an instance pin" "$message" ;;
        # Zero instances can also mean the inventory missed them; never hold that silently.
        *"no service instance"*)
          send_alert "claude-update" "warning" "Agent CLI update held: no service instance found" "$message" ;;
      esac
      return 0 ;;
    missing)
      record_event "claude" "missing" "$message"
      send_alert "claude-update" "warning" "Agent CLI missing for a service instance" "$message"
      return 2 ;;
    *)
      record_event "claude" "unknown" "$message"
      send_alert "claude-update" "warning" "Agent CLI update held: unknown instance binary" "$message"
      return 2 ;;
  esac
  case "$kind" in
    native) layout=native ;;
    npm|wrapper|wrapper-unresolved|other)
      record_event "claude" "unmanaged-layout" "shared launcher is a $kind layout; native installer not run" "$before"
      send_alert "claude-update" "warning" "Agent CLI not on the native layout" "The shared launcher is a $kind layout, so the native installer was not run."
      return 0 ;;
    *)
      record_event "claude" "unknown" "shared launcher classified as $kind" "$before"
      send_alert "claude-update" "warning" "Agent CLI update held: launcher unusable" "The shared launcher classified as $kind."
      return 2 ;;
  esac

  if npm_skipped_in_check claude; then
    return 2
  fi
  npm="$(npm_bin)"
  time_json="$TMP_DIR/npm-time-claude.json"
  rc=0
  if [ -z "$npm" ]; then
    rc=127
  else
    whatsoup_run_bounded "$LOOKUP_TIMEOUT_SECS" env PATH="$CODX_NODE_BIN_DIR:$PATH" \
      "$npm" view @anthropic-ai/claude-code time --json >"$time_json" 2>/dev/null </dev/null || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq 124 ]; then
      reason="npm publish-time lookup timed out after ${LOOKUP_TIMEOUT_SECS}s"
    else
      reason="npm publish-time lookup failed rc=$rc"
    fi
    record_event "claude" "unknown" "$reason" "$before"
    send_alert "claude-update" "warning" "Agent CLI version lookup failed" "The maintenance job could not read agent CLI publish times, so it cannot apply the release-age cooldown. $reason"
    return 2
  fi
  plan_file="$TMP_DIR/claude-plan.json"
  plan_rc=0
  "$REPO_NODE_BIN" --experimental-strip-types "$REPO_ROOT/scripts/harness-maintenance-guard.ts" \
    --claude-update-plan --current "$before" --time-json "$time_json" \
    --cooldown-minutes "$(manifest_npm_cooldown_minutes)" --layout "$layout" \
    >"$plan_file" 2>/dev/null || plan_rc=$?
  plan="$("$REPO_NODE_BIN" - "$plan_file" <<'NODE' || true
const fs = require('node:fs');
try {
  const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
  const r = lines.length === 1 ? JSON.parse(lines[0]) : null;
  const text = (v) => (typeof v === 'string' ? v.replace(/[\t\n]/g, ' ') : '');
  if (r && typeof r.action === 'string') {
    process.stdout.write([r.action, text(r.target), text(r.reason || (r.error && `${r.error.code}: ${r.error.message}`))].join('\x1f'));
  }
} catch {}
NODE
)"
  IFS=$'\037' read -r action target reason <<< "$plan"
  if [ "$plan_rc" -ne 0 ] && [ "$action" != "error" ]; then
    action=""
  fi
  case "$action" in
    error)
      record_event "claude" "held" "update plan rejected: $reason" "$before"
      send_alert "claude-update" "warning" "Agent CLI update plan rejected" "$reason"
      return 2 ;;
    missing)
      record_event "claude" "missing" "planner reported no current version: $reason" "$before"
      return 2 ;;
    unknown)
      record_event "claude" "unknown" "planner could not read the current version: $reason" "$before"
      send_alert "claude-update" "warning" "Agent CLI version unknown" "$reason"
      return 2 ;;
    held)
      record_event "claude" "held" "$reason" "$before"
      return 0 ;;
    current)
      record_event "claude" "current" "shared launcher is at or past the newest cooldown-eligible release" "$before" "$before" "$target"
      return 0 ;;
    unmanaged-layout)
      record_event "claude" "unmanaged-layout" "$reason" "$before" "$before" "$target"
      return 0 ;;
    install) ;;
    *)
      record_event "claude" "unknown" "update plan unreadable (rc=$plan_rc)" "$before"
      send_alert "claude-update" "warning" "Agent CLI update plan failed" "The maintenance job could not compute an agent CLI update plan (rc=$plan_rc)."
      return 2 ;;
  esac
  if [ "$CHECK_ONLY" -eq 1 ]; then
    record_event "claude" "drift" "cooldown-eligible update available" "$before" "$before" "$target"
    return 0
  fi
  claude_install_transaction "$before" "$target"
}

# claude_fs <facts|cas> ...: filesystem facts and the link swap, done in node so each is a single
# syscall-level operation rather than a chain of shell utilities.
#   facts <path>                          -> "<readlink>\037<realpath>\037<sha256 of realpath>"
#                                            (fields empty when unavailable)
#   cas <link> <expected> <replacement>   -> exit 0 swapped and read back; 3 the link no longer
#                                            points at <expected>; 4 read-back mismatch; 5 the
#                                            swap itself failed (e.g. directory not writable)
claude_fs() {
  "$REPO_NODE_BIN" - "$@" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [mode, ...args] = process.argv.slice(2);
const safe = (f) => { try { return f(); } catch { return ''; } };
if (mode === 'facts') {
  const [file] = args;
  const link = safe(() => fs.readlinkSync(file));
  const real = safe(() => fs.realpathSync(file));
  const digest = real && safe(() => (fs.statSync(real).isFile()
    ? crypto.createHash('sha256').update(fs.readFileSync(real)).digest('hex') : ''));
  process.stdout.write([link, real, digest].join('\x1f'));
} else if (mode === 'cas') {
  const [link, expected, replacement] = args;
  if (safe(() => fs.readlinkSync(link)) !== expected) process.exit(3);
  const tmp = path.join(path.dirname(link), `.${path.basename(link)}.rollback.${process.pid}`);
  try {
    fs.symlinkSync(replacement, tmp);
    if (safe(() => fs.readlinkSync(link)) !== expected) { fs.unlinkSync(tmp); process.exit(3); }
    fs.renameSync(tmp, link);
  } catch {
    safe(() => fs.unlinkSync(tmp));
    process.exit(5);
  }
  process.exit(safe(() => fs.readlinkSync(link)) === replacement ? 0 : 4);
} else {
  process.exit(2);
}
NODE
}

# claude_postcheck <target>: after an install, every instance must again resolve the shared
# launcher, the launcher must classify as native at <target>, and a bounded --version of that
# verified native binary must exit 0 and report <target>. Prints a reason on failure.
claude_postcheck() {
  local target="$1" policy verdict kind version message facts real digest out rc=0
  CLAUDE_CONSUMERS_FILE="$(mktemp "$TMP_DIR/claude-consumers-post.XXXXXX")"
  if ! claude_service_inventory >/dev/null; then
    echo "service inventory unavailable after install"
    return 1
  fi
  policy="$(claude_consumer_policy)"
  IFS=$'\037' read -r verdict kind version message <<< "$policy"
  if [ "$verdict" != proceed ] || [ "$kind" != native ] || [ "$version" != "$target" ]; then
    echo "instances do not resolve a native $target through the launcher: $verdict $kind ${version:-none}: $message"
    return 1
  fi
  facts="$(claude_fs facts "$CLAUDE_NATIVE_LAUNCHER")"
  IFS=$'\037' read -r _ real digest <<< "$facts"
  if [ -z "$real" ] || [ -z "$digest" ]; then
    echo "launcher does not resolve after install"
    return 1
  fi
  whatsoup_run_bounded "$VERSION_TIMEOUT_SECS" "$real" --version >"$TMP_DIR/claude-version.out" 2>/dev/null </dev/null || rc=$?
  out="$(parse_version < "$TMP_DIR/claude-version.out" || true)"
  if [ "$rc" -ne 0 ] || [ "$out" != "$target" ]; then
    echo "--version of $real returned rc=$rc version=${out:-none}"
    return 1
  fi
  # The answer only vouches for the binary it came from: the launcher must still resolve to the
  # same file with the same digest.
  if [ "$(claude_fs facts "$CLAUDE_NATIVE_LAUNCHER")" != "$facts" ]; then
    echo "launcher changed while --version ran (was $real sha256 $digest)"
    return 1
  fi
}

# claude_install_transaction <before> <target>
#   0  installed and postchecked
#   1  install failed and the previous binary was restored and verified
#   2  the previous binary could not be verified before install (nothing was run)
#   3  install failed and the rollback could not be verified: reconcile by hand
claude_install_transaction() {
  local before="$1" target="$2" facts prev_link prev_real prev_digest rc=0
  local post_link post_real post_digest failure check rollback_rc
  facts="$(claude_fs facts "$CLAUDE_NATIVE_LAUNCHER")"
  IFS=$'\037' read -r prev_link prev_real prev_digest <<< "$facts"
  if [ -z "$prev_link" ] || [ -z "$prev_real" ] || [ -z "$prev_digest" ] || [ "${prev_real##*/}" != "$before" ]; then
    record_event "claude" "unknown" "previous binary could not be verified before install (link=${prev_link:-none})" "$before" "" "$target"
    send_alert "claude-update" "warning" "Agent CLI install not attempted" "The retained previous binary could not be verified, so no install was run."
    return 2
  fi

  whatsoup_run_bounded "$INSTALL_TIMEOUT_SECS" "$prev_real" install "$target" \
    >"$TMP_DIR/claude-install.log" 2>&1 </dev/null || rc=$?
  record_event "claude" "install-attempted" "installer rc=$rc via $prev_real (sha256 $prev_digest)" "$before" "" "$target"

  facts="$(claude_fs facts "$CLAUDE_NATIVE_LAUNCHER")"
  IFS=$'\037' read -r post_link post_real post_digest <<< "$facts"
  failure=""
  if [ "$rc" -ne 0 ]; then
    failure="installer exited rc=$rc"
  elif ! check="$(claude_postcheck "$target")"; then
    failure="postcheck failed: $check"
  fi
  if [ -z "$failure" ]; then
    record_event "claude" "updated" "installed $target at $post_real (sha256 $post_digest) and postchecked every instance" "$before" "$target" "$target"
    send_alert "claude-update" "info" "Agent CLI updated" "Agent CLI $before -> $target"
    return 0
  fi

  record_event "claude" "rollback-attempted" "$failure; restoring $prev_link" "$before" "" "$target"
  # Restoration uses only the retained previous binary: it must still be the same file.
  facts="$(claude_fs facts "$prev_real")"
  IFS=$'\037' read -r _ _ check <<< "$facts"
  if [ "$check" != "$prev_digest" ]; then
    record_event "claude" "rollback-failed" "previous binary $prev_real is missing or changed (sha256 ${check:-none}); not reinstalled" "$before" "" "$target"
    send_alert "claude-update" "critical" "Agent CLI rollback failed" "$failure. The previous binary is missing or changed, so the launcher was left as found. Reconcile by hand."
    return 3
  fi
  if [ "$post_link" != "$prev_link" ]; then
    rollback_rc=0
    claude_fs cas "$CLAUDE_NATIVE_LAUNCHER" "$post_link" "$prev_link" || rollback_rc=$?
    if [ "$rollback_rc" -eq 3 ]; then
      record_event "claude" "rollback-failed" "launcher moved since the install (swap rc=$rollback_rc); left as found" "$before" "" "$target"
      send_alert "claude-update" "critical" "Agent CLI rollback failed" "$failure. The launcher changed after the install, so it was not swapped back. Reconcile by hand."
      return 3
    elif [ "$rollback_rc" -ne 0 ]; then
      record_event "claude" "rollback-failed" "launcher link swap failed (rc=$rollback_rc); launcher left as the install left it" "$before" "" "$target"
      send_alert "claude-update" "critical" "Agent CLI rollback failed" "$failure. Swapping the launcher link back failed (rc=$rollback_rc). Reconcile by hand."
      return 3
    fi
  fi
  facts="$(claude_fs facts "$CLAUDE_NATIVE_LAUNCHER")"
  IFS=$'\037' read -r post_link post_real post_digest <<< "$facts"
  if [ "$post_link" != "$prev_link" ] || [ "$post_digest" != "$prev_digest" ]; then
    record_event "claude" "rollback-failed" "launcher does not read back as the previous binary" "$before" "" "$target"
    send_alert "claude-update" "critical" "Agent CLI rollback failed" "$failure. The launcher did not read back as the previous binary. Reconcile by hand."
    return 3
  fi
  record_event "claude" "rollback-verified" "launcher restored to $prev_link (sha256 $prev_digest) after: $failure" "$before" "$before" "$target"
  send_alert "claude-update" "critical" "Agent CLI install rolled back" "$failure. The previous binary was restored and verified."
  return 1
}

# --- Agent CLI update policy observation ------------------------------------------------------
#
# The release-age cooldown governs only the installs this job makes. The agent CLI can also update
# itself: a long-running session has been seen to replace the native launcher link on its own
# schedule, and DISABLE_AUTOUPDATER did not stop that path while DISABLE_UPDATES did. This step
# observes and reports; it changes no setting and enforces nothing. Each surface is reported on its
# own: settings on disk, each instance's service environment, this job's environment, the live
# launcher, and running CLI processes (counts only).

# claude_launcher_state <facts>: "absent", or "link=<readlink or none> sha256=<digest or none>".
claude_launcher_state() {
  local link real digest
  IFS=$'\037' read -r link real digest <<< "$1"
  if [ -z "$link" ] && [ -z "$real" ]; then
    echo absent
  else
    echo "link=${link:-none} sha256=${digest:-none}"
  fi
}

# claude_launcher_previous <status>: the `after` of the last claude-launcher event with <status>
# (baseline or alert-history) in the previous run's final state, or 1 when there is none. A
# symlinked state file is never followed.
claude_launcher_previous() {
  if [ -L "$STATE_FILE" ] || [ ! -f "$STATE_FILE" ]; then
    return 1
  fi
  "$REPO_NODE_BIN" - "$STATE_FILE" "$1" <<'NODE'
const fs = require('node:fs');
try {
  const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const events = Array.isArray(state.events) ? state.events : [];
  const baseline = events
    .filter((e) => e && e.component === 'claude-launcher' && e.status === process.argv[3] && typeof e.after === 'string')
    .at(-1);
  if (!baseline) process.exit(1);
  process.stdout.write(baseline.after);
} catch {
  process.exit(1);
}
NODE
}

# Launcher link targets already alerted on (one per line, "absent" for a removed launcher, newest
# last, at most 20): a move is alerted once per distinct target, never again for it. Kept in a file
# because the observation and the baseline are separate steps, each in its own subshell.
CLAUDE_LAUNCHER_HISTORY_FILE="$TMP_DIR/claude-launcher.history"
# The launcher after the update step and before the probes, for the baseline step to compare with.
CLAUDE_LAUNCHER_PREPROBE_FILE="$TMP_DIR/claude-launcher.preprobe"

# launcher_target_key <state>: the link target a launcher state points at, or "absent".
launcher_target_key() {
  local key="${1% sha256=*}"
  printf '%s\n' "${key#link=}"
}

# load_launcher_history: seed the history file from the previous run's final state.
load_launcher_history() {
  local history
  history="$(claude_launcher_previous alert-history || true)"
  if [ -n "$history" ]; then
    printf '%s\n' "$history" > "$CLAUDE_LAUNCHER_HISTORY_FILE"
  else
    : > "$CLAUDE_LAUNCHER_HISTORY_FILE"
  fi
}

launcher_target_alerted() {
  grep -Fxq -- "$1" "$CLAUDE_LAUNCHER_HISTORY_FILE" 2>/dev/null
}

# launcher_target_remember <key>: check mode sends no alert, so it records none.
launcher_target_remember() {
  local history
  [ "$CHECK_ONLY" -eq 0 ] || return 0
  history="$( { cat "$CLAUDE_LAUNCHER_HISTORY_FILE" 2>/dev/null || true; printf '%s\n' "$1"; } | tail -n 20)"
  printf '%s\n' "$history" > "$CLAUDE_LAUNCHER_HISTORY_FILE"
}

# observe_claude_launcher: compare the last normal run's baseline with the launcher as this run
# found it (before any install). A change between runs did not come from this job's install
# transaction. The next baseline is taken after the probes (record_claude_launcher_baseline).
observe_claude_launcher() {
  local start previous status now key summary cause
  load_launcher_history
  if [ ! -f "$CLAUDE_LAUNCHER_START_FILE" ]; then
    record_event "claude-launcher" "unknown" "launcher facts could not be read at the start of this run"
  else
    start="$(claude_launcher_state "$(cat "$CLAUDE_LAUNCHER_START_FILE")")"
    if previous="$(claude_launcher_previous baseline)"; then
      if [ "$previous" = "$start" ]; then
        status=unchanged
      elif [ "$start" = absent ]; then
        status=disappeared
      elif [ "$previous" = absent ]; then
        status=appeared
      else
        status=moved
      fi
    else
      status=first-observation
    fi
    case "$status" in
      first-observation)
        record_event "claude-launcher" "$status" "no launcher baseline from a previous run" "" "$start" ;;
      unchanged)
        record_event "claude-launcher" "$status" "launcher unchanged since the previous run" "$previous" "$start" ;;
      *)
        # The link target the launcher moved to (its readlink), or "absent".
        key="$(launcher_target_key "$start")"
        if launcher_target_alerted "$key"; then
          record_event "claude-launcher" "$status" "launcher changed between runs, outside this job's install transaction and its release-age cooldown; already alerted for this launcher target" "$previous" "$start"
        else
          record_event "claude-launcher" "$status" "launcher changed between runs, outside this job's install transaction and its release-age cooldown" "$previous" "$start"
          summary="$(cat "$CLAUDE_POLICY_SUMMARY_FILE" 2>/dev/null || true)"
          case "$summary" in
            advisory|none) cause="the agent CLI updating itself (update policy summary: $summary)" ;;
            *) cause="not determined (update policy summary: ${summary:-not observed})" ;;
          esac
          send_alert "claude-launcher" "warning" "Agent CLI launcher changed outside the maintenance job" \
            "$CLAUDE_NATIVE_LAUNCHER $status between runs: $previous -> $start. The release-age cooldown did not govern this change; probable cause: $cause."
          launcher_target_remember "$key"
        fi ;;
    esac
  fi
  now="$(claude_launcher_state "$(claude_fs facts "$CLAUDE_NATIVE_LAUNCHER")")"
  printf '%s\n' "$now" > "$CLAUDE_LAUNCHER_PREPROBE_FILE"
}

# record_claude_launcher_baseline: the baseline the next run compares against, taken after the
# probes. In a normal run the launcher is first compared with how it stood before the probes: the
# plugin and MCP listing starts the agent CLI, which can update itself, and such a move is
# attributed to this job rather than reported by the next run as a change outside it. Check mode
# never advances the baseline: it records what it saw under another status and carries the last
# normal run's baseline forward, so a move seen only by a check run is still alerted by the next
# normal run.
record_claude_launcher_baseline() {
  local before now previous key history
  now="$(claude_launcher_state "$(claude_fs facts "$CLAUDE_NATIVE_LAUNCHER")")"
  # Without the observation step's file (it failed), the history comes from the previous state.
  [ -f "$CLAUDE_LAUNCHER_HISTORY_FILE" ] || load_launcher_history
  if [ "$CHECK_ONLY" -eq 1 ]; then
    record_event "claude-launcher" "check-observation" "launcher as this check run left it; check mode does not advance the baseline" "" "$now"
    if previous="$(claude_launcher_previous baseline)"; then
      record_event "claude-launcher" "baseline" "the last normal run's baseline, carried forward unchanged by check mode" "" "$previous"
    fi
  else
    before="$(cat "$CLAUDE_LAUNCHER_PREPROBE_FILE" 2>/dev/null || true)"
    if [ -n "$before" ] && [ "$before" != "$now" ]; then
      key="$(launcher_target_key "$now")"
      if launcher_target_alerted "$key"; then
        record_event "claude-launcher" "moved-during-probes" "launcher changed while this job's probes ran the agent CLI; already alerted for this launcher target" "$before" "$now"
      else
        record_event "claude-launcher" "moved-during-probes" "launcher changed while this job's probes ran the agent CLI" "$before" "$now"
        send_alert "claude-launcher" "warning" "Agent CLI launcher changed while the maintenance job ran the agent CLI" \
          "$CLAUDE_NATIVE_LAUNCHER changed during this job's plugin and MCP listing: $before -> $now. The agent CLI probably updated itself when the job started it; the release-age cooldown did not govern this change."
        launcher_target_remember "$key"
      fi
    fi
    record_event "claude-launcher" "baseline" "launcher after this run's update step and probes; the next run compares against it" "" "$now"
  fi
  history="$(cat "$CLAUDE_LAUNCHER_HISTORY_FILE" 2>/dev/null || true)"
  if [ -n "$history" ]; then
    record_event "claude-launcher" "alert-history" "launcher targets already alerted on" "" "$history"
  fi
}

# claude_settings_policy <config dir, or empty for the default>: print
# "<installMethod>\037<autoUpdates>\037<settings env DISABLE_UPDATES>\037<settings env DISABLE_AUTOUPDATER>".
# The global config file also holds account data; only these two keys are read from it.
claude_settings_policy() {
  "$REPO_NODE_BIN" - "$HOME" "$1" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [home, dir] = process.argv.slice(2);
const read = (file) => {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: Boolean(err && err.code === 'ENOENT'), value: null };
  }
};
const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const field = (r, pick) => (r.ok ? pick(record(r.value)) : 'unreadable');
const settings = read(path.join(dir || path.join(home, '.claude'), 'settings.json'));
const global = read(dir ? path.join(dir, '.claude.json') : path.join(home, '.claude.json'));
const installMethod = field(global, (g) => (g.installMethod === undefined ? 'absent'
  : typeof g.installMethod === 'string' && /^[a-z0-9-]{1,32}$/.test(g.installMethod) ? g.installMethod : 'unrecognized'));
const autoUpdates = field(global, (g) => (g.autoUpdates === undefined ? 'absent'
  : typeof g.autoUpdates === 'boolean' ? String(g.autoUpdates) : 'unrecognized'));
// Same classes as the shell's flag_class: only "1" or "true" disables.
const envFlag = (key) => field(settings, (s) => {
  const env = record(s.env);
  if (env[key] === undefined) return 'unset';
  return ['1', 'true'].includes(String(env[key]).toLowerCase()) ? 'set' : 'set-unrecognized';
});
process.stdout.write([installMethod, autoUpdates, envFlag('DISABLE_UPDATES'), envFlag('DISABLE_AUTOUPDATER')].join('\x1f'));
NODE
}

# env_flag <name>: flag_class of the variable in this job's environment.
env_flag() {
  if [ -z "${!1+x}" ]; then echo unset; else flag_class "${!1}"; fi
}

# The summary status, for the launcher observation's alert text.
CLAUDE_POLICY_SUMMARY_FILE="$TMP_DIR/claude-policy-summary"

# policy_summary <status> <message>
policy_summary() {
  record_event "claude-update-policy" "$1" "$2"
  printf '%s\n' "$1" > "$CLAUDE_POLICY_SUMMARY_FILE"
}

observe_claude_update_policy() {
  local name manager surface config updates autoupdater config_label settings method auto s_updates s_auto
  local total=0 disabled=0 open="" unknown="" config_dir_state=unset
  [ -z "${CLAUDE_CONFIG_DIR:-}" ] || config_dir_state="set"
  record_event "claude-update-policy" "job-env" \
    "this job: DISABLE_UPDATES=$(env_flag DISABLE_UPDATES) DISABLE_AUTOUPDATER=$(env_flag DISABLE_AUTOUPDATER) CLAUDE_CONFIG_DIR=$config_dir_state"
  if [ ! -f "$CLAUDE_INSTANCE_ENV_FILE" ]; then
    policy_summary "unknown" "service definitions were not read this run, so no instance's update policy is known"
    return 0
  fi
  while IFS=$'\037' read -r name manager surface config updates autoupdater; do
    [ -n "$name" ] || continue
    total=$((total + 1))
    if [ "$updates" = "?" ]; then
      record_event "claude-update-policy" "instance" "$name via $manager ($surface): service environment not readable"
      unknown="$unknown $name"
      continue
    fi
    case "$config" in
      "") config_label="config default" ;;
      "?") config_label="config set by the service, not readable" ;;
      *) config_label="config set by the service" ;;
    esac
    settings=""
    if [ "$config" != "?" ]; then
      settings="$(claude_settings_policy "$config")" || settings=""
    fi
    IFS=$'\037' read -r method auto s_updates s_auto <<< "$settings"
    if [ "$updates" = set ] || [ "$s_updates" = set ]; then
      disabled=$((disabled + 1))
    elif [ "$updates" = unset ] && [ "$s_updates" = unset ]; then
      open="$open $name"
    else
      # An unrecognized value, or settings that could not be read.
      unknown="$unknown $name"
    fi
    record_event "claude-update-policy" "instance" \
      "$name via $manager ($surface): DISABLE_UPDATES=$updates DISABLE_AUTOUPDATER=$autoupdater; $config_label: installMethod=${method:-unknown} autoUpdates=${auto:-unknown}, settings env DISABLE_UPDATES=${s_updates:-unknown} DISABLE_AUTOUPDATER=${s_auto:-unknown}"
  done < "$CLAUDE_INSTANCE_ENV_FILE"
  if [ "$total" -eq 0 ]; then
    policy_summary "none" "no service instance was inventoried"
  elif [ -n "$open" ]; then
    policy_summary "advisory" "$disabled of $total instances start the agent CLI with DISABLE_UPDATES set to 1 or true (service environment or settings env); the release-age cooldown is advisory for:$open${unknown:+; undetermined for:$unknown}. DISABLE_AUTOUPDATER alone is not counted. Observed, not enforced."
  elif [ -n "$unknown" ]; then
    policy_summary "unknown" "$disabled of $total instances start the agent CLI with DISABLE_UPDATES set to 1 or true; undetermined (unrecognized value or unreadable settings) for:$unknown. Observed, not enforced."
  else
    policy_summary "disabled" "all $total instances start the agent CLI with DISABLE_UPDATES set to 1 or true (service environment or settings env); observed, not enforced"
  fi
}

# observe_claude_processes: count this user's native-layout agent CLI processes (process name
# "claude" or a bare version filename) and those running over 30 minutes. Only the uid, elapsed
# time and executable name are read, never a command line, and only the counts are recorded.
observe_claude_processes() {
  local ps_bin awk_bin counts total long
  if ! ps_bin="$(job_tool ps)" || ! awk_bin="$(job_tool awk)"; then
    record_event "claude-processes" "unknown" "ps or awk not found on the job PATH"
    return 0
  fi
  # shellcheck disable=SC2016 # an awk program; $1..$3 are awk fields.
  if ! counts="$("$ps_bin" -A -o uid= -o etime= -o comm= 2>/dev/null | "$awk_bin" -v uid="$EUID" '
    $1 == uid {
      comm = $0
      sub(/^[ \t]*[^ \t]+[ \t]+[^ \t]+[ \t]+/, "", comm)
      n = split(comm, parts, "/")
      base = parts[n]
      if (base != "claude" && base !~ /^[0-9]+\.[0-9]+\.[0-9]+$/) next
      total++
      t = $2; days = 0; secs = 0
      if (index(t, "-")) { split(t, dt, "-"); days = dt[1]; t = dt[2] }
      k = split(t, hms, ":")
      for (i = 1; i <= k; i++) secs = secs * 60 + hms[i]
      if (secs + days * 86400 >= 1800) long++
    }
    END { printf "%d %d", total, long }')"; then
    record_event "claude-processes" "unknown" "process listing failed"
    return 0
  fi
  read -r total long <<< "$counts"
  record_event "claude-processes" "observed" \
    "$total agent CLI processes for this user, $long running longer than 30 minutes (native layout; counts only)"
}

observe_claude_update_path() {
  # The policy first: a launcher move alert names it as the probable cause.
  observe_claude_update_policy
  observe_claude_launcher
  observe_claude_processes
}

update_codex() {
  local before latest npm after
  before="$(codex_current)"
  if [ -z "$before" ] && [ "$CHECK_ONLY" -eq 1 ] && [ -n "$(codex_bin)" ]; then
    record_event "codex" "unknown" "codex is installed but not as an npm package, so check mode cannot read its version without executing it"
    return 0
  fi
  if [ -z "$before" ]; then
    record_event "codex" "missing" "codex binary not found"
    send_alert "codex-update" "warning" "Codex harness missing" "The maintenance job could not find the codex binary."
    return 0
  fi
  if npm_skipped_in_check codex; then
    return 0
  fi
  latest="$(npm_latest_version @openai/codex || true)"
  npm="$(npm_bin)"
  if [ -z "$latest" ] || [ -z "$npm" ]; then
    record_event "codex" "unknown" "latest version lookup failed" "$before"
    send_alert "codex-update" "warning" "Codex latest lookup failed" "The maintenance job could not determine the latest Codex CLI version."
    return 0
  fi
  if [ "$before" = "$latest" ]; then
    record_event "codex" "current" "already at latest" "$before" "$before" "$latest"
    return 0
  fi
  if ! ensure_npm_version_eligible @openai/codex "$latest"; then
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    record_event "codex" "drift" "cooldown-eligible update available" "$before" "$before" "$latest"
    return 0
  fi
  PATH="$CODX_NODE_BIN_DIR:$PATH" "$npm" install -g "@openai/codex@$latest" --ignore-scripts
  if ! audit_npm_global || ! smoke_codex; then
    PATH="$CODX_NODE_BIN_DIR:$PATH" "$npm" install -g "@openai/codex@$before" --ignore-scripts || true
    record_event "codex" "rollback" "audit or smoke failed after update; rollback attempted" "$before" "" "$latest"
    send_alert "codex-update" "critical" "Codex harness rollback" "Update to $latest failed audit/smoke; rollback to $before attempted."
    return 1
  fi
  after="$(codex_current)"
  record_event "codex" "updated" "updated, audited, and smoke checked" "$before" "$after" "$latest"
  send_alert "codex-update" "info" "Codex harness updated" "Codex CLI $before -> $after"
}

update_opencode() {
  local before after target
  before="$(opencode_current)"
  if [ -z "$before" ] && [ "$CHECK_ONLY" -eq 1 ] && [ -n "$(opencode_bin)" ]; then
    record_event "opencode" "unknown" "opencode is installed but not as an npm package, so check mode cannot read its version without executing it"
    return 0
  fi
  if [ -z "$before" ]; then
    if npm_skipped_in_check opencode; then
      return 0
    fi
    target="$(npm_latest_eligible_version opencode-ai || true)"
    if [ -z "$target" ]; then
      record_event "opencode" "held" "opencode missing and no opencode-ai version is past the npm cooldown window"
      # Cooldown hold = supply-chain defense working as intended; self-resolves
      # as opencode-ai versions age past the window. Info/transient, not a warn.
      send_alert "opencode-update" "info" "OpenCode harness install held" "OpenCode is missing, and no opencode-ai version is old enough under the configured npm cooldown. This is the cooldown defense working as intended and self-resolves as a version ages past the window."
      return 0
    fi
    if [ "$CHECK_ONLY" -eq 1 ]; then
      record_event "opencode" "missing" "opencode binary not found; opencode-ai install available" "" "" "$target"
      return 0
    fi
    install_opencode_npm "$target"
    after="$(opencode_current)"
    record_event "opencode" "installed" "installed and smoke checked via opencode-ai npm package" "" "$after" "$target"
    send_alert "opencode-update" "info" "OpenCode harness installed" "OpenCode fallback harness installed as opencode-ai@$target and passed opencode --version."
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    record_event "opencode" "checked" "opencode present; upgrade skipped in check mode" "$before"
    return 0
  fi
  opencode upgrade
  if ! smoke_opencode; then
    opencode upgrade "$before" || true
    record_event "opencode" "rollback" "smoke failed after upgrade; rollback attempted" "$before"
    send_alert "opencode-update" "critical" "OpenCode harness rollback" "Upgrade failed smoke check; rollback to $before attempted."
    return 1
  fi
  after="$(opencode_current)"
  if [ "$before" = "$after" ]; then
    record_event "opencode" "current" "upgrade completed with no version change" "$before" "$after"
  else
    record_event "opencode" "updated" "upgraded and smoke checked" "$before" "$after"
    send_alert "opencode-update" "info" "OpenCode harness updated" "OpenCode $before -> $after"
  fi
}

probe_command() {
  local name="$1"
  shift
  set +e
  local out out_file
  out_file="$(mktemp "$TMP_DIR/probe.XXXXXX")"
  if command -v timeout >/dev/null 2>&1; then
    timeout "$PROBE_TIMEOUT_SECS" "$@" >"$out_file" 2>&1
  else
    "$@" >"$out_file" 2>&1
  fi
  local rc=$?
  out="$(head -n "$PROBE_OUTPUT_LINES" "$out_file")"
  set -e
  if [ "$rc" -eq 0 ]; then
    record_event "$name" "ok" "$out"
  elif [ "$rc" -eq 124 ]; then
    record_event "$name" "timeout" "probe exceeded ${PROBE_TIMEOUT_SECS}s"
    send_alert "probe-${name//[^A-Za-z0-9_.-]/_}" "warning" "Harness maintenance probe timed out" "$name exceeded ${PROBE_TIMEOUT_SECS}s"
  else
    record_event "$name" "failed" "$out"
    send_alert "probe-${name//[^A-Za-z0-9_.-]/_}" "warning" "Harness maintenance probe failed" "$name failed: $out"
  fi
}

probe_local_bin() {
  local bin="$1"
  local path
  path="$(harness_which "$bin")"
  if [ -z "$path" ]; then
    record_event "local-bin:$bin" "missing" "$bin not found on PATH"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    record_event "local-bin:$bin" "present" "$path present; not executed in check mode"
    return 0
  fi
  case "$bin" in
    google-workspace-mcp|pinecone-mcp|whatsapp-mcp)
      record_event "local-bin:$bin" "present" "$path present; stdio MCP version probe skipped"
      return 0
      ;;
  esac
  set +e
  local out out_file
  out_file="$(mktemp "$TMP_DIR/local-bin.XXXXXX")"
  if command -v timeout >/dev/null 2>&1; then
    timeout "$PROBE_TIMEOUT_SECS" "$path" --version >"$out_file" 2>&1
  else
    "$path" --version >"$out_file" 2>&1
  fi
  local rc=$?
  out="$(head -n 5 "$out_file")"
  set -e
  if [ "$rc" -eq 0 ]; then
    record_event "local-bin:$bin" "ok" "$out"
  elif [ "$rc" -eq 124 ]; then
    record_event "local-bin:$bin" "present" "$path present; no bounded --version response"
  else
    record_event "local-bin:$bin" "present" "$path present; --version unavailable"
  fi
}

# probe_runtime <name> <command> [args...]: a runtime version probe; check mode reports the
# resolved path only, because the first match on this job's PATH can be a user-installed wrapper.
probe_runtime() {
  local name="$1" path
  if [ "$CHECK_ONLY" -eq 1 ]; then
    path="$(harness_which "$2")"
    if [ -n "$path" ]; then
      record_event "$name" "present" "$path present; not executed in check mode"
    else
      record_event "$name" "missing" "$2 not found on PATH"
    fi
    return 0
  fi
  shift
  probe_command "$name" "$@"
}

# claude_probe_admission <bin>: 0 when the static classifier finds <bin> to be the native layout,
# or the npm package whose entry point is a node script; otherwise 1 with the reason on stdout.
# Nothing is executed to decide.
claude_probe_admission() {
  local out rc=0
  out="$("$REPO_NODE_BIN" --experimental-strip-types "$REPO_ROOT/scripts/harness-maintenance-guard.ts" \
    --claude-resolve --bin "$1" --home "$HOME" 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "static classification failed"
    return 1
  fi
  # shellcheck disable=SC2016 # a JavaScript program; ${...} is a JS template, not shell.
  printf '%s' "$out" | "$REPO_NODE_BIN" -e '
const fs = require("node:fs");
let s = "";
process.stdin.on("data", (d) => { s += d; }).on("end", () => {
  let r;
  try { r = JSON.parse(s); } catch { console.log("classification unreadable"); process.exit(1); }
  if (r.kind === "native") process.exit(0);
  if (r.kind === "npm" && typeof r.resolved === "string") {
    let head = "";
    try {
      const fd = fs.openSync(r.resolved, "r");
      const buf = Buffer.alloc(256);
      head = buf.subarray(0, fs.readSync(fd, buf, 0, 256, 0)).toString("latin1").split("\n")[0];
      fs.closeSync(fd);
    } catch {}
    if (/^#!\s*(\/usr\/bin\/env\s+node|\/\S*\/node)\s*$/.test(head)) process.exit(0);
    console.log("npm entry point is not a node script");
    process.exit(1);
  }
  console.log(`classified as ${typeof r.kind === "string" ? r.kind : "unknown"}, not native or npm`);
  process.exit(1);
});'
}

probe_tier2() {
  local systemctl_bin apt_bin launcher reason
  if [ "$CHECK_ONLY" -eq 1 ]; then
    # Listing plugins or MCP servers starts the agent CLI, which can refresh MCP authentication.
    record_event "claude-plugins" "skipped" "the agent CLI is not executed in check mode"
    record_event "mcp-servers" "skipped" "the agent CLI is not executed in check mode"
  elif launcher="$(command -v claude)"; then
    # Only a launcher the static classifier accepts is started; anything else could be any script.
    if reason="$(claude_probe_admission "$launcher")"; then
      probe_command "claude-plugins" "$launcher" plugin list
      probe_command "mcp-servers" "$launcher" mcp list
    else
      record_event "claude-plugins" "unknown" "$launcher not executed: $reason"
      record_event "mcp-servers" "unknown" "$launcher not executed: $reason"
    fi
  else
    record_event "claude-plugins" "skipped" "claude binary unavailable"
    record_event "mcp-servers" "skipped" "claude binary unavailable"
  fi

  for bin in pinecone-mcp google-workspace-mcp playwright-mcp sentry-mcp whatsapp-mcp; do
    probe_local_bin "$bin"
  done

  for version in 24.13.0 24.15.0; do
    local npm="$HOME/.nvm/versions/node/v$version/bin/npm"
    if [ ! -x "$npm" ]; then
      record_event "npm-global:$version" "missing" "npm not found for node $version"
    elif [ "$CHECK_ONLY" -eq 1 ] && [ "$npm" != "$CODX_NODE_BIN_DIR/npm" ]; then
      record_event "npm-global:$version" "skipped" "$npm is not the pinned npm; check mode runs no other npm"
    else
      probe_command "npm-global:$version" env PATH="$HOME/.nvm/versions/node/v$version/bin:$PATH" "$npm" ls -g --depth=0
    fi
  done

  probe_runtime "runtime:node" node --version
  probe_runtime "runtime:npm" npm --version
  probe_runtime "runtime:python3" python3 --version

  # Package and service manager tools come from the job's inherited PATH (see job_tool).
  if apt_bin="$(job_tool apt)"; then
    set +e
    local apt_out
    apt_out="$("$apt_bin" list --upgradable 2>/dev/null | grep -E '^(gh|jq|ripgrep|sqlite3|git|ffmpeg|google-chrome-stable)/' || true)"
    set -e
    if [ -n "$apt_out" ]; then
      record_event "apt" "drift" "$apt_out"
    else
      record_event "apt" "ok" "no curated apt package upgrades detected"
    fi
  else
    record_event "apt" "skipped" "apt unavailable"
  fi

  if systemctl_bin="$(job_tool systemctl)"; then
    for unit in whatsoup-fleet.service whatsoup-reply-guarantee.timer harness-maintenance.timer; do
      set +e
      local unit_state
      unit_state="$("$systemctl_bin" --user is-active "$unit" 2>&1)"
      local rc=$?
      set -e
      if [ "$rc" -eq 0 ]; then
        record_event "systemd:$unit" "ok" "$unit active"
      else
        record_event "systemd:$unit" "not-active" "$unit state: $unit_state"
      fi
    done
  else
    record_event "systemd" "skipped" "systemctl unavailable"
  fi

  if [ -x "$REPO_ROOT/scripts/check-unit-drift.sh" ]; then
    set +e
    local drift_out
    drift_out="$("$REPO_ROOT/scripts/check-unit-drift.sh" 2>&1)"
    local drift_rc=$?
    set -e
    if [ "$drift_rc" -eq 0 ]; then
      record_event "systemd-content" "ok" "$drift_out"
    elif [ "$drift_rc" -eq 3 ]; then
      record_event "systemd-content" "skipped" "$drift_out"
    else
      record_event "systemd-content" "drift" "$drift_out"
    fi
  else
    record_event "systemd-content" "skipped" "check-unit-drift.sh unavailable"
  fi
}

# finish_run: aggregate the recorded step results (not variables a step set),
# write the one final state, and return the job's exit code:
#   0  every step returned 0
#   1  a step failed or was inconclusive, or the final state could not be written
#   3  a step reported a partial mutation that needs reconciliation
finish_run() {
  local results="$1" name rc worst=0 failed="" status=ok
  while IFS=$'\t' read -r name rc; do
    [ -n "$name" ] || continue
    [ "$rc" = 0 ] && continue
    failed="$failed $name=$rc"
    if [ "$rc" = 3 ]; then
      worst=3
    elif [ "$worst" -eq 0 ]; then
      worst=1
    fi
  done < "$results"
  if [ -n "$failed" ]; then
    status=degraded
    record_event "harness-maintenance" "degraded" "steps did not complete cleanly:$failed"
    send_alert "job" "warning" "Harness maintenance degraded" "Steps did not complete cleanly:$failed. See $RUN_LOG"
  fi
  if ! finalize_state "$status"; then
    [ "$worst" -ne 0 ] || worst=1
  fi
  log "complete status=$status exit=$worst state=$STATE_FILE"
  return "$worst"
}

main() {
  local results="$TMP_DIR/steps.tsv" rc=0
  : > "$results"
  log "starting mode=$MODE repo=$REPO_ROOT"
  # The launcher as found, before any step can install: out-of-band movement is measured from here.
  if claude_fs facts "$CLAUDE_NATIVE_LAUNCHER" >"$CLAUDE_LAUNCHER_START_FILE.partial" 2>/dev/null; then
    mv "$CLAUDE_LAUNCHER_START_FILE.partial" "$CLAUDE_LAUNCHER_START_FILE"
  fi
  # Each step is a plain statement: whatsoup_run_step must never run in a
  # tested context (see deploy/lib/step-runner.sh).
  whatsoup_run_step "$results" manifest guard_manifest
  if [ "$(whatsoup_step_rc "$results" manifest)" = 0 ]; then
    whatsoup_run_step "$results" npmrc apply_npmrc
    whatsoup_run_step "$results" codex-npm-cooldown check_codex_npm_cooldown
    whatsoup_run_step "$results" claude update_claude
    if [ "$(whatsoup_step_rc "$results" npmrc)" = 0 ]; then
      whatsoup_run_step "$results" codex update_codex
      whatsoup_run_step "$results" opencode update_opencode
    else
      record_event "harness-maintenance" "skipped" "npm updates skipped: the hardened npmrc was not applied"
    fi
  else
    record_event "harness-maintenance" "skipped" "update steps skipped: the managed components manifest did not validate"
  fi
  # After the agent CLI step, so this run's own install is not movement; the baseline follows the
  # probes, so a self-update the listing triggers is attributed to this job, not to the next run.
  whatsoup_run_step "$results" claude-update-path observe_claude_update_path
  whatsoup_run_step "$results" probes probe_tier2
  whatsoup_run_step "$results" claude-launcher record_claude_launcher_baseline
  finish_run "$results" || rc=$?
  exit "$rc"
}

main
