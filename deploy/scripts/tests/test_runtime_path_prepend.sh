#!/usr/bin/env bash
# Runtime PATH contract: a configured prepend must outrank ~/.local/bin.
#
# Defect this pins (observed 2026-09-01 on a live host): the launcher composed
# the effective PATH as "$home/.local/bin:$node_dir:$inherited_path", which
# unconditionally puts ~/.local/bin AHEAD of everything the LaunchAgent plist
# deliberately ordered. A host had pinned an older claude CLI by putting
# ~/.local/opt/claude-pin/bin first in the plist's EnvironmentVariables.PATH --
# and the launcher silently overrode it, because ~/.local/bin is exactly where
# the CLI auto-updates itself. The pin had been ineffective since the day it was
# created; the auto-updating symlink moved under it and nothing noticed.
#
# The fix keeps the legacy composition EXACTLY when nothing is configured, and
# only adds a leading segment when a host asks for one.
set -euo pipefail

# Anchored to this script's own directory, not the caller's working directory.
# A relative LIB made every "rejects X" assertion below vacuous when the suite
# was invoked from anywhere but the repo root: sourcing failed, the command
# returned non-zero, and a rejection test passed without the helper ever
# running. The declare -F assertion makes that failure mode impossible.
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/runtime-path.sh"
fail=0

check() {
  local label="$1" want="$2" got="$3"
  if [[ "$got" == "$want" ]]; then
    echo "  ok   $label"
  else
    echo "  FAIL $label"
    echo "       want: $want"
    echo "       got : $got"
    fail=1
  fi
}

run() {
  # shellcheck disable=SC1090
  /bin/bash -c '. "$1"; shift; whatsoup_effective_runtime_path "$@"' _ "$LIB" "$@"
}

echo "== the helper under test is actually sourced (anti-vacuity) =="
if /bin/bash -c '. "$1"; declare -F whatsoup_effective_runtime_path >/dev/null' _ "$LIB"; then
  echo "  ok   whatsoup_effective_runtime_path is defined after sourcing $LIB"
else
  echo "  FAIL could not source $LIB -- every rejection assertion below would be vacuous"; fail=1
  echo "RUNTIME_PATH_PREPEND_TEST_FAIL"
  exit 1
fi

echo "== legacy behavior is preserved when nothing is configured =="
check "three-arg form unchanged" \
  "/fixture/user-root/.local/bin:/fixture/node/bin:/loaded/bin" \
  "$(run /fixture/user-root /fixture/node/bin/node /loaded/bin)"

check "explicitly empty prepend is identical to omitting it" \
  "/fixture/user-root/.local/bin:/fixture/node/bin:/loaded/bin" \
  "$(run /fixture/user-root /fixture/node/bin/node /loaded/bin '')"

echo "== an empty prepend must not inject a leading empty PATH entry =="
# A leading ':' in PATH is the CURRENT DIRECTORY. Composing "$prepend:$rest"
# with an empty prepend would silently put CWD first on every host -- a far
# worse bug than the one being fixed.
got_empty="$(run /fixture/user-root /fixture/node/bin/node /loaded/bin '')"
case "$got_empty" in
  :*) echo "  FAIL empty prepend produced a leading ':' (CWD on PATH): $got_empty"; fail=1 ;;
  *)  echo "  ok   no leading empty entry" ;;
esac
case "$got_empty" in
  *::*) echo "  FAIL empty prepend produced an embedded '::' (CWD on PATH): $got_empty"; fail=1 ;;
  *)    echo "  ok   no embedded empty entry" ;;
esac

echo "== a configured prepend outranks ~/.local/bin =="
check "prepend leads, legacy order follows" \
  "/fixture/pin/bin:/fixture/user-root/.local/bin:/fixture/node/bin:/loaded/bin" \
  "$(run /fixture/user-root /fixture/node/bin/node /loaded/bin /fixture/pin/bin)"

got_pin="$(run /fixture/user-root /fixture/node/bin/node /loaded/bin /fixture/pin/bin)"
if [[ "${got_pin%%:*}" == "/fixture/pin/bin" ]]; then
  echo "  ok   pin resolves before the auto-updating ~/.local/bin"
else
  echo "  FAIL first PATH entry is ${got_pin%%:*}, not the configured pin"; fail=1
fi

echo "== multi-segment prepend is passed through verbatim =="
check "colon-separated prepend preserved" \
  "/a/bin:/b/bin:/fixture/user-root/.local/bin:/fixture/node/bin:/loaded/bin" \
  "$(run /fixture/user-root /fixture/node/bin/node /loaded/bin /a/bin:/b/bin)"

echo "== argument validation still fails closed =="
if run /fixture/user-root relative/node/bin /loaded/bin >/dev/null 2>&1; then
  echo "  FAIL accepted a non-absolute node binary"; fail=1
else
  echo "  ok   rejects a non-absolute node binary"
fi
if run "" /fixture/node/bin/node /loaded/bin >/dev/null 2>&1; then
  echo "  FAIL accepted an empty home dir"; fail=1
else
  echo "  ok   rejects an empty home dir"
fi
if run /fixture/user-root /fixture/node/bin/node "" >/dev/null 2>&1; then
  echo "  FAIL accepted an empty inherited PATH"; fail=1
else
  echo "  ok   rejects an empty inherited PATH"
fi

echo "== the export wrapper honours WHATSOUP_PATH_PREPEND =="
got_env="$(WHATSOUP_PATH_PREPEND=/fixture/pin/bin PATH=/loaded/bin /bin/bash -c \
  '. "$1"; whatsoup_export_runtime_path /fixture/user-root /fixture/node/bin/node; printf "%s" "$PATH"' _ "$LIB")"
check "env-configured prepend reaches the exported PATH" \
  "/fixture/pin/bin:/fixture/user-root/.local/bin:/fixture/node/bin:/loaded/bin" \
  "$got_env"

got_env_unset="$(PATH=/loaded/bin /bin/bash -c \
  '. "$1"; whatsoup_export_runtime_path /fixture/user-root /fixture/node/bin/node; printf "%s" "$PATH"' _ "$LIB")"
check "unset env var leaves the legacy exported PATH unchanged" \
  "/fixture/user-root/.local/bin:/fixture/node/bin:/loaded/bin" \
  "$got_env_unset"

echo "== an empty segment in the configured prepend fails closed =="
# An empty PATH entry means the CURRENT DIRECTORY. arg 4 is config-owned and
# already validated upstream, so an empty segment here can only come from a
# hand-set WHATSOUP_PATH_PREPEND. Refusing to start beats putting CWD ahead of
# every system binary on a service PATH.
for bad_prepend in ":/fixture/pin/bin" "/fixture/pin/bin:" "/fixture/a/bin::/fixture/b/bin"; do
  if err="$(run /fixture/user-root /fixture/node/bin/node /loaded/bin "$bad_prepend" 2>&1 >/dev/null)"; then
    echo "  FAIL accepted an empty prepend segment: $bad_prepend"; fail=1
  elif [[ "$err" == FATAL:* ]]; then
    echo "  ok   rejects '$bad_prepend' with a FATAL line"
  else
    echo "  FAIL rejected '$bad_prepend' without a FATAL line: $err"; fail=1
  fi
done

echo "== every configured prepend segment must be absolute, clean and unpadded =="
# MED-4. The empty-segment check above was the ONLY validation arg 4 received,
# and its comment claimed the value was "config-owned and already validated
# upstream". That is true of the fleet-config route and false of the other two:
# WHATSOUP_PATH_PREPEND is read straight from the process environment by
# whatsoup_export_runtime_path, and on Linux it is settable through the unit's
# optional environment files (docs/configuration.md, "Platform scope"). Neither
# route passes the config validator, and this helper is where both converge, so
# it validates rather than trusts.
#
# A relative segment is the same hazard as an empty one by another spelling: it
# resolves against the launcher's CWD and lands ahead of every system binary on
# a service PATH. Control characters and padding are rejected because a value
# launchd or a shell will happily carry is not necessarily one the operator
# meant, and a newline in particular would split the exported PATH.
#
# Labels are written out rather than interpolated: several of these values
# contain a newline or a control character, and echoing them raw would corrupt
# this suite's own output.
reject_prepend() {
  local label="$1" value="$2" err
  if err="$(run /fixture/user-root /fixture/node/bin/node /loaded/bin "$value" 2>&1 >/dev/null)"; then
    echo "  FAIL accepted $label"; fail=1
  elif [[ "$err" == FATAL:* ]]; then
    echo "  ok   rejects $label with a FATAL line"
  else
    echo "  FAIL rejected $label without a FATAL line: $err"; fail=1
  fi
}

reject_prepend "a bare relative segment"                 "relative/bin"
reject_prepend "the current directory '.'"               "."
reject_prepend "the parent directory '..'"               ".."
reject_prepend "a dot-relative segment './bin'"          "./bin"
# Not merely the first segment: every one is checked.
reject_prepend "a relative segment among absolute ones"  "/fixture/a/bin:.:/fixture/b/bin"
reject_prepend "a leading space"                         " /fixture/pin/bin"
reject_prepend "a trailing space"                        "/fixture/pin/bin "
reject_prepend "a leading tab"                           "$(printf '\t/fixture/pin/bin')"
reject_prepend "an embedded newline"                     "$(printf '/fixture/pin/bin\n/fixture/other/bin')"
reject_prepend "a trailing carriage return"              "$(printf '/fixture/pin/bin\r')"
reject_prepend "an embedded control character"           "$(printf '/fixture/pin\001bin')"

# Positive controls. Without these the block above is satisfied by a validator
# that rejects everything, which would fail every host that configures a prepend.
check "a single absolute segment is still accepted" \
  "/fixture/pin/bin:/fixture/user-root/.local/bin:/fixture/node/bin:/loaded/bin" \
  "$(run /fixture/user-root /fixture/node/bin/node /loaded/bin /fixture/pin/bin)"

check "several absolute segments are still accepted" \
  "/fixture/a/bin:/fixture/b/bin:/fixture/user-root/.local/bin:/fixture/node/bin:/loaded/bin" \
  "$(run /fixture/user-root /fixture/node/bin/node /loaded/bin /fixture/a/bin:/fixture/b/bin)"

# The rule is SURROUNDING whitespace, not any whitespace: a space inside a
# directory name is a legal path character and a real one on macOS.
check "an interior space is a path character, not padding" \
  "/fixture/pin bin:/fixture/user-root/.local/bin:/fixture/node/bin:/loaded/bin" \
  "$(run /fixture/user-root /fixture/node/bin/node /loaded/bin '/fixture/pin bin')"

echo "== an empty segment in the inherited PATH is collapsed, not rejected =="
# The launcher runs under `set -euo pipefail` and calls the wrapper bare, so
# rejecting arg 3 would fail bot start on any host whose ambient PATH already
# contains "::". Collapsing removes the CWD hazard without that blast radius.
check "embedded empty entry collapses" \
  "/fixture/user-root/.local/bin:/fixture/node/bin:/fixture/a/bin:/fixture/b/bin" \
  "$(run /fixture/user-root /fixture/node/bin/node /fixture/a/bin::/fixture/b/bin)"

check "leading empty entry is stripped" \
  "/fixture/user-root/.local/bin:/fixture/node/bin:/fixture/a/bin" \
  "$(run /fixture/user-root /fixture/node/bin/node :/fixture/a/bin)"

check "trailing empty entry is stripped" \
  "/fixture/user-root/.local/bin:/fixture/node/bin:/fixture/a/bin" \
  "$(run /fixture/user-root /fixture/node/bin/node /fixture/a/bin:)"

echo "== an all-empty inherited PATH still fails closed =="
for bad_inherited in "::" ":::" ":"; do
  if run /fixture/user-root /fixture/node/bin/node "$bad_inherited" >/dev/null 2>&1; then
    echo "  FAIL accepted an all-empty inherited PATH: '$bad_inherited'"; fail=1
  else
    echo "  ok   rejects an all-empty inherited PATH: '$bad_inherited'"
  fi
done

echo "== the prepend outranks the pinned node dir, deliberately =="
# A prepend directory holding a `node` binary shadows the WHATSOUP_NODE pin for
# child processes. The launcher uses "$NODE" absolutely so it is unaffected, but
# the exported PATH is inherited. Pinned here so a reorder is a deliberate act.
got_order="$(run /fixture/user-root /fixture/node/bin/node /loaded/bin /fixture/pin/bin)"
prepend_rank=-1; node_rank=-1; rank=0
IFS=: read -r -a order_entries <<< "$got_order"
for entry in "${order_entries[@]}"; do
  [[ "$entry" == "/fixture/pin/bin" && "$prepend_rank" -lt 0 ]] && prepend_rank="$rank"
  [[ "$entry" == "/fixture/node/bin" && "$node_rank" -lt 0 ]] && node_rank="$rank"
  rank=$((rank + 1))
done
if [[ "$prepend_rank" -ge 0 && "$node_rank" -ge 0 && "$prepend_rank" -lt "$node_rank" ]]; then
  echo "  ok   prepend (rank $prepend_rank) precedes the pinned node dir (rank $node_rank)"
else
  echo "  FAIL prepend rank $prepend_rank vs node dir rank $node_rank in: $got_order"; fail=1
fi

echo "== a failed export leaves the caller's PATH intact =="
# The wrapper composes into a local before assigning, so a rejected prepend must
# not blank the caller's PATH on its way out.
got_preserved="$(WHATSOUP_PATH_PREPEND=/fixture/pin/bin: PATH=/loaded/bin /bin/bash -c \
  '. "$1"; whatsoup_export_runtime_path /fixture/user-root /fixture/node/bin/node 2>/dev/null; printf "%s" "$PATH"' _ "$LIB")"
check "PATH survives a rejected prepend" "/loaded/bin" "$got_preserved"

if [[ "$fail" -ne 0 ]]; then
  echo "RUNTIME_PATH_PREPEND_TEST_FAIL"
  exit 1
fi
echo "RUNTIME_PATH_PREPEND_TEST_OK"
