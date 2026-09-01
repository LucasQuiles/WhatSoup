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

LIB=deploy/lib/runtime-path.sh
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

if [[ "$fail" -ne 0 ]]; then
  echo "RUNTIME_PATH_PREPEND_TEST_FAIL"
  exit 1
fi
echo "RUNTIME_PATH_PREPEND_TEST_OK"
