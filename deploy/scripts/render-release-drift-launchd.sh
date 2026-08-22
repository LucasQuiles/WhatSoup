#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
default_repo_root="$(cd "$script_dir/../.." && pwd -P)"

repo_root="${WHATSOUP_REPO_ROOT:-$default_repo_root}"
home_dir="${HOME:?}"
instance=""
output=""
target_url="${WHATSOUP_RELEASE_TARGET_URL:-https://github.com/LucasQuiles/WhatSoup.git}"
target_ref="${WHATSOUP_RELEASE_TARGET_REF:-refs/heads/main}"
max_log_bytes="${WHATSOUP_RELEASE_DRIFT_MAX_LOG_BYTES:-5242880}"
keep_rotated_logs="${WHATSOUP_RELEASE_DRIFT_KEEP_ROTATED_LOGS:-5}"

usage() {
  cat >&2 <<'USAGE'
Usage: deploy/scripts/render-release-drift-launchd.sh --instance <name> [options]

Render deploy/com.whatsoup.release-drift-check.plist with install-time placeholders
resolved. Prints to stdout by default.

Options:
  --instance <name>    Target bot plist stem in com.whatsoup.<name>.plist
  --repo-root <path>   Absolute WhatSoup repo path (default: script repo)
  --home <path>        Absolute home directory (default: $HOME)
  --output <path>      Absolute non-live path to write instead of stdout
  --target-url <url>   Explicit HTTPS/SSH Git remote used for currency observation
  --target-ref <ref>   Full refs/heads/... target (default: refs/heads/main)
  --max-log-bytes <n>  Rotation cap per log file in bytes (default: 5242880)
  --keep-rotated-logs <n>  Gzipped generations kept per log file (default: 5)
  --help              Show this help
USAGE
}

fail() {
  echo "$1" >&2
  exit "${2:-2}"
}

take_value() {
  local flag="$1"
  local value="${2:-}"
  if [[ -z "$value" ]]; then
    fail "$flag requires a value"
  fi
  printf '%s' "$value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance)
      instance="$(take_value "$1" "${2:-}")"
      shift 2
      ;;
    --repo-root)
      repo_root="$(take_value "$1" "${2:-}")"
      shift 2
      ;;
    --home)
      home_dir="$(take_value "$1" "${2:-}")"
      shift 2
      ;;
    --output)
      output="$(take_value "$1" "${2:-}")"
      shift 2
      ;;
    --target-url)
      target_url="$(take_value "$1" "${2:-}")"
      shift 2
      ;;
    --target-ref)
      target_ref="$(take_value "$1" "${2:-}")"
      shift 2
      ;;
    --max-log-bytes)
      max_log_bytes="$(take_value "$1" "${2:-}")"
      shift 2
      ;;
    --keep-rotated-logs)
      keep_rotated_logs="$(take_value "$1" "${2:-}")"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

if [[ -z "$instance" ]]; then
  fail "missing --instance"
fi
if [[ "$repo_root" != /* ]]; then
  fail "--repo-root must be absolute"
fi
if [[ "$home_dir" != /* ]]; then
  fail "--home must be absolute"
fi
if [[ ! "$instance" =~ ^[A-Za-z0-9._-]+$ ]]; then
  fail "unsafe --instance: use only letters, digits, dot, underscore, and dash"
fi
if [[ ! "$target_url" =~ ^https://[A-Za-z0-9._~:/@%+-]+$ && ! "$target_url" =~ ^ssh://[A-Za-z0-9._~:/@%+-]+$ && ! "$target_url" =~ ^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/%+-]+$ ]]; then
  fail "unsafe --target-url: use a credential-free HTTPS or SSH Git URL"
fi
if [[ ! "$target_ref" =~ ^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]*$ || "$target_ref" == *..* || "$target_ref" == *//* || "$target_ref" == */ || "$target_ref" == *. ]]; then
  fail "unsafe --target-ref: use a full refs/heads/... name"
fi
if [[ ! "$max_log_bytes" =~ ^[0-9]+$ || "$max_log_bytes" -le 0 ]]; then
  fail "unsafe --max-log-bytes: use a positive integer byte cap"
fi
if [[ ! "$keep_rotated_logs" =~ ^[0-9]+$ || "$keep_rotated_logs" -le 0 ]]; then
  fail "unsafe --keep-rotated-logs: use a positive integer generation count"
fi

template="$repo_root/deploy/com.whatsoup.release-drift-check.plist"
if [[ ! -f "$template" ]]; then
  fail "missing release drift LaunchAgent template: $template"
fi

if [[ -n "$output" ]]; then
  if [[ "$output" != /* ]]; then
    fail "--output must be absolute"
  fi
  launch_agents_dir="$home_dir/Library/LaunchAgents"
  case "$output" in
    "$launch_agents_dir"|"$launch_agents_dir"/*)
      fail "refusing to write directly to LaunchAgents; render to a staging path first"
      ;;
  esac
fi

escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[\/&|\\]/\\&/g'
}

repo_root_replacement="$(escape_sed_replacement "$repo_root")"
home_replacement="$(escape_sed_replacement "$home_dir")"
instance_replacement="$(escape_sed_replacement "$instance")"
target_url_replacement="$(escape_sed_replacement "$target_url")"
target_ref_replacement="$(escape_sed_replacement "$target_ref")"
max_log_bytes_replacement="$(escape_sed_replacement "$max_log_bytes")"
keep_rotated_logs_replacement="$(escape_sed_replacement "$keep_rotated_logs")"

rendered="$(
  sed \
    -e "s|__WHATSOUP_REPO_ROOT__|$repo_root_replacement|g" \
    -e "s|__HOME__|$home_replacement|g" \
    -e "s|__INSTANCE__|$instance_replacement|g" \
    -e "s|__TARGET_URL__|$target_url_replacement|g" \
    -e "s|__TARGET_REF__|$target_ref_replacement|g" \
    -e "s|__MAX_LOG_BYTES__|$max_log_bytes_replacement|g" \
    -e "s|__KEEP_ROTATED_LOGS__|$keep_rotated_logs_replacement|g" \
    "$template"
)"

if grep -Eq '__WHATSOUP_REPO_ROOT__|__HOME__|__INSTANCE__|__TARGET_URL__|__TARGET_REF__|__MAX_LOG_BYTES__|__KEEP_ROTATED_LOGS__' <<<"$rendered"; then
  fail "rendered plist still contains unresolved placeholders"
fi

if [[ -n "$output" ]]; then
  mkdir -p "$(dirname "$output")"
  printf '%s\n' "$rendered" > "$output"
else
  printf '%s\n' "$rendered"
fi
