#!/usr/bin/env bash
# deprecate-legacy.sh
#
# POST-SOAK deprecation: archives and removes legacy whatsapp-bot and
# whatsapp-mcp after the 48-hour soak period has passed successfully.
#
# Run ONCE, manually, AFTER the 48-hour soak confirms WhatSoup is stable.
#
# Usage:
#   ./deprecate-legacy.sh [--dry-run]
#
# Steps performed:
#   DEP-01  Disable and stop legacy whatsapp-bot@personal service
#   DEP-02  Remove legacy systemd unit file, daemon-reload
#   DEP-03  Verify whatsapp-mcp removed from ~/.claude/.mcp.json (warn if present)
#   DEP-04  Verify whatsapp-mcp removed from settings.json (warn if present)
#   DEP-05  Archive legacy codebases to _archived/ directories
#   DEP-06  Remove legacy namespace directories
#   DEP-07  Remove legacy whatsoup pre-namespace directories
#   DEP-08  Print manual reminder: update mcp-servers.md
#   DEP-09  Print note: CLAUDE.md instance model already updated
#   DEP-10  Remove legacy deploy binaries

set -euo pipefail

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
DRY_RUN=false
WARNINGS=0
ERRORS=0
ARCHIVED=()
REMOVED=()

DATE_STAMP=$(date +%Y%m%d)

# ---------------------------------------------------------------------------
# CLI parsing
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()    { echo "[INFO]  $*"; }
warn()   { echo "[WARN]  $*" >&2; WARNINGS=$((WARNINGS + 1)); }
error()  { echo "[ERROR] $*" >&2; ERRORS=$((ERRORS + 1)); }
action() { echo "[DO]    $*"; }
skip()   { echo "[SKIP]  $*"; }

# Run a command or print it in dry-run mode.
run() {
  if $DRY_RUN; then
    echo "[DRY]   $*"
  else
    "$@"
  fi
}

# Remove a file; skip with note if absent.
remove_file() {
  local path="$1"
  local label="${2:-$path}"
  if [[ ! -f "$path" ]]; then
    skip "File not found (already removed?): $path"
    return
  fi
  action "rm $path"
  run rm "$path"
  REMOVED+=("$label")
}

# Remove a directory tree; skip with note if absent.
remove_dir() {
  local path="$1"
  local label="${2:-$path}"
  if [[ ! -e "$path" ]]; then
    skip "Path not found (already removed?): $path"
    return
  fi
  action "rm -r $path"
  if $DRY_RUN; then
    echo "[DRY]   rm -r $path"
  else
    rm -r "$path"
  fi
  REMOVED+=("$label")
}

# Move src -> dest as an archive; skip if dest already exists.
archive_path() {
  local src="$1"
  local dest="$2"
  local label="${3:-$src}"

  if [[ ! -e "$src" ]]; then
    skip "Source not found (already archived?): $src"
    return
  fi

  if [[ -e "$dest" ]]; then
    warn "Archive destination already exists, skipping move: $dest"
    return
  fi

  action "mv $src -> $dest"
  run mkdir -p "$(dirname "$dest")"
  run mv "$src" "$dest"
  ARCHIVED+=("$label -> $dest")
}

# ---------------------------------------------------------------------------
# DEP-01: Disable and stop legacy whatsapp-bot@personal
# ---------------------------------------------------------------------------
dep_01() {
  log ""
  log "=== DEP-01: Disable and stop whatsapp-bot@personal ==="

  if systemctl --user is-active --quiet whatsapp-bot@personal 2>/dev/null; then
    action "systemctl --user disable --now whatsapp-bot@personal"
    run systemctl --user disable --now whatsapp-bot@personal
  elif systemctl --user is-enabled --quiet whatsapp-bot@personal 2>/dev/null; then
    action "systemctl --user disable whatsapp-bot@personal (already stopped)"
    run systemctl --user disable whatsapp-bot@personal
  else
    skip "whatsapp-bot@personal is not active or enabled (already removed?)"
  fi
}

# ---------------------------------------------------------------------------
# DEP-02: Remove legacy systemd unit file and daemon-reload
# ---------------------------------------------------------------------------
dep_02() {
  log ""
  log "=== DEP-02: Remove legacy systemd unit and daemon-reload ==="

  local unit_file="$HOME/.config/systemd/user/whatsapp-bot@.service"
  remove_file "$unit_file" "whatsapp-bot@.service"

  action "systemctl --user daemon-reload"
  run systemctl --user daemon-reload
}

# ---------------------------------------------------------------------------
# DEP-03: Verify whatsapp-mcp removed from ~/.claude/.mcp.json
# ---------------------------------------------------------------------------
dep_03() {
  log ""
  log "=== DEP-03: Check ~/.claude/.mcp.json for whatsapp-mcp entries ==="

  local mcp_json="$HOME/.claude/.mcp.json"
  if [[ ! -f "$mcp_json" ]]; then
    log "~/.claude/.mcp.json not found — nothing to check"
    return
  fi

  if grep -q "whatsapp-mcp" "$mcp_json" 2>/dev/null; then
    warn "whatsapp-mcp entry still present in $mcp_json — remove it manually"
    warn "  (CUT-07 should have done this; verify the cutover was complete)"
  else
    log "~/.claude/.mcp.json: OK (no whatsapp-mcp entries found)"
  fi
}

# ---------------------------------------------------------------------------
# DEP-04: Verify whatsapp-mcp removed from settings.json
# ---------------------------------------------------------------------------
dep_04() {
  log ""
  log "=== DEP-04: Check settings.json for whatsapp-mcp entries ==="

  local settings_json="$HOME/.claude/settings.json"
  if [[ ! -f "$settings_json" ]]; then
    log "~/.claude/settings.json not found — nothing to check"
    return
  fi

  if grep -q "whatsapp-mcp" "$settings_json" 2>/dev/null; then
    warn "whatsapp-mcp entry still present in $settings_json — remove it manually"
    warn "  (CUT-08 should have done this; verify the cutover was complete)"
  else
    log "~/.claude/settings.json: OK (no whatsapp-mcp entries found)"
  fi
}

# ---------------------------------------------------------------------------
# DEP-05: Archive legacy codebases
# ---------------------------------------------------------------------------
dep_05() {
  log ""
  log "=== DEP-05: Archive legacy codebases ==="

  archive_path \
    "$HOME/LAB/whatsapp-bot" \
    "$HOME/LAB/_archived/whatsapp-bot-${DATE_STAMP}" \
    "~/LAB/whatsapp-bot"

  archive_path \
    "$HOME/.claude/mcp-servers/whatsapp-mcp" \
    "$HOME/.claude/mcp-servers/_archived/whatsapp-mcp-${DATE_STAMP}" \
    "~/.claude/mcp-servers/whatsapp-mcp"
}

# ---------------------------------------------------------------------------
# DEP-06: Remove legacy namespace directories
# ---------------------------------------------------------------------------
dep_06() {
  log ""
  log "=== DEP-06: Remove legacy namespace directories ==="

  remove_dir "$HOME/.config/whatsapp-instances"   "~/.config/whatsapp-instances"
  remove_dir "$HOME/.local/share/whatsapp-instances" "~/.local/share/whatsapp-instances"
  remove_dir "$HOME/.config/whatsapp-mcp"         "~/.config/whatsapp-mcp"
  remove_dir "$HOME/.local/share/whatsapp-mcp"    "~/.local/share/whatsapp-mcp"
}

# ---------------------------------------------------------------------------
# DEP-07: Remove legacy whatsoup pre-namespace directories
# ---------------------------------------------------------------------------
dep_07() {
  log ""
  log "=== DEP-07: Remove legacy whatsoup pre-namespace directories ==="

  for instance in personal loops besbot; do
    remove_dir "$HOME/.local/share/whatsoup/${instance}" \
      "~/.local/share/whatsoup/${instance}"
    remove_dir "$HOME/.local/state/whatsoup/${instance}" \
      "~/.local/state/whatsoup/${instance}"
  done
}

# ---------------------------------------------------------------------------
# DEP-08: Manual reminder — update mcp-servers.md
# ---------------------------------------------------------------------------
dep_08() {
  log ""
  log "=== DEP-08: Manual action required ==="
  echo ""
  echo "  MANUAL: Update ~/.claude/docs/mcp-servers.md"
  echo "    - Remove the whatsapp-mcp entry"
  echo "    - Add an entry for whatsoup-personal (Unix socket MCP)"
  echo ""
}

# ---------------------------------------------------------------------------
# DEP-09: CLAUDE.md note
# ---------------------------------------------------------------------------
dep_09() {
  log ""
  log "=== DEP-09: CLAUDE.md instance model ==="
  log "  Per spec: CLAUDE.md instance model section already updated during cutover."
  log "  No action required."
}

# ---------------------------------------------------------------------------
# DEP-10: Remove legacy deploy binaries
# ---------------------------------------------------------------------------
dep_10() {
  log ""
  log "=== DEP-10: Remove legacy deploy binaries ==="

  remove_file "$HOME/.local/bin/whatsapp-mcp"  "~/.local/bin/whatsapp-mcp"
  remove_file "$HOME/.local/bin/whatsapp-auth" "~/.local/bin/whatsapp-auth"
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print_summary() {
  echo ""
  echo "========================================"
  echo "  Deprecation Summary"
  echo "========================================"

  echo ""
  echo "Archived (${#ARCHIVED[@]}):"
  if (( ${#ARCHIVED[@]} == 0 )); then
    echo "  (none)"
  else
    for a in "${ARCHIVED[@]}"; do
      echo "  - $a"
    done
  fi

  echo ""
  echo "Removed (${#REMOVED[@]}):"
  if (( ${#REMOVED[@]} == 0 )); then
    echo "  (none)"
  else
    for r in "${REMOVED[@]}"; do
      echo "  - $r"
    done
  fi

  echo ""
  echo "Warnings: $WARNINGS"
  echo "Errors:   $ERRORS"

  if (( ERRORS > 0 )); then
    echo ""
    echo "Deprecation completed WITH ERRORS. Review output above." >&2
  elif (( WARNINGS > 0 )); then
    echo ""
    echo "Deprecation completed with warnings. Review output above."
  else
    echo ""
    echo "Deprecation completed successfully."
  fi

  if $DRY_RUN; then
    echo ""
    echo "(DRY-RUN — no changes were made)"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  if $DRY_RUN; then
    log "*** DRY-RUN MODE — no changes will be made ***"
  fi

  dep_01
  dep_02
  dep_03
  dep_04
  dep_05
  dep_06
  dep_07
  dep_08
  dep_09
  dep_10
  print_summary

  if (( ERRORS > 0 )); then
    exit 1
  fi
}

main "$@"
