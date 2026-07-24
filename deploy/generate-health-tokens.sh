#!/usr/bin/env bash
# deploy/generate-health-tokens.sh
# Generates WHATSOUP_HEALTH_TOKEN for each instance.
# Tokens are written to per-instance tokens.env files by default so unattended
# systemd/launchd starts do not depend on platform keyrings.

set -euo pipefail

if [[ -z "${BASH_VERSION:-}" ]]; then
  echo "bash is required" >&2
  exit 1
fi

# Credential-store probes must be bounded on BOTH platforms; `timeout(1)` is not
# present on stock macOS (see deploy/lib/bounded-exec.sh).
# shellcheck source=deploy/lib/bounded-exec.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/bounded-exec.sh"

INSTANCES_DIR="${HOME}/.config/whatsoup/instances"
MIRROR_KEYRING=0
ROTATE=0

usage() {
  cat <<'EOF'
Usage: deploy/generate-health-tokens.sh [--mirror-keyring] [--rotate]

Writes WHATSOUP_HEALTH_TOKEN to:
  ~/.config/whatsoup/instances/<instance-name>/tokens.env

Options:
  --mirror-keyring  Also copy generated tokens into the platform keyring.
  --rotate          Replace existing tokens.env values.
  -h, --help        Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mirror-keyring) MIRROR_KEYRING=1 ;;
    --rotate) ROTATE=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ ! -d "$INSTANCES_DIR" ]]; then
  echo "No instances directory found at $INSTANCES_DIR"
  exit 1
fi

generated=0
skipped=0
mirrored=0
mirror_failed=0

read_existing_token() {
  local token_file="$1"
  [[ -f "$token_file" ]] || return 1
  awk -F= '/^WHATSOUP_HEALTH_TOKEN=/ { print substr($0, index($0, "=") + 1); exit }' "$token_file"
}

write_token_file() {
  local token_file="$1"
  local token="$2"
  local token_dir
  token_dir="$(dirname "$token_file")"
  mkdir -p "$token_dir"

  local tmp
  tmp="$(mktemp "${token_file}.tmp.XXXXXX")"
  chmod 600 "$tmp"
  printf 'WHATSOUP_HEALTH_TOKEN=%s\n' "$token" > "$tmp"
  mv "$tmp" "$token_file"
  chmod 600 "$token_file"
}

mirror_to_keyring() {
  local instance_name="$1"
  local token="$2"

  case "$(uname -s)" in
    Darwin)
      command -v security >/dev/null 2>&1 || return 1
      whatsoup_run_bounded 5 security add-generic-password \
        -U \
        -s "whatsoup-health-token" \
        -a "$instance_name" \
        -w "$token" >/dev/null
      ;;
    *)
      command -v secret-tool >/dev/null 2>&1 || return 1
      printf '%s' "$token" | whatsoup_run_bounded 5 secret-tool store \
        --label "WhatSoup Health Token ($instance_name)" \
        service "whatsoup-health-token" \
        user "$instance_name"
      ;;
  esac
}

for config_file in "${INSTANCES_DIR}"/*/config.json; do
  [[ -f "$config_file" ]] || continue
  instance_dir=$(dirname "$config_file")
  instance_name=$(basename "$instance_dir")
  token_file="${instance_dir}/tokens.env"

  existing="$(read_existing_token "$token_file" || true)"
  if [[ -n "$existing" && "$ROTATE" -ne 1 ]]; then
    echo "  [$instance_name] tokens.env exists, skipping"
    ((skipped++)) || true
    continue
  fi

  token=$(openssl rand -hex 32)
  write_token_file "$token_file" "$token"
  echo "  [$instance_name] token generated"
  ((generated++)) || true

  if [[ "$MIRROR_KEYRING" -eq 1 ]]; then
    if mirror_to_keyring "$instance_name" "$token"; then
      echo "  [$instance_name] mirrored to keyring"
      ((mirrored++)) || true
    else
      echo "  [$instance_name] warning: keyring mirror failed" >&2
      ((mirror_failed++)) || true
    fi
  fi
done

echo ""
echo "Done: $generated generated, $skipped skipped"
if [[ "$MIRROR_KEYRING" -eq 1 ]]; then
  echo "Keyring mirrors: $mirrored mirrored, $mirror_failed failed"
fi
echo "Token files: ${INSTANCES_DIR}/<instance-name>/tokens.env"

if [[ "$mirror_failed" -gt 0 ]]; then
  exit 1
fi
