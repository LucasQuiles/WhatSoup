#!/usr/bin/env bash
set -euo pipefail

# WhatSoup Setup Script
# Installs wrapper scripts, systemd unit, and builds the console.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
SYSTEMD_DIR="$HOME/.config/systemd/user"

echo "WhatSoup Setup"
echo "=============="
echo ""

# 1. Install wrapper scripts
echo "[1/4] Installing wrapper scripts to $BIN_DIR..."
mkdir -p "$BIN_DIR"
ln -sf "$REPO_ROOT/deploy/whatsoup" "$BIN_DIR/whatsoup"
chmod +x "$REPO_ROOT/deploy/whatsoup"
echo "  ✓ whatsoup → $REPO_ROOT/deploy/whatsoup"

# 2. Install systemd unit
echo "[2/4] Installing systemd user unit..."
mkdir -p "$SYSTEMD_DIR"
cp "$REPO_ROOT/deploy/whatsoup@.service" "$SYSTEMD_DIR/whatsoup@.service"
systemctl --user daemon-reload 2>/dev/null || true
echo "  ✓ whatsoup@.service installed"

# 3. Build console
echo "[3/4] Building fleet console..."
if [ -f "$REPO_ROOT/console/package.json" ]; then
  (cd "$REPO_ROOT/console" && npm install --silent 2>/dev/null && npx vite build 2>/dev/null)
  echo "  ✓ Console built to dist/"
else
  echo "  ⚠ Console not found — skipping build"
fi

# 4. Check API keys
echo "[4/4] Checking API keys..."
check_key() {
  local service="$1"
  local required="$2"
  if command -v secret-tool &>/dev/null; then
    if secret-tool lookup service "$service" &>/dev/null; then
      echo "  ✓ $service key found in keyring"
    elif [ "$required" = "required" ]; then
      echo "  ✗ $service key missing — run: secret-tool store --label='$service' service $service"
    else
      echo "  - $service key not set (optional)"
    fi
  else
    echo "  ⚠ secret-tool not found — set keys via environment variables instead"
    echo "    See docs/configuration.md for details"
  fi
}
check_key "anthropic" "required"
check_key "openai" "optional"
check_key "pinecone" "optional"

echo ""
echo "Setup complete. Next steps:"
echo ""
echo "  1. Start the fleet server:"
echo "     npm run fleet"
echo ""
echo "  2. Open http://localhost:9099 in your browser"
echo ""
echo "  3. Click 'Add Line' to create your first WhatsApp instance"
echo ""
echo "  4. Scan the QR code with WhatsApp → Linked Devices → Link a Device"
echo ""
