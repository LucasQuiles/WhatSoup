#!/usr/bin/env bash
# deploy/generate-health-tokens.sh
# Generates WHATSOUP_HEALTH_TOKEN for each instance.
# Tokens stored in GNOME Keyring for secure retrieval by systemd units.

set -euo pipefail

INSTANCES_DIR="${HOME}/.config/whatsoup/instances"

if [[ ! -d "$INSTANCES_DIR" ]]; then
  echo "No instances directory found at $INSTANCES_DIR"
  exit 1
fi

generated=0
skipped=0

for config_file in "${INSTANCES_DIR}"/*/config.json; do
  [[ -f "$config_file" ]] || continue
  instance_dir=$(dirname "$config_file")
  instance_name=$(basename "$instance_dir")

  # Check if token already exists in keyring
  existing=$(secret-tool lookup service "whatsoup-health-token" user "$instance_name" 2>/dev/null || true)
  if [[ -n "$existing" ]]; then
    echo "  [$instance_name] token exists, skipping"
    ((skipped++)) || true
    continue
  fi

  # Generate 32-byte hex token
  token=$(openssl rand -hex 32)

  # Store in GNOME Keyring
  echo -n "$token" | secret-tool store \
    --label "WhatSoup Health Token ($instance_name)" \
    service "whatsoup-health-token" \
    user "$instance_name"

  echo "  [$instance_name] token generated"
  ((generated++)) || true
done

echo ""
echo "Done: $generated generated, $skipped already existed"
echo "Retrieve via: secret-tool lookup service whatsoup-health-token user <instance-name>"
