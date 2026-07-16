#!/usr/bin/env bash
#
# check-health-token-keyring.sh — verify an instance's health token is in keyring
#
# Pre-flight check for the W-5 health-token migration. Returns 0 (ready) when
# the per-instance health token is findable in the OS keyring under the
# service name 'whatsoup-health-token' with account=<instance>, meaning the
# tokens.env EnvironmentFile line AND the WHATSOUP_HEALTH_TOKEN export block in deploy/whatsoup
# can both be safely removed. Returns 1 (not ready) if the token is missing.
#
# Usage: deploy/check-health-token-keyring.sh <instance-name>
#
# This script does NOT read or print token values — it only checks presence
# (keyring lookup returns non-empty). Safe to run in any environment.
#
# Migration tracking: docs/security-handoffs/2026-05-09-env-secret-exposure.md
# Phase E (W-5). Companion to deploy/check-keyring-presence.sh (W-6).
# PR #1804 routed the health auth read site through lookupCredential; this
# script verifies the deploy-side removal is safe.
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <instance-name>" >&2
  echo "  Checks whether the instance's health token is in the OS keyring." >&2
  echo "  The token must be stored as service=whatsoup-health-token, account=<instance-name>." >&2
  exit 2
fi

INSTANCE="$1"
SERVICE="whatsoup-health-token"

# Detect the keyring backend (mirrors src/lib/keyring.ts detectKeyringBackend).
# Health tokens are scoped per-instance via the account parameter.
keyring_present() {
  local service="$1"
  local account="$2"
  local value=""
  case "$(uname -s)" in
    Darwin)
      value="$(security find-generic-password -s "$service" -a "$account" -w 2>/dev/null || true)"
      ;;
    *)
      value="$(timeout 3s secret-tool lookup service "$service" account "$account" 2>/dev/null || true)"
      ;;
  esac
  # Return 0 if non-empty, 1 if empty. NEVER print the value.
  [ -n "$value" ]
}

echo "Checking OS keyring for health token (instance: $INSTANCE)..."
echo "  service: $SERVICE"
echo "  account: $INSTANCE"
echo

if keyring_present "$SERVICE" "$INSTANCE"; then
  echo "  ✓ Health token present in keyring for instance '$INSTANCE'"
  echo
  echo "✅ Ready for W-5 migration."
  echo "   The following can be removed:"
  echo "     1. EnvironmentFile line in deploy/whatsoup@.service (tokens.env)"
  echo "     2. WHATSOUP_HEALTH_TOKEN export block in deploy/whatsoup"
  echo "   health.ts resolves the token at request time via lookupCredential."
  exit 0
else
  echo "  ✗ Health token NOT in keyring for instance '$INSTANCE'"
  echo
  echo "❌ Not ready for W-5 migration."
  echo "   Store the token before removing tokens.env, or health auth will break."
  echo "   Store it with:"
  echo "     Linux:  secret-tool store --label='WhatSoup health token' service $SERVICE account $INSTANCE"
  echo "     macOS:  security add-generic-password -s $SERVICE -a $INSTANCE -w"
  exit 1
fi
