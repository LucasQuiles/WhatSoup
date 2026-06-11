#!/usr/bin/env bash
set -euo pipefail

# WhatSoup Setup Script
# Checks requirements, installs wrapper scripts, systemd unit, and builds the console.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
SYSTEMD_DIR="$HOME/.config/systemd/user"

if [ "${1:-}" = "--check" ]; then
  exec "$REPO_ROOT/scripts/check-unit-drift.sh"
fi
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  cat <<'USAGE'
Usage: deploy/setup.sh [--check]

  --check  Compare checked-in systemd units with installed user units.
USAGE
  exit 0
fi

echo "WhatSoup Setup"
echo "=============="
echo ""

# ── Step 1: Check requirements ──────────────────────────────────────
echo "[1/7] Checking requirements..."
errors=0

# Node.js
if command -v node &>/dev/null; then
  node_version="$(node -v | sed 's/^v//')"
  node_major="${node_version%%.*}"
  engine_max_exclusive_major="$(node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const range = pkg.engines && pkg.engines.node;
if (typeof range !== "string") process.exit(2);
const match = range.match(/<\s*(\d+)/);
if (!match) process.exit(3);
process.stdout.write(match[1]);
' "$REPO_ROOT/package.json" 2>/dev/null || true)"
  required_major="$(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc" 2>/dev/null | sed -E 's/^([0-9]+).*/\1/')"
  if ! printf '%s' "$required_major" | grep -qE '^[0-9]+$' \
    || ! printf '%s' "$engine_max_exclusive_major" | grep -qE '^[0-9]+$'; then
    echo "  ✗ Could not parse Node bounds from .nvmrc and package.json#engines.node"
    errors=$((errors + 1))
  elif ! printf '%s' "$node_major" | grep -qE '^[0-9]+$'; then
    echo "  ✗ Could not parse Node.js major from version $node_version"
    errors=$((errors + 1))
  elif [ "$node_major" -ge "$required_major" ] && [ "$node_major" -lt "$engine_max_exclusive_major" ]; then
    echo "  ✓ Node.js $node_version (>= $required_major and < $engine_max_exclusive_major required)"
  else
    echo "  ✗ Node.js $node_version found — version >= $required_major and < $engine_max_exclusive_major required"
    echo "    Install: https://nodejs.org/ or use nvm/fnm"
    errors=$((errors + 1))
  fi
else
  echo "  ✗ Node.js not found — version $(tr -d '[:space:]' < "$REPO_ROOT/.nvmrc" 2>/dev/null || echo 24.15.0) required"
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
# Matches .github/workflows/quality.yml install step exactly so local
# setup, CI, and Docker all reproduce the pinned lockfile tree.
echo "[2/7] Installing dependencies..."
(cd "$REPO_ROOT" && npm ci)
echo "  ✓ Root dependencies installed"

# ── Step 3: Install wrapper scripts ─────────────────────────────────
echo "[3/7] Installing wrapper scripts to $BIN_DIR..."
mkdir -p "$BIN_DIR"
ln -sf "$REPO_ROOT/deploy/whatsoup" "$BIN_DIR/whatsoup"
chmod +x "$REPO_ROOT/deploy/whatsoup"
echo "  ✓ whatsoup → $REPO_ROOT/deploy/whatsoup"
ln -sf "$REPO_ROOT/deploy/whatsoup-fleet" "$BIN_DIR/whatsoup-fleet"
chmod +x "$REPO_ROOT/deploy/whatsoup-fleet"
echo "  ✓ whatsoup-fleet → $REPO_ROOT/deploy/whatsoup-fleet"
ln -sf "$REPO_ROOT/deploy/whatsoup-auth" "$BIN_DIR/whatsoup-auth"
chmod +x "$REPO_ROOT/deploy/whatsoup-auth"
echo "  ✓ whatsoup-auth → $REPO_ROOT/deploy/whatsoup-auth"
ln -sf "$REPO_ROOT/deploy/scripts/ensure-node-installed.sh" "$BIN_DIR/whatsoup-ensure-node"
chmod +x "$REPO_ROOT/deploy/scripts/ensure-node-installed.sh"
echo "  ✓ whatsoup-ensure-node → $REPO_ROOT/deploy/scripts/ensure-node-installed.sh"
ln -sf "$REPO_ROOT/deploy/scripts/harness-maintenance.sh" "$BIN_DIR/whatsoup-harness-maintenance"
chmod +x "$REPO_ROOT/deploy/scripts/harness-maintenance.sh"
echo "  ✓ whatsoup-harness-maintenance → $REPO_ROOT/deploy/scripts/harness-maintenance.sh"
ln -sf "$REPO_ROOT/deploy/scripts/reply-guarantee-drain.sh" "$BIN_DIR/whatsoup-reply-guarantee-drain"
chmod +x "$REPO_ROOT/deploy/scripts/reply-guarantee-drain.sh"
echo "  ✓ whatsoup-reply-guarantee-drain → $REPO_ROOT/deploy/scripts/reply-guarantee-drain.sh"

# Ensure ~/.local/bin is on PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
  echo "  ⚠ $BIN_DIR is not on your PATH"
  echo "    Add to your shell profile: export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# ── Step 4: Install systemd unit ────────────────────────────────────
echo "[4/7] Installing systemd user units..."
mkdir -p "$SYSTEMD_DIR"
cp "$REPO_ROOT/deploy/whatsoup@.service" "$SYSTEMD_DIR/whatsoup@.service"
cp "$REPO_ROOT/deploy/whatsoup-fleet.service" "$SYSTEMD_DIR/whatsoup-fleet.service"
cp "$REPO_ROOT/deploy/whatsoup-heal-notify@.service" "$SYSTEMD_DIR/whatsoup-heal-notify@.service"
cp "$REPO_ROOT/deploy/whatsoup-reply-guarantee.service" "$SYSTEMD_DIR/whatsoup-reply-guarantee.service"
cp "$REPO_ROOT/deploy/whatsoup-reply-guarantee.timer" "$SYSTEMD_DIR/whatsoup-reply-guarantee.timer"
cp "$REPO_ROOT/deploy/harness-maintenance.service" "$SYSTEMD_DIR/harness-maintenance.service"
cp "$REPO_ROOT/deploy/harness-maintenance.timer" "$SYSTEMD_DIR/harness-maintenance.timer"
systemctl --user daemon-reload 2>/dev/null || true
echo "  ✓ whatsoup@.service installed"
echo "  ✓ whatsoup-fleet.service installed"
echo "  ✓ whatsoup-heal-notify@.service installed"
echo "  ✓ whatsoup-reply-guarantee.{service,timer} installed"
echo "  ✓ harness-maintenance.{service,timer} installed"
mkdir -p "$HOME/.config/whatsoup"
if [ ! -f "$HOME/.config/whatsoup/fleet.env" ]; then
  cp "$REPO_ROOT/deploy/fleet.env.example" "$HOME/.config/whatsoup/fleet.env.example"
  echo "  - Optional fleet bind template installed to ~/.config/whatsoup/fleet.env.example"
fi

# ── Step 5: Install hardened npm defaults ───────────────────────────
echo "[5/7] Installing hardened npm defaults..."
if [ -f "$HOME/.npmrc" ] && ! cmp -s "$REPO_ROOT/deploy/npmrc.hardened" "$HOME/.npmrc"; then
  npmrc_backup="$HOME/.npmrc.whatsoup-backup-$(date -u +%Y%m%dT%H%M%SZ)"
  cp "$HOME/.npmrc" "$npmrc_backup"
  echo "  ✓ Existing ~/.npmrc backed up to $npmrc_backup"
fi
node --experimental-strip-types "$REPO_ROOT/scripts/npmrc-merge.ts" \
  "$REPO_ROOT/deploy/npmrc.hardened" "$HOME/.npmrc"
echo "  ✓ ~/.npmrc hardened with 7-day npm release cooldown while preserving local settings"

# ── Step 6: Build console ───────────────────────────────────────────
# Matches .github/workflows/quality.yml console-install + console-build
# exactly. stderr is left visible so peer-dep / build failures surface.
echo "[6/7] Building fleet console..."
if [ -f "$REPO_ROOT/console/package.json" ]; then
  (cd "$REPO_ROOT/console" && npm ci && npm run build)
  echo "  ✓ Console built to dist/"
else
  echo "  ⚠ Console not found — skipping build"
fi

# ── Step 7: Check API keys ──────────────────────────────────────────
echo "[7/7] Checking API keys..."
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
echo "  To run the fleet server as a persistent background service:"
echo "     systemctl --user enable --now whatsoup-fleet"
echo "     systemctl --user status whatsoup-fleet"
echo ""
echo "  To run harness maintenance daily:"
echo "     systemctl --user enable --now harness-maintenance.timer"
echo "     whatsoup-harness-maintenance --check"
echo ""
echo "  To run reply-guarantee drain every minute:"
echo "     systemctl --user enable --now whatsoup-reply-guarantee.timer"
echo ""
