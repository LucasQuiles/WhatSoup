#!/usr/bin/env bash
# ============================================================================
# whatsoup-release-drift-linux.sh
# Linux (systemd) parity for macOS com.whatsoup.release-drift-check.plist.
# ----------------------------------------------------------------------------
# The macOS plist derives the CURRENTLY-DEPLOYED release from the launchd job's
# ProgramArguments (--launchd-plist). The Linux analog derives it from the
# launcher symlink ~/.local/bin/whatsoup on each run, so it follows cutovers that
# re-point the launcher without edits. It observes the release the launcher
# points into, which a running whatsoup@<instance> may not have restarted into
# yet; that release must hold .whatsoup-release-manifest.json, which an exported
# release has and a clone does not, or every run is inconclusive (exit 2).
#
# Emits release-integrity (drift) + release-currency (differs from the target ref) alerts
# through the existing BOT ERRORS outbox pipeline (deploy/scripts/bot-errors-emit.py),
# and clears them on a clean run (--clear-on-ok). Fail-closed exit codes:
#   0 clean, or target differs (advisory; the currency finding is emitted)
#   1 integrity drift (alert emitted)
#   2 inconclusive, either emit failure included, and exit 1 from a release
#     whose scheduler predates --bootstrap-exit-code 2 (fails the systemd unit;
#     see deploy/whatsoup-release-drift.service)
# ============================================================================
set -uo pipefail

fail(){ echo "whatsoup-release-drift-linux: $1" >&2; exit "${2:-2}"; }

# The defaults below build on HOME. Unset, it would end the run through set -u
# with a status the unit may count as success.
[ -n "${HOME:-}" ] || fail "HOME is not set"

LAUNCHER="${WHATSOUP_LAUNCHER:-$HOME/.local/bin/whatsoup}"
# The macOS renderer's default (render-release-drift-launchd.sh). HTTPS, since a
# systemd user unit has no SSH agent socket by default; set the variable for an
# SSH remote.
TARGET_URL="${WHATSOUP_RELEASE_TARGET_URL:-https://github.com/LucasQuiles/WhatSoup.git}"
TARGET_REF="${WHATSOUP_RELEASE_TARGET_REF:-refs/heads/main}"
export WHATSOUP_RELEASE_DRIFT_LOG_DIR="${WHATSOUP_RELEASE_DRIFT_LOG_DIR:-$HOME/.local/state/whatsoup/logs}"

# The BOT ERRORS instance label of this host's release alerts and clears. systemd
# is the only parser of its value: the label is WHATSOUP_RELEASE_DRIFT_INSTANCE as
# systemd hands it over, and it is used only when the label file,
# .config/whatsoup/release-drift.env in the home folder the user database names
# for this user, assigns that same value. Otherwise the run exits 2: no label
# file, a file that cannot be read, no assignment there, or a different value.
# The unit also loads bot-errors.env, which every BOT ERRORS unit loads, so a
# label set only there is refused, and a value this reader takes differently
# from systemd ends in a refusal, never in another label. WHATSOUP_INSTANCE is
# never read: bot-errors.env, the user manager or a drop-in can set it for other
# units and per-instance agent state.

# The last assignment of a key in an environment file, read as systemd reads
# the ordinary forms. deploy/setup.sh holds the same function.
read_env_label() {
  # $1 file, $2 key. Leading whitespace and "#" or ";" comment lines are
  # skipped; trailing whitespace and one pair of matching quotes around the
  # whole value are removed. A value systemd reads otherwise, such as one with
  # escapes or a quoted value over several lines, reads differently here.
  awk -v key="$2" -v sq="'" -v dq='"' '
    { line = $0; sub(/^[ \t]+/, "", line) }
    line ~ /^[#;]/ { next }
    index(line, key "=") == 1 {
      value = substr(line, length(key) + 2)
      sub(/[ \t\r]+$/, "", value)
      first = substr(value, 1, 1)
      if (length(value) >= 2 && (first == sq || first == dq) && substr(value, length(value)) == first) {
        value = substr(value, 2, length(value) - 2)
      }
      found = 1
    }
    END { if (found) printf "%s", value }
  ' "$1"
}

# The home folder the user database names for this user. systemd's %h is the
# user manager's own HOME, which a manager started from the user database takes
# from there and which no unit setting changes; the HOME of this run can come
# from bot-errors.env or a drop-in. There is no fallback to HOME.
database_home() {
  local entry name password uid gid gecos home shell
  entry="$(getent passwd "$(id -u)")" || return 1
  IFS=: read -r name password uid gid gecos home shell <<<"$entry"
  [[ "$home" == /* ]] || return 1
  printf '%s\n' "$home"
}

DATABASE_HOME="$(database_home)" \
  || fail "cannot find this user's home folder in the user database (getent passwd)"
LABEL_FILE="$DATABASE_HOME/.config/whatsoup/release-drift.env"
ENV_LABEL="${WHATSOUP_RELEASE_DRIFT_INSTANCE:-}"
ignored=""
[ -z "$ENV_LABEL" ] || ignored=" (the value in the environment is ignored: bot-errors.env can set it)"
if [ ! -e "$LABEL_FILE" ] && [ ! -L "$LABEL_FILE" ]; then
  fail "WHATSOUP_RELEASE_DRIFT_INSTANCE is not set; write WHATSOUP_RELEASE_DRIFT_INSTANCE=<instance> to ~/.config/whatsoup/release-drift.env$ignored"
fi
# Only a readable regular file is read, through a symlink as systemd reads it.
# A folder, a FIFO, which would block the read, or a dangling link fails here.
FILE_LABEL=""
{ [ -f "$LABEL_FILE" ] && [ -r "$LABEL_FILE" ] \
    && FILE_LABEL="$(read_env_label "$LABEL_FILE" WHATSOUP_RELEASE_DRIFT_INSTANCE)"; } \
  || fail "cannot read the label file ~/.config/whatsoup/release-drift.env"
[ -n "$FILE_LABEL" ] \
  || fail "WHATSOUP_RELEASE_DRIFT_INSTANCE is not set; write WHATSOUP_RELEASE_DRIFT_INSTANCE=<instance> to ~/.config/whatsoup/release-drift.env$ignored"
[ "$FILE_LABEL" = "$ENV_LABEL" ] \
  || fail "WHATSOUP_RELEASE_DRIFT_INSTANCE as systemd loaded it does not match the label read from ~/.config/whatsoup/release-drift.env: write that file as one line, WHATSOUP_RELEASE_DRIFT_INSTANCE=<instance>, and run the unit through systemd"
INSTANCE="$ENV_LABEL"
# The label follows --instance, where a leading dash reads as another option:
# the scheduler answers --help with exit 0 and observes nothing. deploy/setup.sh
# refuses the same labels.
[[ "$INSTANCE" =~ ^[A-Za-z0-9._][A-Za-z0-9._-]*$ ]] \
  || fail "unsafe WHATSOUP_RELEASE_DRIFT_INSTANCE: use only letters, digits, dot, underscore, and dash, and do not begin with a dash"

# Resolve deployed release root from the launcher symlink:
#   <root>/deploy/whatsoup  ->  strip trailing /deploy/whatsoup
# Portable symlink resolution (GNU-only canonicalising flags are avoided): follow each link hop,
# then canonicalise the final directory with `pwd -P`.
resolve_path() {
  local path="$1" link hops=0
  while [ -L "$path" ]; do
    [ "$hops" -lt 40 ] || return 1
    link="$(readlink -- "$path")" || return 1
    case "$link" in
      /*) path="$link" ;;
      *) path="$(dirname -- "$path")/$link" ;;
    esac
    hops=$((hops + 1))
  done
  [ -e "$path" ] || return 1
  printf '%s/%s\n' "$(cd -P -- "$(dirname -- "$path")" && pwd -P)" "$(basename -- "$path")"
}

target="$(resolve_path "$LAUNCHER")" || fail "cannot resolve launcher $LAUNCHER"
case "$target" in
  */deploy/whatsoup) RELEASE_ROOT="${target%/deploy/whatsoup}" ;;
  *) fail "launcher target has unexpected shape: $target" ;;
esac
[ -d "$RELEASE_ROOT" ] || fail "resolved release root does not exist: $RELEASE_ROOT"
[ -f "$RELEASE_ROOT/scripts/live-release-observers.ts" ] && \
  [ -f "$RELEASE_ROOT/deploy/scripts/run-release-drift-schedule.sh" ] || \
  fail "release root missing observer entrypoints: $RELEASE_ROOT"

SCHEDULER="$RELEASE_ROOT/deploy/scripts/run-release-drift-schedule.sh"
# Pin the scheduler's rotation, runner and observer to this release: it takes
# them from WHATSOUP_REPO_ROOT, which the unit's environment may set to another
# tree whose runner exits 1 without observing.
WHATSOUP_REPO_ROOT="$RELEASE_ROOT" bash "$SCHEDULER" \
  --release "$RELEASE_ROOT" \
  --repo-root "$RELEASE_ROOT" \
  --target-url "$TARGET_URL" \
  --target-ref "$TARGET_REF" \
  --instance "$INSTANCE" \
  --clear-on-ok
status=$?
# Exit 1 is alerted drift only when the observer ran. A scheduler that starts its
# runner with --bootstrap-exit-code 2 never gets 1 from a runner or loading failure
# (scripts/run-with-pinned-node.sh turns that 1 into 2), so its exit 1 comes from
# the observer. A release exported before that contract has a runner that also
# exits 1 when Node is missing or its bootstrap fails, so exit 1 from it is
# reported as 2.
if [ "$status" -eq 1 ] && ! grep -Eq '^[[:space:]]+--bootstrap-exit-code 2([[:space:]]|$)' "$SCHEDULER"; then
  fail "exit 1 from a release whose scheduler predates --bootstrap-exit-code 2 cannot show that the observer ran: $RELEASE_ROOT"
fi
exit "$status"
