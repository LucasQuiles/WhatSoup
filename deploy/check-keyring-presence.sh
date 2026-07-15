#!/usr/bin/env bash
#
# check-keyring-presence.sh — verify provider keys are in the OS keyring
#
# Pre-flight check for the W-6 secrets.env migration. Returns 0 (ready) when
# all three provider keys (anthropic, openai, pinecone) are findable in the
# OS keyring, meaning the EnvironmentFile=secrets.env line can be safely
# removed from deploy/whatsoup@.service. Returns 1 (not ready) if any key is
# missing from the keyring, printing guidance for each missing entry.
#
# Usage: deploy/check-keyring-presence.sh
#
# This script does NOT read or print key values — it only checks presence
# (keyring lookup returns non-empty). Safe to run in any environment.
#
# Migration tracking: docs/security-handoffs/2026-05-09-env-secret-exposure.md
# Phase F (W-6). Audit finding D-3 (secrets.env scope gap).
set -euo pipefail

# Services that must be in the keyring before secrets.env can be removed.
# These match the SERVICE_ENV_MAP keys in src/lib/provider-key-service.ts
# and the keyring_lookup calls in deploy/whatsoup.
SERVICES=(
  "anthropic"
  "openai"
  "pinecone"
)

# Detect the keyring backend (mirrors src/lib/keyring.ts detectKeyringBackend).
keyring_present() {
  local service="$1"
  local value=""
  case "$(uname -s)" in
    Darwin)
      value="$(security find-generic-password -s "$service" -a "$USER" -w 2>/dev/null || true)"
      ;;
    *)
      value="$(timeout 3s secret-tool lookup service "$service" 2>/dev/null || true)"
      ;;
  esac
  # Return 0 if non-empty, 1 if empty. NEVER print the value.
  [ -n "$value" ]
}

echo "Checking OS keyring for provider keys (W-6 secrets.env migration readiness)..."
echo

missing=0
for service in "${SERVICES[@]}"; do
  if keyring_present "$service"; then
    echo "  ✓ $service — present in keyring"
  else
    echo "  ✗ $service — NOT in keyring"
    echo "    Store it before removing secrets.env:"
    echo "      Linux:  secret-tool store --label='WhatSoup $service' service $service"
    echo "      macOS:  security add-generic-password -s $service -a \$USER -w"
    missing=$((missing + 1))
  fi
done

echo
if [ "$missing" -eq 0 ]; then
  echo "✅ All provider keys are in the keyring."
  echo "   secrets.env can be removed from deploy/whatsoup@.service (W-6)."
  exit 0
else
  echo "❌ $missing key(s) missing from keyring."
  echo "   Store them before removing secrets.env, or the wrapper will fail to start chat instances."
  exit 1
fi
