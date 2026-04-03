#!/usr/bin/env bash
set -euo pipefail

# WhatSoup Setup Script
# Checks requirements, installs wrapper scripts, systemd unit, and builds the console.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
SYSTEMD_DIR="$HOME/.config/systemd/user"

echo "WhatSoup Setup"
echo "=============="
echo ""

# ── Step 1: Check requirements ──────────────────────────────────────
echo "[1/6] Checking requirements..."
errors=0

# Node.js
if command -v node &>/dev/null; then
  node_version="$(node -v | sed 's/^v//')"
  node_major="${node_version%%.*}"
  node_minor="${node_version#*.}"; node_minor="${node_minor%%.*}"
  if [ "$node_major" -gt 23 ] || { [ "$node_major" -eq 23 ] && [ "$node_minor" -ge 10 ]; }; then
    echo "  ✓ Node.js $node_version (>= 23.10 required)"
  else
    echo "  ✗ Node.js $node_version found — version 23.10+ required"
    echo "    Install: https://nodejs.org/ or use nvm/fnm"
    errors=$((errors + 1))
  fi
else
  echo "  ✗ Node.js not found — version 23.10+ required"
  echo "    Install: https://nodejs.org/ or use nvm/fnm"
  errors=$((errors + 1))
fi

# systemctl (systemd user units)
if command -v systemctl &>/dev/null; then
  if systemctl --user list-units &>/dev/null; then
    echo "  ✓ systemd user units available"
  else
    echo "  ✗ systemctl found but user session unavailable"
    echo "    Ensure you're logged into a graphical session or enable lingering:"
    echo "    loginctl enable-linger $USER"
    errors=$((errors + 1))
  fi
else
  echo "  ✗ systemctl not found — systemd is required for instance management"
  echo "    WhatSoup uses systemd user units to manage WhatsApp instances"
  errors=$((errors + 1))
fi

# secret-tool (GNOME Keyring) — warn but don't block
if command -v secret-tool &>/dev/null; then
  echo "  ✓ secret-tool available (GNOME Keyring)"
else
  echo "  ⚠ secret-tool not found (optional)"
  echo "    API keys can be set via environment variables in systemd overrides instead"
  echo "    Install: sudo apt install libsecret-tools  (Debian/Ubuntu)"
fi

# ffmpeg — optional
if command -v ffmpeg &>/dev/null; then
  echo "  ✓ ffmpeg available"
else
  echo "  - ffmpeg not found (optional — video processing in chat mode disabled)"
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "  $errors required dependency missing. Fix the above and re-run: npm run setup"
  exit 1
fi
echo ""

# ── Step 2: Install dependencies ────────────────────────────────────
echo "[2/6] Installing dependencies..."
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  (cd "$REPO_ROOT" && npm install --silent 2>/dev/null)
  echo "  ✓ Root dependencies installed"
else
  echo "  ✓ Root dependencies already installed"
fi

# ── Step 3: Install wrapper scripts ─────────────────────────────────
echo "[3/6] Installing wrapper scripts to $BIN_DIR..."
mkdir -p "$BIN_DIR"
ln -sf "$REPO_ROOT/deploy/whatsoup" "$BIN_DIR/whatsoup"
chmod +x "$REPO_ROOT/deploy/whatsoup"
echo "  ✓ whatsoup → $REPO_ROOT/deploy/whatsoup"

# Ensure ~/.local/bin is on PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
  echo "  ⚠ $BIN_DIR is not on your PATH"
  echo "    Add to your shell profile: export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# ── Step 4: Install systemd unit ────────────────────────────────────
echo "[4/6] Installing systemd user unit..."
mkdir -p "$SYSTEMD_DIR"
cp "$REPO_ROOT/deploy/whatsoup@.service" "$SYSTEMD_DIR/whatsoup@.service"
systemctl --user daemon-reload 2>/dev/null || true
echo "  ✓ whatsoup@.service installed"

# ── Step 5: Build console ───────────────────────────────────────────
echo "[5/6] Building fleet console..."
if [ -f "$REPO_ROOT/console/package.json" ]; then
  (cd "$REPO_ROOT/console" && npm install --silent 2>/dev/null && npx vite build 2>/dev/null)
  echo "  ✓ Console built to dist/"
else
  echo "  ⚠ Console not found — skipping build"
fi

# ── Step 6: Check API keys ──────────────────────────────────────────
echo "[6/6] Checking API keys..."
if command -v secret-tool &>/dev/null; then
  check_key() {
    local service="$1"
    local required="$2"
    if secret-tool lookup service "$service" &>/dev/null; then
      echo "  ✓ $service key found in keyring"
    elif [ "$required" = "required" ]; then
      echo "  ✗ $service key missing — run: secret-tool store --label='$service' service $service"
    else
      echo "  - $service key not set (optional)"
    fi
  }
  check_key "anthropic" "required"
  check_key "openai" "optional"
  check_key "pinecone" "optional"
else
  echo "  Skipped — no secret-tool (set keys via environment variables)"
  echo "  Required: ANTHROPIC_API_KEY"
  echo "  Optional: OPENAI_API_KEY, PINECONE_API_KEY"
fi

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
