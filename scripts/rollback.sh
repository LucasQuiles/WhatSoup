#!/usr/bin/env bash
# rollback.sh
#
# Reverts a WhatSoup cutover by stopping all whatsoup@ services,
# restarting the legacy whatsapp-bot@personal, and printing manual
# instructions to restore ~/.claude/.mcp.json and settings.json.
#
# Usage:
#   ./scripts/rollback.sh
#
# Safe to run at any cutover stage — each step is idempotent.

set -euo pipefail

# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

ok()     { echo -e "${GREEN}[OK]${RESET}    $*"; }
fail()   { echo -e "${RED}[FAIL]${RESET}  $*" >&2; }
info()   { echo -e "${YELLOW}[INFO]${RESET}  $*"; }
header() { echo -e "\n${BOLD}$*${RESET}"; }

# ---------------------------------------------------------------------------
# ROLL-01: Stop all whatsoup@ services
# ---------------------------------------------------------------------------
run_roll01() {
  header "=== ROLL-01: Stop all whatsoup@ services ==="

  local any_stopped=false
  for inst in personal q loops besbot; do
    if systemctl --user is-active --quiet "whatsoup@${inst}" 2>/dev/null; then
      info "Stopping whatsoup@${inst}..."
      systemctl --user stop "whatsoup@${inst}" && ok "whatsoup@${inst} stopped" || fail "Failed to stop whatsoup@${inst}"
      any_stopped=true
    else
      info "whatsoup@${inst} is not active — skipping"
    fi
  done

  if ! $any_stopped; then
    ok "ROLL-01  No whatsoup@ services were running"
  fi
}

# ---------------------------------------------------------------------------
# ROLL-02: Restart whatsapp-bot@personal
# ---------------------------------------------------------------------------
run_roll02() {
  header "=== ROLL-02: Restart whatsapp-bot@personal ==="

  info "Starting whatsapp-bot@personal..."
  if systemctl --user start whatsapp-bot@personal; then
    # Wait up to 15s for active
    local deadline=$(( $(date +%s) + 15 ))
    while true; do
      if systemctl --user is-active --quiet whatsapp-bot@personal 2>/dev/null; then
        ok "ROLL-02  whatsapp-bot@personal is active"
        return 0
      fi
      if (( $(date +%s) >= deadline )); then
        fail "ROLL-02  whatsapp-bot@personal did not become active within 15s"
        info "Check: systemctl --user status whatsapp-bot@personal"
        return 1
      fi
      sleep 2
    done
  else
    fail "ROLL-02  Failed to start whatsapp-bot@personal"
    info "Check: systemctl --user status whatsapp-bot@personal"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# ROLL-03: Print manual instructions to revert ~/.claude/.mcp.json
# ---------------------------------------------------------------------------
run_roll03() {
  header "=== ROLL-03: Revert ~/.claude/.mcp.json (MANUAL STEP) ==="
  echo ""
  echo -e "${YELLOW}ACTION REQUIRED — edit ~/.claude/.mcp.json manually:${RESET}"
  echo ""
  echo "  REMOVE this entry (if present):"
  echo '    "whatsoup-personal": { ... }'
  echo ""
  echo "  ADD (or restore) this entry:"
  echo '    "whatsapp-mcp": { "type": "stdio", "command": "/home/q/.local/bin/whatsapp-mcp" }'
  echo ""
}

# ---------------------------------------------------------------------------
# ROLL-04: Print manual instructions to revert ~/.claude/settings.json
# ---------------------------------------------------------------------------
run_roll04() {
  header "=== ROLL-04: Revert ~/.claude/settings.json (MANUAL STEP) ==="
  echo ""
  echo -e "${YELLOW}ACTION REQUIRED — edit ~/.claude/settings.json manually:${RESET}"
  echo ""
  echo "  REMOVE from permissions.allow (if present):"
  echo '    "mcp__whatsoup-personal__list_chats"'
  echo '    "mcp__whatsoup-personal__list_messages"'
  echo '    "mcp__whatsoup-personal__search_messages"'
  echo '    "mcp__whatsoup-personal__search_contacts"'
  echo '    "mcp__whatsoup-personal__get_chat"'
  echo '    "mcp__whatsoup-personal__get_message_context"'
  echo ""
  echo "  ADD (or restore) to permissions.allow:"
  echo '    "mcp__whatsapp-mcp__list_chats"'
  echo '    "mcp__whatsapp-mcp__list_messages"'
  echo '    "mcp__whatsapp-mcp__search_messages"'
  echo '    "mcp__whatsapp-mcp__search_contacts"'
  echo '    "mcp__whatsapp-mcp__get_chat"'
  echo '    "mcp__whatsapp-mcp__get_message_context"'
  echo ""
}

# ---------------------------------------------------------------------------
# ROLL-05: Print manual instruction to restart Claude Code
# ---------------------------------------------------------------------------
run_roll05() {
  header "=== ROLL-05: Restart Claude Code session (MANUAL STEP) ==="
  echo ""
  echo -e "${YELLOW}ACTION REQUIRED:${RESET}"
  echo "  Restart your Claude Code session to pick up the restored MCP configuration."
  echo ""
  echo "  After restarting, verify that:"
  echo "    - mcp__whatsapp-mcp__list_chats returns your personal chats"
  echo "    - whatsapp-mcp tools are available in the session"
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  echo -e "${BOLD}WhatSoup Rollback Script${RESET}"
  echo "Reverts cutover: stops WhatSoup, restores legacy services."
  echo ""
  echo -e "${YELLOW}NOTE: Legacy data was copied (not moved) during migration.${RESET}"
  echo "  whatsapp-bot@personal reads from original paths — rollback is instant."
  echo ""

  run_roll01
  run_roll02
  run_roll03
  run_roll04
  run_roll05

  echo ""
  echo -e "${GREEN}${BOLD}=== ROLLBACK COMPLETE ===${RESET}"
  echo ""
  echo "Automated steps done:"
  echo "  - All whatsoup@ services stopped"
  echo "  - whatsapp-bot@personal restarted"
  echo ""
  echo "Manual steps remaining:"
  echo "  1. Revert ~/.claude/.mcp.json (printed above)"
  echo "  2. Revert ~/.claude/settings.json (printed above)"
  echo "  3. Restart Claude Code session (printed above)"
  echo ""
}

main "$@"
