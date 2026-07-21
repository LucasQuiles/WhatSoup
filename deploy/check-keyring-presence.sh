#!/usr/bin/env bash
#
# check-keyring-presence.sh — verify provider keys are in the OS keyring
#
# Pre-flight check for the W-6 secrets.env migration. Returns 0 (ready) when
# all three provider keys (anthropic, openai, pinecone) are findable in the
# OS keyring, meaning secret-injecting wrappers/EnvironmentFiles can be removed
# during a controlled direct-launcher cutover. Returns 1 (not ready) if any key is
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
# These match the SERVICE_ENV_MAP keys in src/lib/provider-key-service.ts and
# the canonical in-process resolver services.
SERVICES=(
  "anthropic"
  "openai"
  "pinecone"
)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# On macOS, security(1) has no timeout and can hang inside a launchd process when
# the login keychain cannot present UI. Route the read through the pinned-Node
# helper, which bounds it with a 3s SIGKILL (same seam as check-health-token-keyring.sh
# and the health-token checker). Linux keeps the native `timeout 3s secret-tool`.
NODE=""
if [ "$(uname -s)" = "Darwin" ]; then
  # shellcheck source=deploy/lib/resolve-node.sh
  . "$SCRIPT_DIR/lib/resolve-node.sh"
  if ! NODE="$(whatsoup_resolve_node "$REPO_ROOT")"; then
    echo "FATAL: cannot resolve pinned Node to bound the macOS keychain read" >&2
    exit 2
  fi
fi

# Detect the keyring backend (mirrors src/lib/keyring.ts detectKeyringBackend).
keyring_present() {
  local service="$1"
  local value=""
  case "$(uname -s)" in
    Darwin)
      value="$("$NODE" "$SCRIPT_DIR/lib/read-keychain-secret.mjs" "$service" "$USER" || true)"
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
  echo "   Provider secret injection can be removed during the managed cutover (W-6)."
  exit 0
else
  echo "❌ $missing key(s) missing from keyring."
  echo "   Store them before removing legacy secret injection; affected providers will otherwise fail at use time."
  exit 1
fi
