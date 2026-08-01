#!/usr/bin/env bash
set -euo pipefail

# WhatSoup Setup Script
# Checks requirements, installs wrapper scripts, systemd unit, and builds the console.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
SYSTEMD_DIR="$HOME/.config/systemd/user"
PLATFORM="$(uname -s)"
MACHINE="$(uname -m)"

# Credential-store probes must be bounded on BOTH platforms; `timeout(1)` is not
# present on stock macOS (see deploy/lib/bounded-exec.sh).
# shellcheck source=deploy/lib/bounded-exec.sh
. "$REPO_ROOT/deploy/lib/bounded-exec.sh"

# --- arch-aware binary suffix ---
# Prebuilt binary distributions (e.g. Homebrew, self-hosted CI artifacts)
# sometimes publish an arch-suffixed name (`ffmpeg-arm64`) alongside the bare
# one. Kept consistent with src/lib/arch.ts's getArchBinSuffix() aliasing
# (aarch64 -> arm64, x86_64 -> x64) so the shell-side and TypeScript-side
# binary resolvers never disagree about which suffixed name a host resolves
# to (src/runtimes/chat/providers/transcription/local-audio.ts:resolveBinaryPath
# applies the same fallback for the TS-side ffmpeg/ffprobe lookup). `amd64` is
# included defensively — it is a FreeBSD `uname -m` value; Linux and macOS
# always report `x86_64` and never reach it.
arch_bin_suffix() {
  case "$MACHINE" in
    arm64|aarch64) printf '%s' '-arm64' ;;
    x64|x86_64|amd64) printf '%s' '-x64' ;;
    *) printf '' ;;
  esac
}

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LAUNCHD_TIMER_LABELS=(
  "com.whatsoup.harness-maintenance"
  "com.whatsoup.reply-guarantee"
)
BOT_ERRORS_SYSTEMD_UNITS=(
  "bot-errors-dispatcher.service"
  "bot-errors-q-loop.service"
  "bot-errors-collector.service"
  "bot-errors-deadman.service"
  "bot-errors-deadman.timer"
  "bot-errors-health-check.service"
  "bot-errors-health-check.timer"
  "bot-errors-heartbeat-watchdog.service"
  "bot-errors-heartbeat-watchdog.timer"
  "bot-errors-runtime-staleness.service"
  "bot-errors-runtime-staleness.timer"
)

read_env_file_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  awk -v key="$key" '
    /^[[:space:]]*#/ { next }
    index($0, key "=") == 1 { value=substr($0, length(key) + 2); found=1 }
    END { if (found) printf "%s", value }
  ' "$file"
}
env_file_has_key() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 1
  awk -v key="$key" '
    /^[[:space:]]*#/ { next }
    index($0, key "=") == 1 { found=1 }
    END { exit found ? 0 : 1 }
  ' "$file"
}
append_env_key_if_missing() {
  local file="$1" key="$2" value="$3"
  if ! env_file_has_key "$file" "$key"; then
    printf "%s=%s\n" "$key" "$value" >> "$file"
    echo "  - Added missing $key to ~/.config/whatsoup/bot-errors.env"
  fi
}
resolve_bot_errors_health_profile() {
  local env_file="$HOME/.config/whatsoup/bot-errors.env" profile host
  profile="$(read_env_file_value "$env_file" BOT_ERRORS_HEALTH_PROFILE)"
  if [ -n "$profile" ]; then
    printf "%s" "$profile"
    return 0
  fi
  if [ -n "${BOT_ERRORS_HEALTH_PROFILE:-}" ]; then
    printf "%s" "$BOT_ERRORS_HEALTH_PROFILE"
    return 0
  fi
  host="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  printf "%s/deploy/health-profiles/%s.json" "$REPO_ROOT" "$host"
}
require_readable_bot_errors_health_profile() {
  local profile
  profile="$(resolve_bot_errors_health_profile)"
  if [ -z "$profile" ] || [ ! -f "$profile" ] || [ ! -r "$profile" ]; then
    echo "  ✗ missing BOT_ERRORS_HEALTH_PROFILE; expected readable profile path" >&2
    echo "    Set BOT_ERRORS_HEALTH_PROFILE or create the host profile before installing BOT ERRORS units." >&2
    exit 2
  fi
  printf "%s" "$profile"
}

if [ "${1:-}" = "--check" ]; then
  # macOS hosts have no systemd user dir — tolerate the documented skip
  # (exit 3 without the flag) instead of failing every Darwin --check.
  exec "$REPO_ROOT/scripts/check-unit-drift.sh" --allow-missing-systemd-dir
fi
if [ "${1:-}" = "--remove-timers" ]; then
  if [ "$PLATFORM" != "Darwin" ]; then
    echo "--remove-timers applies to macOS launchd timers only." >&2
    echo "On Linux, disable the systemd timers instead:" >&2
    echo "  systemctl --user disable --now harness-maintenance.timer whatsoup-reply-guarantee.timer" >&2
    exit 1
  fi
  for label in "${LAUNCHD_TIMER_LABELS[@]}"; do
    plist_dest="$LAUNCH_AGENTS_DIR/$label.plist"
    if [ -f "$plist_dest" ]; then
      rm "$plist_dest"
      echo "  ✓ Removed $plist_dest"
    else
      echo "  - $label.plist not installed — nothing to remove"
    fi
    echo "    If the job is currently loaded, unload it as a deployment step:"
    echo "      launchctl bootout gui/\$(id -u)/$label"
  done
  exit 0
fi
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  cat <<'USAGE'
Usage: deploy/setup.sh [--check | --remove-timers]

  --check          Compare checked-in systemd units with installed user units.
  --remove-timers  macOS only: remove the launchd maintenance timer plists from
                   ~/Library/LaunchAgents. Prints the bootout commands to unload
                   any currently loaded jobs — they are never run automatically.
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

# Service manager and credential store — platform-specific
if [ "$PLATFORM" = "Darwin" ]; then
  # --- darwin (macos launchd) requirements ---
  if command -v launchctl &>/dev/null; then
    echo "  ✓ launchd available (launchctl)"
  else
    echo "  ✗ launchctl not found — launchd is required for instance management on macOS"
    errors=$((errors + 1))
  fi

  # macOS Keychain (security binary ships with macOS) — warn but don't block
  if command -v security &>/dev/null; then
    echo "  ✓ macOS Keychain available (security)"
  else
    echo "  ⚠ security not found (optional)"
    echo "    API keys can be set via environment variables instead"
  fi
else
  # --- linux (systemd) requirements ---
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
fi

# ffmpeg — optional
ffmpeg_arch_suffix="$(arch_bin_suffix)"
if command -v ffmpeg &>/dev/null; then
  echo "  ✓ ffmpeg available"
elif [ -n "$ffmpeg_arch_suffix" ] && command -v "ffmpeg$ffmpeg_arch_suffix" &>/dev/null; then
  echo "  ✓ ffmpeg available (arch-suffixed: ffmpeg$ffmpeg_arch_suffix)"
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
ln -sf "$REPO_ROOT/deploy/scripts/heal-notify.sh" "$BIN_DIR/whatsoup-heal-notify"
chmod +x "$REPO_ROOT/deploy/scripts/heal-notify.sh"
echo "  ✓ whatsoup-heal-notify → $REPO_ROOT/deploy/scripts/heal-notify.sh"

# Ensure ~/.local/bin is on PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
  echo "  ⚠ $BIN_DIR is not on your PATH"
  echo "    Add to your shell profile: export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# ── Step 4: Install service units ───────────────────────────────────
# --- step 4 start ---
if [ "$PLATFORM" = "Darwin" ]; then
  echo "[4/7] Configuring service management (macOS)..."
  echo "  macOS: instance services are launchd plists generated by the fleet on line creation"
  echo "         (~/Library/LaunchAgents/com.whatsoup.<name>.plist) — no unit install needed"
  # --- darwin (macos launchd) timer install ---
  mkdir -p "$LAUNCH_AGENTS_DIR" "$HOME/Library/Logs/whatsoup"
  install_launchd_timer() {
    local label="$1"
    local cron_marker="$2"
    local src="$REPO_ROOT/deploy/$label.plist"
    local dest="$LAUNCH_AGENTS_DIR/$label.plist"
    local rendered backup
    rendered="$(sed -e "s|__WHATSOUP_REPO_ROOT__|$REPO_ROOT|g" -e "s|__HOME__|$HOME|g" -e "s|\${WHATSOUP_REPO_ROOT}|$REPO_ROOT|g" -e "s|\${HOME}|$HOME|g" "$src")"
    # Duplicate-scheduler guard: an equivalent cron entry means this job is
    # already scheduled by another mechanism — warn and skip, don't double-run.
    if crontab -l 2>/dev/null | grep -v '^[[:space:]]*#' | grep -q "$cron_marker"; then
      echo "  ⚠ crontab already schedules '$cron_marker' — skipping $label install to avoid a duplicate timer"
      return 0
    fi
    # Duplicate-timer guard: an already-loaded label keeps its running
    # definition; only the on-disk plist is refreshed.
    if launchctl list 2>/dev/null | grep -Fq "$label"; then
      echo "  ⚠ $label is already loaded in launchd — refreshing the plist on disk only;"
      echo "    the loaded job keeps its current definition until reloaded (deployment step)"
    fi
    if [ -f "$dest" ]; then
      if printf '%s\n' "$rendered" | cmp -s - "$dest"; then
        echo "  ✓ $label.plist already installed (unchanged)"
        return 0
      fi
      backup="$dest.whatsoup-backup-$(date -u +%Y%m%dT%H%M%SZ)"
      cp "$dest" "$backup"
      echo "  ✓ Existing $label.plist backed up to $backup"
    fi
    printf '%s\n' "$rendered" > "$dest"
    echo "  ✓ $label.plist installed to ~/Library/LaunchAgents (not loaded)"
  }
  install_launchd_timer "com.whatsoup.harness-maintenance" "harness-maintenance"
  install_launchd_timer "com.whatsoup.reply-guarantee" "reply-guarantee"
  echo "  Timers are installed but NOT loaded — they activate on next login."
  echo "  To load now (deployment step, run manually):"
  echo "     launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.whatsoup.harness-maintenance.plist"
  echo "     launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.whatsoup.reply-guarantee.plist"
else
  echo "[4/7] Installing systemd user units..."
  # --- linux (systemd) unit install ---
  bot_errors_required_health_profile="$(require_readable_bot_errors_health_profile)"
  echo "  ✓ BOT ERRORS health profile readable: $bot_errors_required_health_profile"
  mkdir -p "$SYSTEMD_DIR"
  cp "$REPO_ROOT/deploy/whatsoup@.service" "$SYSTEMD_DIR/whatsoup@.service"
  cp "$REPO_ROOT/deploy/whatsoup-fleet.service" "$SYSTEMD_DIR/whatsoup-fleet.service"
  cp "$REPO_ROOT/deploy/whatsoup-heal-notify@.service" "$SYSTEMD_DIR/whatsoup-heal-notify@.service"
  cp "$REPO_ROOT/deploy/whatsoup-reply-guarantee.service" "$SYSTEMD_DIR/whatsoup-reply-guarantee.service"
  cp "$REPO_ROOT/deploy/whatsoup-reply-guarantee.timer" "$SYSTEMD_DIR/whatsoup-reply-guarantee.timer"
  cp "$REPO_ROOT/deploy/harness-maintenance.service" "$SYSTEMD_DIR/harness-maintenance.service"
  cp "$REPO_ROOT/deploy/harness-maintenance.timer" "$SYSTEMD_DIR/harness-maintenance.timer"
  for unit in "${BOT_ERRORS_SYSTEMD_UNITS[@]}"; do
    cp "$REPO_ROOT/deploy/$unit" "$SYSTEMD_DIR/$unit"
  done
  if ! systemctl --user daemon-reload; then
    echo "  ✗ systemctl --user daemon-reload failed after installing units" >&2
    exit 1
  fi
  reenable_units=()
  seen_reenable_units=" "
  shopt -s nullglob
  for link in "$SYSTEMD_DIR"/*.target.wants/whatsoup@*.service "$SYSTEMD_DIR"/*.target.wants/whatsoup-fleet.service; do
    unit="$(basename "$link")"
    case "$seen_reenable_units" in
      *" $unit "*) continue ;;
    esac
    seen_reenable_units="$seen_reenable_units$unit "
    reenable_units+=("$unit")
  done
  shopt -u nullglob
  if [ "${#reenable_units[@]}" -gt 0 ]; then
    if ! systemctl --user reenable "${reenable_units[@]}"; then
      echo "  ✗ systemctl --user reenable failed after installing units" >&2
      exit 1
    fi
    echo "  ✓ refreshed systemd enablement for ${reenable_units[*]}"
  fi
  echo "  ✓ whatsoup@.service installed"
  echo "  ✓ whatsoup-fleet.service installed"
  echo "  ✓ whatsoup-heal-notify@.service installed"
  echo "  ✓ whatsoup-reply-guarantee.{service,timer} installed"
  echo "  ✓ harness-maintenance.{service,timer} installed"
  echo "  ✓ BOT ERRORS service/timer units installed"
fi
mkdir -p "$HOME/.config/whatsoup"
if [ ! -f "$HOME/.config/whatsoup/fleet.env" ]; then
  cp "$REPO_ROOT/deploy/fleet.env.example" "$HOME/.config/whatsoup/fleet.env.example"
  echo "  - Optional fleet bind template installed to ~/.config/whatsoup/fleet.env.example"
fi
cp "$REPO_ROOT/deploy/bot-errors.env.example" "$HOME/.config/whatsoup/bot-errors.env.example"
if [ ! -f "$HOME/.config/whatsoup/bot-errors.env" ]; then
  bot_errors_instance="${BOT_ERRORS_INSTANCE:-personal}"
  bot_errors_jid="${BOT_ERRORS_JID:-}"
  bot_errors_expected_jid="${BOT_ERRORS_EXPECTED_JID:-$bot_errors_jid}"
  bot_errors_socket="${BOT_ERRORS_SOCKET_PATH:-${BOT_ERRORS_SOCKET:-$HOME/.local/state/whatsoup/instances/$bot_errors_instance/whatsoup.sock}}"
  bot_errors_db="${BOT_ERRORS_DB:-$HOME/.local/share/whatsoup/instances/$bot_errors_instance/bot.db}"
  bot_errors_host="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  bot_errors_health_profile="$(resolve_bot_errors_health_profile)"
  umask 077
  {
    echo "# Private BOT ERRORS routing config generated by deploy/setup.sh."
    echo "# Fill BOT_ERRORS_JID before enabling bot-errors-dispatcher.service or bot-errors-q-loop.service."
    echo "BOT_ERRORS_JID=$bot_errors_jid"
    echo "BOT_ERRORS_EXPECTED_JID=$bot_errors_expected_jid"
    echo "BOT_ERRORS_SOCKET_PATH=$bot_errors_socket"
    echo "BOT_ERRORS_SOCKET=$bot_errors_socket"
    echo "BOT_ERRORS_DB=$bot_errors_db"
    echo "BOT_ERRORS_HEALTH_PROFILE=$bot_errors_health_profile"
  } > "$HOME/.config/whatsoup/bot-errors.env"
  echo "  - BOT ERRORS routing template installed to ~/.config/whatsoup/bot-errors.env"
else
  bot_errors_env_file="$HOME/.config/whatsoup/bot-errors.env"
  bot_errors_instance="${BOT_ERRORS_INSTANCE:-personal}"
  bot_errors_host="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  bot_errors_jid="$(read_env_file_value "$bot_errors_env_file" BOT_ERRORS_JID)"
  bot_errors_socket_path="$(read_env_file_value "$bot_errors_env_file" BOT_ERRORS_SOCKET_PATH)"
  bot_errors_socket="$(read_env_file_value "$bot_errors_env_file" BOT_ERRORS_SOCKET)"
  bot_errors_default_socket="$HOME/.local/state/whatsoup/instances/$bot_errors_instance/whatsoup.sock"
  bot_errors_default_db="$HOME/.local/share/whatsoup/instances/$bot_errors_instance/bot.db"
  bot_errors_default_health_profile="$(resolve_bot_errors_health_profile)"
  append_env_key_if_missing "$bot_errors_env_file" "BOT_ERRORS_EXPECTED_JID" "$bot_errors_jid"
  if [ -n "$bot_errors_socket" ]; then
    append_env_key_if_missing "$bot_errors_env_file" "BOT_ERRORS_SOCKET_PATH" "$bot_errors_socket"
  else
    append_env_key_if_missing "$bot_errors_env_file" "BOT_ERRORS_SOCKET_PATH" "$bot_errors_default_socket"
  fi
  if [ -n "$bot_errors_socket_path" ]; then
    append_env_key_if_missing "$bot_errors_env_file" "BOT_ERRORS_SOCKET" "$bot_errors_socket_path"
  else
    append_env_key_if_missing "$bot_errors_env_file" "BOT_ERRORS_SOCKET" "${bot_errors_socket:-$bot_errors_default_socket}"
  fi
  append_env_key_if_missing "$bot_errors_env_file" "BOT_ERRORS_DB" "$bot_errors_default_db"
  append_env_key_if_missing "$bot_errors_env_file" "BOT_ERRORS_HEALTH_PROFILE" "$bot_errors_default_health_profile"
  echo "  ✓ Existing BOT ERRORS routing config preserved at ~/.config/whatsoup/bot-errors.env"
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
if [ "$PLATFORM" = "Darwin" ]; then
  # --- darwin (macos keychain) key check ---
  # Uses the same lookup conventions as src/lib/keyring.ts: security find-generic-password -s <service> -a <username> -w
  check_key() {
    local service="$1"
    local required="$2"
    if whatsoup_run_bounded 3 security find-generic-password -s "$service" -a "$USER" -w &>/dev/null; then
      echo "  ✓ $service key found in macOS Keychain"
    elif [ "$required" = "required" ]; then
      echo "  ✗ $service key missing — run: security add-generic-password -s $service -a \"\$USER\" -w"
    else
      echo "  - $service key not set (optional)"
    fi
  }
  check_key "anthropic" "required"
  check_key "openai" "optional"
  check_key "pinecone" "optional"
  # minimax/deepseek keys are required when agentOptions.fallbackProvider uses those model prefixes
  check_key "minimax" "optional"
  check_key "deepseek" "optional"
else
  # --- linux (secret-tool) key check ---
  if command -v secret-tool &>/dev/null; then
    check_key() {
      local service="$1"
      local required="$2"
      if whatsoup_run_bounded 3 secret-tool lookup service "$service" &>/dev/null; then
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
    # minimax/deepseek keys are required when agentOptions.fallbackProvider uses those model prefixes
    check_key "minimax" "optional"
    check_key "deepseek" "optional"
  else
    echo "  Skipped — no secret-tool (set keys via environment variables)"
    echo "  Required: ANTHROPIC_API_KEY"
    echo "  Optional: OPENAI_API_KEY, PINECONE_API_KEY"
  fi
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
if [ "$PLATFORM" = "Darwin" ]; then
  echo "  macOS: instances are managed via launchctl (plists auto-generated by the fleet)"
  echo "  macOS: maintenance timer plists are installed but not loaded; they activate on"
  echo "  next login, or load them now as a deployment step:"
  echo "     launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.whatsoup.harness-maintenance.plist"
  echo "     launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.whatsoup.reply-guarantee.plist"
  echo "  Verify:    launchctl print gui/\$(id -u)/com.whatsoup.harness-maintenance"
  echo "  Uninstall: deploy/setup.sh --remove-timers   (see docs/runbook.md §2)"
else
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
  echo "  To run BOT ERRORS monitoring after filling ~/.config/whatsoup/bot-errors.env:"
  echo "     systemctl --user enable --now bot-errors-dispatcher.service bot-errors-q-loop.service bot-errors-collector.service"
  echo "     systemctl --user enable --now bot-errors-deadman.timer bot-errors-health-check.timer bot-errors-heartbeat-watchdog.timer bot-errors-runtime-staleness.timer"
fi
echo ""
