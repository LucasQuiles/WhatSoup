#!/usr/bin/env bash
set -euo pipefail

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

  --check  Dry-run: validate, inventory, and report without mutating versions.
  --json   Print final state JSON to stdout.
USAGE
}

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
NPM_GLOBAL_PREFIX="${WHATSOUP_HARNESS_NPM_GLOBAL_PREFIX:-$HOME/.local/share/whatsoup/npm-global}"
NPM_GLOBAL_BIN_DIR="$NPM_GLOBAL_PREFIX/bin"
ALERT_BIN="${WHATSOUP_ALERT_BIN:-$HOME/.local/bin/whatsapp-alert}"
PROBE_TIMEOUT_SECS="${WHATSOUP_HARNESS_MAINTENANCE_PROBE_TIMEOUT_SECS:-10}"
PROBE_OUTPUT_LINES="${WHATSOUP_HARNESS_MAINTENANCE_PROBE_OUTPUT_LINES:-200}"
REPO_NODE_BIN_DIR="$(dirname "$REPO_NODE_BIN")"
# Captured before the rewrite below. Used ONLY to locate service-manager tools
# (plutil, systemctl), never as a service instance's PATH: an instance runs
# with its own service definition's PATH, not this job's.
JOB_INHERITED_PATH="$PATH"
export PATH="$NPM_GLOBAL_BIN_DIR:$HOME/.local/bin:$REPO_NODE_BIN_DIR:$PATH"
# The native installer's own launcher link. It is updated only when every
# service instance on this host resolves exactly this path (see
# claude_service_inventory); any other layout or pin holds the update.
CLAUDE_NATIVE_LAUNCHER="$HOME/.local/bin/claude"
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

# Service-manager tools come from the job's inherited PATH, never from the rewritten PATH above,
# so a user-writable directory cannot shadow them.
job_tool() {
  path_first_executable "$JOB_INHERITED_PATH" "$1"
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

claude_inventory_launchd() {
  local dir="$HOME/Library/LaunchAgents" file name label program arg1 path_value prepend node
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
      continue
    fi
    label="$(plist_string "$file" Label || true)"
    program="$(plist_string "$file" ProgramArguments.0 || true)"
    arg1="$(plist_string "$file" ProgramArguments.1 || true)"
    if [ "$label" != "com.whatsoup.$name" ] || [ "$program" != "$HOME/.local/bin/whatsoup" ] || [ "$arg1" != "$name" ]; then
      record_event "claude-consumer" "skipped" "${file##*/} is not a generated instance plist (label or program differs)"
      continue
    fi
    path_value="$(plist_string "$file" EnvironmentVariables.PATH || true)"
    prepend="$(plist_string "$file" EnvironmentVariables.WHATSOUP_PATH_PREPEND || true)"
    node="$(plist_string "$file" EnvironmentVariables.WHATSOUP_NODE || true)"
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
    case "$line" in
      PATH=*|WHATSOUP_PATH_PREPEND=*|WHATSOUP_NODE=*) ;;
      *) continue ;;
    esac
    systemd_assign "$line" || return 1
  done < "$1"
}

claude_inventory_systemd() {
  local units unit name show manager_env rc=0
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
    if [ "$rc" -eq 0 ]; then
      while IFS= read -r line; do
        case "$line" in PATH=*) systemd_assign "$line" || SYSTEMD_ENV_PATH="" ;; esac
      done <<< "$manager_env"
    fi
    if ! show="$("$SYSTEMCTL_BIN" --user show -p Environment -p EnvironmentFiles "$unit" 2>/dev/null)"; then
      claude_consumer_record "$name" systemd unknown "" "" "" "systemctl show failed for $unit"
      continue
    fi
    if ! systemd_unit_environment "$show"; then
      claude_consumer_record "$name" systemd unknown "" "" "" "unit environment for $unit is not statically readable"
      continue
    fi
    claude_resolve_consumer "$name" systemd "$SYSTEMD_ENV_PATH" "$SYSTEMD_ENV_PREPEND" "$SYSTEMD_ENV_NODE"
  done <<< "$units"
}

# claude_service_inventory: fill CLAUDE_CONSUMERS_FILE with one line per instance
# (name, manager, status, bin, kind, configured version). Returns 1 with a reason on stdout when
# the service manager itself cannot be read; zero instances is a successful empty inventory.
claude_service_inventory() {
  case "$SERVICE_MANAGER" in
    launchd) claude_inventory_launchd ;;
    systemd) claude_inventory_systemd ;;
    *)
      echo "unsupported service manager: $SERVICE_MANAGER"
      return 1 ;;
  esac
}

codex_bin() {
  if [ -x "$CODX_NODE_BIN_DIR/codex" ]; then
    echo "$CODX_NODE_BIN_DIR/codex"
  else
    command -v codex || true
  fi
}

npm_bin() {
  if [ -x "$CODX_NODE_BIN_DIR/npm" ]; then
    echo "$CODX_NODE_BIN_DIR/npm"
  else
    command -v npm || true
  fi
}

codex_current() {
  local bin
  bin="$(codex_bin)"
  if [ -z "$bin" ]; then
    return 0
  fi
  CODEX_NO_DEFAULTS=1 "$bin" --version 2>/dev/null | parse_version
}

opencode_bin() {
  if [ -x "$NPM_GLOBAL_BIN_DIR/opencode" ]; then
    echo "$NPM_GLOBAL_BIN_DIR/opencode"
  else
    command -v opencode || true
  fi
}

opencode_current() {
  local bin
  bin="$(opencode_bin)"
  if [ -z "$bin" ]; then
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
  npm="$(npm_bin)"
  if [ -z "$npm" ]; then
    record_event "codex-npm-cooldown" "missing" "npm not found for Codex node"
    send_alert "codex-cooldown-defense" "warning" "Codex npm cooldown check missing npm" "The Codex node npm binary was not found."
    return 0
  fi

  local expected_days min_version stderr_file npm_version smoke_dir smoke_rc
  expected_days="$(manifest_npmrc_min_release_age_days)"
  min_version="$(manifest_codex_npm_min_version)"
  stderr_file="$(mktemp "$TMP_DIR/codex-npm-cooldown.stderr.XXXXXX")"
  smoke_dir="$(mktemp -d "$TMP_DIR/codex-npm-smoke.XXXXXX")"

  set +e
  npm_version="$(PATH="$CODX_NODE_BIN_DIR:$PATH" "$npm" --version 2>"$stderr_file" | tail -n 1)"
  local version_rc=$?
  PATH="$CODX_NODE_BIN_DIR:$PATH" "$npm" config get min-release-age >/dev/null 2>>"$stderr_file"
  local config_rc=$?
  PATH="$CODX_NODE_BIN_DIR:$PATH" "$npm" install is-number@7.0.0 \
    --dry-run \
    --ignore-scripts \
    --package-lock=false \
    --no-save \
    --prefix "$smoke_dir" >/dev/null 2>>"$stderr_file"
  smoke_rc=$?
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

  if [ "$rc" -eq 0 ]; then
    record_event "codex-npm-cooldown" "ok" "npm $npm_version accepts min-release-age=${expected_days}d"
    return 0
  fi
  if [ "$rc" -eq 2 ]; then
    record_event "codex-npm-cooldown" "degraded" "npm $npm_version: $out"
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
#                                            points at <expected>; 4 read-back mismatch
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
  fs.symlinkSync(replacement, tmp);
  if (safe(() => fs.readlinkSync(link)) !== expected) { fs.unlinkSync(tmp); process.exit(3); }
  fs.renameSync(tmp, link);
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
  local target="$1" policy verdict kind version message facts real out rc=0
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
  IFS=$'\037' read -r _ real _ <<< "$facts"
  if [ -z "$real" ]; then
    echo "launcher does not resolve after install"
    return 1
  fi
  whatsoup_run_bounded "$VERSION_TIMEOUT_SECS" "$real" --version >"$TMP_DIR/claude-version.out" 2>/dev/null </dev/null || rc=$?
  out="$(parse_version < "$TMP_DIR/claude-version.out" || true)"
  if [ "$rc" -ne 0 ] || [ "$out" != "$target" ]; then
    echo "--version of $real returned rc=$rc version=${out:-none}"
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
    if [ "$rollback_rc" -ne 0 ]; then
      record_event "claude" "rollback-failed" "launcher moved since the install (swap rc=$rollback_rc); left as found" "$before" "" "$target"
      send_alert "claude-update" "critical" "Agent CLI rollback failed" "$failure. The launcher changed after the install, so it was not swapped back. Reconcile by hand."
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

update_codex() {
  local before latest npm after
  before="$(codex_current)"
  latest="$(npm_latest_version @openai/codex || true)"
  npm="$(npm_bin)"
  if [ -z "$before" ]; then
    record_event "codex" "missing" "codex binary not found"
    send_alert "codex-update" "warning" "Codex harness missing" "The maintenance job could not find the codex binary."
    return 0
  fi
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
  if [ -z "$before" ]; then
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
  path="$(command -v "$bin" || true)"
  if [ -z "$path" ]; then
    record_event "local-bin:$bin" "missing" "$bin not found on PATH"
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

probe_tier2() {
  if command -v claude >/dev/null 2>&1; then
    probe_command "claude-plugins" claude plugin list
    probe_command "mcp-servers" claude mcp list
  else
    record_event "claude-plugins" "skipped" "claude binary unavailable"
    record_event "mcp-servers" "skipped" "claude binary unavailable"
  fi

  for bin in pinecone-mcp google-workspace-mcp playwright-mcp sentry-mcp whatsapp-mcp; do
    probe_local_bin "$bin"
  done

  for version in 24.13.0 24.15.0; do
    local npm="$HOME/.nvm/versions/node/v$version/bin/npm"
    if [ -x "$npm" ]; then
      probe_command "npm-global:$version" env PATH="$HOME/.nvm/versions/node/v$version/bin:$PATH" "$npm" ls -g --depth=0
    else
      record_event "npm-global:$version" "missing" "npm not found for node $version"
    fi
  done

  probe_command "runtime:node" node --version
  probe_command "runtime:npm" npm --version
  probe_command "runtime:python3" python3 --version

  if command -v apt >/dev/null 2>&1; then
    set +e
    local apt_out
    apt_out="$(apt list --upgradable 2>/dev/null | grep -E '^(gh|jq|ripgrep|sqlite3|git|ffmpeg|google-chrome-stable)/' || true)"
    set -e
    if [ -n "$apt_out" ]; then
      record_event "apt" "drift" "$apt_out"
    else
      record_event "apt" "ok" "no curated apt package upgrades detected"
    fi
  else
    record_event "apt" "skipped" "apt unavailable"
  fi

  if command -v systemctl >/dev/null 2>&1; then
    for unit in whatsoup-fleet.service whatsoup-reply-guarantee.timer harness-maintenance.timer; do
      set +e
      local unit_state
      unit_state="$(systemctl --user is-active "$unit" 2>&1)"
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
  whatsoup_run_step "$results" probes probe_tier2
  finish_run "$results" || rc=$?
  exit "$rc"
}

main
