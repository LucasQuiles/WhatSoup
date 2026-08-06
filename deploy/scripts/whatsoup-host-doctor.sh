#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WHATSOUP_CAPABILITY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export WHATSOUP_CAPABILITY_ROOT

# shellcheck source=deploy/lib/host-capabilities.sh
. "$WHATSOUP_CAPABILITY_ROOT/deploy/lib/host-capabilities.sh"

usage() {
  cat >&2 <<'USAGE'
Usage: deploy/scripts/whatsoup-host-doctor.sh --profile <runtime|quality|release> [--node-policy <exact|compatibility>] [--json]
USAGE
}

profile=""
node_policy=exact
json=0
seen_profile=0
seen_node_policy=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      [ "$seen_profile" -eq 0 ] && [ "$#" -ge 2 ] || { usage; exit 2; }
      profile="$2"
      seen_profile=1
      shift 2
      ;;
    --node-policy)
      [ "$seen_node_policy" -eq 0 ] && [ "$#" -ge 2 ] || { usage; exit 2; }
      node_policy="$2"
      seen_node_policy=1
      shift 2
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
case "$node_policy" in
  exact|compatibility) ;;
  *) usage; exit 2 ;;
esac

WHATSOUP_CAPABILITY_PLATFORM="$(whatsoup_normalize_platform "$(uname -s 2>/dev/null)" 2>/dev/null || true)"
export WHATSOUP_CAPABILITY_PLATFORM
if [ -z "$WHATSOUP_CAPABILITY_PLATFORM" ]; then
  echo "host doctor: unsupported or unreadable platform" >&2
  exit 2
fi

records="$(whatsoup_capability_records "$profile" "$WHATSOUP_CAPABILITY_PLATFORM" "$node_policy" 2>/dev/null)" || {
  echo "host doctor: capability contract is malformed" >&2
  exit 2
}

json_records=""
has_block=0
has_inconclusive=0
human_lines=""

while IFS='|' read -r capability_id disposition probe version_rule brew_package apt_package pacman_package remediation; do
  [ -n "$capability_id" ] || continue
  whatsoup_probe_capability "$capability_id" "$disposition" "$probe" "$version_rule"

  case "$CAP_STATUS" in
    inconclusive) has_inconclusive=1 ;;
    missing|incompatible|path_hidden)
      [ "$disposition" = "required" ] && has_block=1
      ;;
  esac

  record_json="{\"id\":\"$(whatsoup_json_escape "$capability_id")\",\"disposition\":\"$(whatsoup_json_escape "$disposition")\",\"status\":\"$(whatsoup_json_escape "$CAP_STATUS")\",\"versionRule\":\"$(whatsoup_json_escape "$version_rule")\",\"version\":\"$(whatsoup_json_escape "$CAP_VERSION")\",\"path\":\"$(whatsoup_json_escape "$CAP_PATH")\",\"detail\":\"$(whatsoup_json_escape "$CAP_DETAIL")\",\"packages\":{\"brew\":\"$(whatsoup_json_escape "$brew_package")\",\"apt\":\"$(whatsoup_json_escape "$apt_package")\",\"pacman\":\"$(whatsoup_json_escape "$pacman_package")\"},\"remediation\":\"$(whatsoup_json_escape "$remediation")\"}"
  if [ -n "$json_records" ]; then
    json_records="$json_records,$record_json"
  else
    json_records="$record_json"
  fi
  human_lines="${human_lines}${capability_id}\t${CAP_STATUS}\t${CAP_VERSION}\t${CAP_PATH}\n"
done <<EOF
$records
EOF

if [ "$has_inconclusive" -eq 1 ]; then
  outcome=inconclusive
  exit_code=2
elif [ "$has_block" -eq 1 ]; then
  outcome=blocked
  exit_code=1
elif [ "$node_policy" = "compatibility" ]; then
  outcome=compatibility_only
  exit_code=0
else
  outcome=pass
  exit_code=0
fi

if [ "$json" -eq 1 ]; then
  printf '{"schemaVersion":1,"profile":"%s","nodePolicy":"%s","platform":"%s","outcome":"%s","records":[%s]}\n' \
    "$(whatsoup_json_escape "$profile")" \
    "$(whatsoup_json_escape "$node_policy")" \
    "$(whatsoup_json_escape "$WHATSOUP_CAPABILITY_PLATFORM")" \
    "$(whatsoup_json_escape "$outcome")" \
    "$json_records"
else
  printf 'WhatSoup host doctor: profile=%s node-policy=%s platform=%s outcome=%s\n' \
    "$profile" "$node_policy" "$WHATSOUP_CAPABILITY_PLATFORM" "$outcome"
  printf '%b' "$human_lines" | while IFS="$(printf '\t')" read -r capability_id status version path; do
    [ -n "$capability_id" ] || continue
    printf '  %-20s %-20s %s%s\n' "$capability_id" "$status" "$version" "${path:+ ($path)}"
  done
fi

exit "$exit_code"
