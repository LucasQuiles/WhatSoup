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
export PATH="$NPM_GLOBAL_BIN_DIR:$HOME/.local/bin:$REPO_NODE_BIN_DIR:$PATH"

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

write_state() {
  local status="$1"
  "$REPO_NODE_BIN" - "$EVENTS_FILE" "$STATE_TMP" "$status" "$MODE" <<'NODE'
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
    exit 1
  fi
  mv "$STATE_TMP" "$STATE_FILE"
  chmod 600 "$STATE_FILE"
  if [ "$JSON_OUT" -eq 1 ]; then
    cat "$STATE_FILE"
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

on_error() {
  local rc=$?
  trap - ERR
  record_event "harness-maintenance" "failed" "unexpected failure rc=$rc"
  write_state "failed" || true
  send_alert "job" "warn" "Harness maintenance failed" "Unexpected failure rc=$rc. See $RUN_LOG"
  rm -rf "$TMP_DIR"
  exit "$rc"
}
trap on_error ERR
trap 'rm -rf "$TMP_DIR"' EXIT

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

claude_current() {
  command_version claude --version || true
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

smoke_claude() {
  command -v claude >/dev/null 2>&1 && claude --version >/dev/null 2>&1
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
    send_alert "codex-cooldown-defense" "warn" "Codex npm cooldown check missing npm" "The Codex node npm binary was not found."
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
    send_alert "codex-cooldown-defense" "warn" "Codex npm cooldown check failed" "npm --version failed for Codex node. $err"
    return 0
  fi
  if [ "$config_rc" -ne 0 ]; then
    local err
    err="$(head -n "$PROBE_OUTPUT_LINES" "$stderr_file")"
    record_event "codex-npm-cooldown" "failed" "npm config get min-release-age failed: $err"
    send_alert "codex-cooldown-defense" "warn" "Codex npm cooldown check failed" "npm config get min-release-age failed for Codex node. $err"
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
    send_alert "codex-cooldown-defense" "warn" "Codex npm cooldown defense dormant" "Codex node npm does not fully honor min-release-age. $out"
    return 0
  fi

  record_event "codex-npm-cooldown" "failed" "cooldown recognition guard failed: $out"
  send_alert "codex-cooldown-defense" "warn" "Codex npm cooldown check failed" "Cooldown recognition guard failed. $out"
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
  send_alert "${pkg##*/}-update" "warn" "Npm cooldown check failed" "The maintenance job could not verify publish age for $pkg@$version. $out"
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
    send_alert "opencode-update" "warn" "OpenCode harness install failed" "npm was not found; opencode-ai@$target could not be installed."
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

update_claude() {
  local before latest after
  before="$(claude_current)"
  latest="$(npm_latest_version @anthropic-ai/claude-code || true)"
  if [ -z "$before" ]; then
    record_event "claude" "missing" "claude binary not found"
    send_alert "claude-update" "warn" "Claude harness missing" "The maintenance job could not find the claude binary on PATH."
    return 0
  fi
  if [ -z "$latest" ]; then
    record_event "claude" "unknown" "latest version lookup failed" "$before"
    send_alert "claude-update" "warn" "Claude latest lookup failed" "The maintenance job could not determine the latest Claude CLI version."
    return 0
  fi
  if [ "$before" = "$latest" ]; then
    record_event "claude" "current" "already at latest" "$before" "$before" "$latest"
    return 0
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    record_event "claude" "drift" "update available" "$before" "$before" "$latest"
    return 0
  fi
  claude install latest
  if ! smoke_claude; then
    claude install "$before" || true
    record_event "claude" "rollback" "smoke failed after update; rollback attempted" "$before" "" "$latest"
    send_alert "claude-update" "critical" "Claude harness rollback" "Update to $latest failed smoke check; rollback to $before attempted."
    return 1
  fi
  after="$(claude_current)"
  record_event "claude" "updated" "updated and smoke checked" "$before" "$after" "$latest"
  send_alert "claude-update" "info" "Claude harness updated" "Claude CLI $before -> $after"
}

update_codex() {
  local before latest npm after
  before="$(codex_current)"
  latest="$(npm_latest_version @openai/codex || true)"
  npm="$(npm_bin)"
  if [ -z "$before" ]; then
    record_event "codex" "missing" "codex binary not found"
    send_alert "codex-update" "warn" "Codex harness missing" "The maintenance job could not find the codex binary."
    return 0
  fi
  if [ -z "$latest" ] || [ -z "$npm" ]; then
    record_event "codex" "unknown" "latest version lookup failed" "$before"
    send_alert "codex-update" "warn" "Codex latest lookup failed" "The maintenance job could not determine the latest Codex CLI version."
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
    send_alert "probe-${name//[^A-Za-z0-9_.-]/_}" "warn" "Harness maintenance probe timed out" "$name exceeded ${PROBE_TIMEOUT_SECS}s"
  else
    record_event "$name" "failed" "$out"
    send_alert "probe-${name//[^A-Za-z0-9_.-]/_}" "warn" "Harness maintenance probe failed" "$name failed: $out"
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

main() {
  log "starting mode=$MODE repo=$REPO_ROOT"
  guard_manifest
  apply_npmrc
  check_codex_npm_cooldown
  update_claude
  update_codex
  update_opencode
  probe_tier2
  write_state "ok"
  log "complete state=$STATE_FILE"
}

main
