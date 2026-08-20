#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WHATSOUP_CAPABILITY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export WHATSOUP_CAPABILITY_ROOT

# shellcheck source=deploy/lib/host-capabilities.sh
. "$WHATSOUP_CAPABILITY_ROOT/deploy/lib/host-capabilities.sh"
# shellcheck source=deploy/lib/bounded-exec.sh
. "$WHATSOUP_CAPABILITY_ROOT/deploy/lib/bounded-exec.sh"

# Budgets (seconds) for the three unbounded network steps. A stalled mirror or a
# held dpkg lock must fail fast and legibly instead of silently inheriting the
# 60-minute CI job cap. Defaults are deliberately loose enough that a slow-but-live
# mirror still succeeds; override to tune for an unusually slow mirror, or (in tests)
# to a sub-second value so the fail-fast path is provable without sleeping for minutes.
WHATSOUP_APT_UPDATE_TIMEOUT="${WHATSOUP_APT_UPDATE_TIMEOUT:-300}"
WHATSOUP_PKG_INSTALL_TIMEOUT="${WHATSOUP_PKG_INSTALL_TIMEOUT:-600}"
WHATSOUP_PIP_INSTALL_TIMEOUT="${WHATSOUP_PIP_INSTALL_TIMEOUT:-600}"

# whatsoup_bounded_install <seconds> <label> <command> [args...]
#
# Runs a network install step under whatsoup_run_bounded so a stalled mirror or a
# held package-manager lock fails fast and legibly. A timeout is reported with a
# distinct exit status (124, matching GNU timeout) and a "TIMEOUT" log line, so the
# next person debugging can tell a hang from a genuine install failure at a glance.
# Stdout is routed to stderr so the --json receipt on stdout stays clean.
whatsoup_bounded_install() {
  budget="$1"
  label="$2"
  shift 2

  rc=0
  whatsoup_run_bounded "$budget" "$@" >&2 || rc=$?
  if [ "$rc" -eq 124 ]; then
    echo "host dependency installer: TIMEOUT after ${budget}s waiting on: $label" >&2
    exit 124
  elif [ "$rc" -ne 0 ]; then
    echo "host dependency installer: command failed (exit $rc): $label" >&2
    exit "$rc"
  fi
}

usage() {
  cat >&2 <<'USAGE'
Usage: deploy/scripts/install-host-dependencies.sh --profile <runtime|quality|release> [--node-policy <exact|compatibility>] [--manager <brew|apt|pacman>] [--apply] [--yes] [--json]
USAGE
}

profile=""
node_policy=exact
seen_node_policy=0
manager=""
apply=0
yes=0
json=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      [ -z "$profile" ] && [ "$#" -ge 2 ] || { usage; exit 2; }
      profile="$2"
      shift 2
      ;;
    --manager)
      [ -z "$manager" ] && [ "$#" -ge 2 ] || { usage; exit 2; }
      manager="$2"
      shift 2
      ;;
    --node-policy)
      [ "$seen_node_policy" -eq 0 ] && [ "$#" -ge 2 ] || { usage; exit 2; }
      node_policy="$2"
      seen_node_policy=1
      shift 2
      ;;
    --apply)
      [ "$apply" -eq 0 ] || { usage; exit 2; }
      apply=1
      shift
      ;;
    --yes)
      [ "$yes" -eq 0 ] || { usage; exit 2; }
      yes=1
      shift
      ;;
    --json)
      [ "$json" -eq 0 ] || { usage; exit 2; }
      json=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

case "$profile" in
  runtime|quality|release) ;;
  *) usage; exit 2 ;;
esac
case "$manager" in
  ""|brew|apt|pacman) ;;
  *) usage; exit 2 ;;
esac
case "$node_policy" in
  exact|compatibility) ;;
  *) usage; exit 2 ;;
esac

platform="$(whatsoup_normalize_platform "$(uname -s 2>/dev/null)" 2>/dev/null || true)"
[ -n "$platform" ] || { echo "host dependency installer: unsupported platform" >&2; exit 2; }

if [ -z "$manager" ]; then
  if [ "$platform" = "darwin" ]; then
    manager=brew
  elif command -v apt-get >/dev/null 2>&1; then
    manager=apt
  elif command -v pacman >/dev/null 2>&1; then
    manager=pacman
  else
    echo "host dependency installer: no supported package manager detected" >&2
    exit 2
  fi
fi

case "$platform:$manager" in
  darwin:brew|linux:apt|linux:pacman) ;;
  *)
    echo "host dependency installer: $manager does not match $platform" >&2
    exit 2
    ;;
esac

packages="$(whatsoup_packages_for_manager "$profile" "$platform" "$manager" "$node_policy")" || {
  echo "host dependency installer: could not build package plan" >&2
  exit 2
}

json_packages=""
for package_name in $packages; do
  if [ -n "$json_packages" ]; then
    json_packages="$json_packages,"
  fi
  json_packages="${json_packages}\"$(whatsoup_json_escape "$package_name")\""
done

if [ "$apply" -eq 1 ]; then
  mode=apply
else
  mode=plan
fi

if [ "$json" -eq 1 ]; then
  printf '{"schemaVersion":1,"profile":"%s","nodePolicy":"%s","platform":"%s","manager":"%s","mode":"%s","packages":[%s]}\n' \
    "$(whatsoup_json_escape "$profile")" \
    "$(whatsoup_json_escape "$node_policy")" \
    "$(whatsoup_json_escape "$platform")" \
    "$(whatsoup_json_escape "$manager")" \
    "$mode" \
    "$json_packages"
else
  printf 'WhatSoup host dependency plan: profile=%s node-policy=%s platform=%s manager=%s mode=%s\n' \
    "$profile" "$node_policy" "$platform" "$manager" "$mode"
  for package_name in $packages; do
    printf '  %s\n' "$package_name"
  done
fi

[ "$apply" -eq 1 ] || exit 0

if [ "$yes" -ne 1 ]; then
  printf 'Apply this exact package plan? [y/N] ' >&2
  reply=""
  IFS= read -r reply || true
  case "$reply" in
    y|Y|yes|YES|Yes) ;;
    *) echo "host dependency installer: confirmation required" >&2; exit 2 ;;
  esac
fi

package_args=()
while IFS= read -r package_name; do
  [ -n "$package_name" ] || continue
  package_args[${#package_args[@]}]="$package_name"
done <<EOF
$packages
EOF
case "$manager" in
  brew)
    whatsoup_bounded_install "$WHATSOUP_PKG_INSTALL_TIMEOUT" "brew install" brew install "${package_args[@]}"
    ;;
  apt)
    whatsoup_bounded_install "$WHATSOUP_APT_UPDATE_TIMEOUT" "apt-get update" sudo apt-get update
    whatsoup_bounded_install "$WHATSOUP_PKG_INSTALL_TIMEOUT" "apt-get install" sudo apt-get install -y "${package_args[@]}"
    ;;
  pacman)
    whatsoup_bounded_install "$WHATSOUP_PKG_INSTALL_TIMEOUT" "pacman install" sudo pacman -S --needed --noconfirm "${package_args[@]}"
    ;;
esac

if [ "$profile" = "quality" ] || [ "$profile" = "release" ]; then
  CAP_STATUS=available
  CAP_VERSION=""
  CAP_DETAIL=""
  whatsoup_resolve_python312 || {
    echo "host dependency installer: Python 3.12 or newer was not found after installation" >&2
    exit 1
  }
  whatsoup_probe_python
  [ "$CAP_STATUS" = "available" ] || {
    echo "host dependency installer: Python 3.12 or newer is required" >&2
    exit 1
  }

  base_python="$CAP_PATH"
  venv_root="$(whatsoup_quality_venv_root)"
  mkdir -p "$(dirname "$venv_root")" || exit 1
  "$base_python" -m venv "$venv_root" >&2 || exit 1
  chmod 700 "$venv_root" || exit 1
  venv_python="$venv_root/bin/python"
  [ -x "$venv_python" ] || {
    echo "host dependency installer: managed venv did not create an executable Python" >&2
    exit 1
  }
  whatsoup_bounded_install "$WHATSOUP_PIP_INSTALL_TIMEOUT" "pip install" "$venv_python" -m pip install pytest pytest-cov hypothesis ruff==0.15.10
fi

if ! PATH="$(whatsoup_quality_venv_root)/bin:$PATH" \
  "$WHATSOUP_CAPABILITY_ROOT/deploy/scripts/whatsoup-host-doctor.sh" \
  --profile "$profile" --node-policy "$node_policy" --json >&2; then
  echo "host dependency installer: post-install doctor did not pass" >&2
  exit 1
fi

exit 0
