#!/usr/bin/env bash
#
# check-health-token-keyring.sh — verify file/keyring health-token parity
#
# Fleet discovery is still file-backed. This check proves that the canonical
# per-instance tokens.env value has an exact keyring mirror; it does not make
# tokens.env, the systemd EnvironmentFile, or the launcher file load removable.
# After the descriptor-safe launcher is deployed, remove any duplicate plaintext
# WHATSOUP_HEALTH_TOKEN entry from launchd while retaining canonical tokens.env.
# Values are compared only in memory and are never printed.
#
# Usage: deploy/check-health-token-keyring.sh <instance-name>
#
# Migration tracking: docs/security-handoffs/2026-05-09-env-secret-exposure.md
# Phase E (W-5).
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <instance-name>" >&2
  echo "  Verifies exact parity between tokens.env and its scoped keyring mirror." >&2
  exit 2
fi

INSTANCE="$1"
SERVICE="whatsoup-health-token"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
TOKEN_FILE="$CONFIG_HOME/whatsoup/instances/$INSTANCE/tokens.env"

if [[ ! "$INSTANCE" =~ ^[a-z][a-z0-9-]*$ ]] || [ "${#INSTANCE}" -gt 30 ]; then
  echo "Invalid instance name" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE="${WHATSOUP_NODE:-}"
if [ -z "$NODE" ]; then
  PINNED_VERSION="$(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc" 2>/dev/null || true)"
  PINNED_NODE="$HOME/.nvm/versions/node/v${PINNED_VERSION}/bin/node"
  if [ -n "$PINNED_VERSION" ] && [ -x "$PINNED_NODE" ]; then
    NODE="$PINNED_NODE"
  else
    NODE="$(command -v node 2>/dev/null || true)"
  fi
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "FATAL: Node runtime is unavailable" >&2
  exit 2
fi
# shellcheck source=deploy/lib/read-private-health-token.sh
. "$SCRIPT_DIR/lib/read-private-health-token.sh"

read_scoped_keyring_token() {
  case "$(uname -s)" in
    Darwin)
      security find-generic-password \
        -s "$SERVICE" \
        -a "$INSTANCE" \
        -w 2>/dev/null || true
      ;;
    *)
      timeout 3s secret-tool lookup \
        service "$SERVICE" \
        user "$INSTANCE" 2>/dev/null || true
      ;;
  esac
}

echo "Checking health-token file/keyring parity (instance: $INSTANCE)..."

if ! FILE_TOKEN="$(whatsoup_read_private_health_token \
  "$NODE" \
  "$SCRIPT_DIR/lib/read-private-health-token.mjs" \
  "$TOKEN_FILE")"; then
  echo "  ✗ tokens.env is missing, unsafe, or non-canonical"
  echo "❌ Parity check failed. Do not remove tokens.env or its launcher/service wiring."
  exit 1
fi

KEYRING_TOKEN="$(read_scoped_keyring_token)"
if [ -z "$KEYRING_TOKEN" ]; then
  echo "  ✗ scoped keyring mirror is missing"
  echo "❌ Parity check failed. Do not remove tokens.env or its launcher/service wiring."
  exit 1
fi

if [ "$FILE_TOKEN" != "$KEYRING_TOKEN" ]; then
  echo "  ✗ scoped keyring mirror does not match canonical tokens.env"
  echo "❌ Parity check failed. Do not remove tokens.env or its launcher/service wiring."
  exit 1
fi

echo "  ✓ scoped keyring mirror matches canonical tokens.env"
echo "✅ Parity check passed for the current file-backed deployment."
echo "   Do not remove tokens.env, the systemd EnvironmentFile, or the launcher file load."
echo "   After deploying the descriptor-safe launcher, remove duplicate plaintext"
echo "   WHATSOUP_HEALTH_TOKEN entries from launchd and retain canonical tokens.env."
