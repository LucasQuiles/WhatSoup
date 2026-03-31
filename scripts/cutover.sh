#!/usr/bin/env bash
# cutover.sh
#
# Guided cutover from whatsapp-bot / whatsapp-mcp to WhatSoup.
# Executes steps CUT-01 through CUT-11 from:
#   docs/specs/2026-03-31-cutover-operations-design.md
#
# Usage:
#   ./scripts/cutover.sh
#
# On failure at any step: run scripts/rollback.sh to revert.

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
abort()  {
  echo -e "\n${RED}CUTOVER ABORTED.${RESET}"
  echo "Run scripts/rollback.sh to revert any partial changes."
  exit 1
}

# Ask for confirmation before a major phase. Ctrl-C or 'n' aborts.
confirm() {
  local prompt="$1"
  echo -e "\n${YELLOW}${prompt}${RESET}"
  read -r -p "Continue? [y/N] " reply
  case "$reply" in
    [yY][eE][sS]|[yY]) return 0 ;;
    *) abort ;;
  esac
}

# ---------------------------------------------------------------------------
# Health-check helper
# Poll localhost:<port>/health every 2s, up to 30s.
# Succeeds when the response body contains "connected":true
# ---------------------------------------------------------------------------
wait_for_health() {
  local name="$1"
  local port="$2"
  local url="http://localhost:${port}/health"
  local deadline=$(( $(date +%s) + 30 ))

  info "Waiting for ${name} health on port ${port} (30s timeout)..."
  while true; do
    local now
    now=$(date +%s)
    if (( now >= deadline )); then
      fail "${name} health check timed out after 30s"
      return 1
    fi

    local body
    body=$(curl -sf --connect-timeout 2 "$url" 2>/dev/null || true)
    if [[ "$body" == *'"connected":true'* ]]; then
      ok "${name} is healthy (connected=true)"
      return 0
    fi

    sleep 2
  done
}

# ---------------------------------------------------------------------------
# PRE-FLIGHT CHECKS
# ---------------------------------------------------------------------------
run_preflight() {
  header "=== PRE-FLIGHT CHECKS ==="

  local any_failed=false

  # PRE-01: npm test
  info "PRE-01  Running npm test..."
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  if (cd "$REPO_ROOT" && npm test --silent > /tmp/whatsoup-test.log 2>&1); then
    ok "PRE-01  npm test passed"
  else
    fail "PRE-01  npm test FAILED — see /tmp/whatsoup-test.log"
    any_failed=true
  fi

  # PRE-02: whatsapp-bot@personal must be active
  info "PRE-02  Checking whatsapp-bot@personal is active..."
  if systemctl --user is-active --quiet whatsapp-bot@personal 2>/dev/null; then
    ok "PRE-02  whatsapp-bot@personal is active"
  else
    fail "PRE-02  whatsapp-bot@personal is NOT active — expected 'active' before cutover"
    any_failed=true
  fi

  # PRE-02: whatsapp-bot@loops and @besbot must NOT be active
  info "PRE-02  Checking whatsapp-bot@{loops,besbot} are inactive..."
  for inst in loops besbot; do
    if systemctl --user is-active --quiet "whatsapp-bot@${inst}" 2>/dev/null; then
      fail "PRE-02  whatsapp-bot@${inst} is ACTIVE — must be inactive or failed before cutover"
      any_failed=true
    else
      ok "PRE-02  whatsapp-bot@${inst} is inactive"
    fi
  done

  # PRE-03: whatsapp-mcp processes identified
  info "PRE-03  Identifying whatsapp-mcp processes..."
  local mcp_pids
  mcp_pids=$(pgrep -af whatsapp-mcp 2>/dev/null | grep -v grep || true)
  if [[ -n "$mcp_pids" ]]; then
    ok "PRE-03  whatsapp-mcp processes found (will be killed at CUT-02):"
    echo "$mcp_pids" | while IFS= read -r line; do echo "         $line"; done
  else
    ok "PRE-03  No whatsapp-mcp processes running (nothing to kill at CUT-02)"
  fi

  # PRE-04: Migration dry-run
  info "PRE-04  Running migration dry-run..."
  local migrate_script="$REPO_ROOT/scripts/migrate-namespace.sh"
  if [[ ! -x "$migrate_script" ]]; then
    fail "PRE-04  Migration script not found or not executable: $migrate_script"
    any_failed=true
  elif (bash "$migrate_script" --dry-run > /tmp/whatsoup-migrate-dry.log 2>&1); then
    ok "PRE-04  Migration dry-run passed — see /tmp/whatsoup-migrate-dry.log"
  else
    fail "PRE-04  Migration dry-run FAILED — see /tmp/whatsoup-migrate-dry.log"
    any_failed=true
  fi

  if $any_failed; then
    echo ""
    fail "One or more pre-flight checks failed. Fix them before proceeding."
    abort
  fi

  ok "All pre-flight checks passed."
}

# ---------------------------------------------------------------------------
# CUT-01: Stop whatsapp-bot@personal
# ---------------------------------------------------------------------------
run_cut01() {
  header "=== CUT-01: Stop whatsapp-bot@personal ==="

  info "Stopping whatsapp-bot@personal..."
  systemctl --user stop whatsapp-bot@personal

  # Gate: wait up to 10s for inactive
  local deadline=$(( $(date +%s) + 10 ))
  while true; do
    if ! systemctl --user is-active --quiet whatsapp-bot@personal 2>/dev/null; then
      ok "CUT-01  whatsapp-bot@personal is inactive"
      return 0
    fi
    if (( $(date +%s) >= deadline )); then
      fail "CUT-01  whatsapp-bot@personal did not stop within 10s"
      abort
    fi
    sleep 1
  done
}

# ---------------------------------------------------------------------------
# CUT-02: Kill lingering whatsapp-mcp processes
# ---------------------------------------------------------------------------
run_cut02() {
  header "=== CUT-02: Kill whatsapp-mcp processes ==="

  local pids
  pids=$(pgrep -f whatsapp-mcp 2>/dev/null || true)

  if [[ -z "$pids" ]]; then
    ok "CUT-02  No whatsapp-mcp processes found — nothing to kill"
    return 0
  fi

  info "Killing whatsapp-mcp PIDs: $pids"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true

  # Gate: verify gone within 5s
  local deadline=$(( $(date +%s) + 5 ))
  while true; do
    local remaining
    remaining=$(pgrep -f whatsapp-mcp 2>/dev/null || true)
    if [[ -z "$remaining" ]]; then
      ok "CUT-02  All whatsapp-mcp processes terminated"
      return 0
    fi
    if (( $(date +%s) >= deadline )); then
      fail "CUT-02  whatsapp-mcp processes still running after 5s: $remaining"
      info "Try: kill -9 $remaining"
      abort
    fi
    sleep 1
  done
}

# ---------------------------------------------------------------------------
# CUT-03: Run namespace migration
# ---------------------------------------------------------------------------
run_cut03() {
  header "=== CUT-03: Run namespace migration ==="

  local migrate_script
  migrate_script="$(cd "$(dirname "$0")" && pwd)/migrate-namespace.sh"

  info "Running migration script (live — not dry-run)..."
  if bash "$migrate_script" 2>&1 | tee /tmp/whatsoup-migrate.log; then
    ok "CUT-03  Migration completed — see /tmp/whatsoup-migrate.log"
  else
    fail "CUT-03  Migration script failed — see /tmp/whatsoup-migrate.log"
    info "Rollback note: legacy paths are untouched; restart whatsapp-bot@personal to revert"
    abort
  fi
}

# ---------------------------------------------------------------------------
# CUT-04 through CUT-07: Start whatsoup instances
# ---------------------------------------------------------------------------
run_cut04() {
  header "=== CUT-04: Start whatsoup@besbot ==="
  info "Starting whatsoup@besbot..."
  systemctl --user start whatsoup@besbot
  wait_for_health "whatsoup@besbot" 9093 || abort
  ok "CUT-04  whatsoup@besbot started"
}

run_cut05() {
  header "=== CUT-05: Start whatsoup@loops ==="
  info "Starting whatsoup@loops..."
  systemctl --user start whatsoup@loops
  wait_for_health "whatsoup@loops" 9091 || abort
  ok "CUT-05  whatsoup@loops started"
}

run_cut06() {
  header "=== CUT-06: Start whatsoup@q ==="
  info "Starting whatsoup@q..."
  systemctl --user start whatsoup@q
  wait_for_health "whatsoup@q" 9092 || abort
  ok "CUT-06  whatsoup@q started"
  info "Manual gate: send a test message to Q's number and verify the agent responds."
}

run_cut07() {
  header "=== CUT-07: Start whatsoup@personal ==="
  info "Starting whatsoup@personal..."
  systemctl --user start whatsoup@personal
  wait_for_health "whatsoup@personal" 9094 || abort

  # Gate: MCP socket exists
  local sock="$HOME/.local/state/whatsoup/instances/personal/whatsoup.sock"
  local deadline=$(( $(date +%s) + 15 ))
  info "Waiting for MCP socket at $sock..."
  while [[ ! -S "$sock" ]]; do
    if (( $(date +%s) >= deadline )); then
      fail "CUT-07  MCP socket not found after 15s: $sock"
      abort
    fi
    sleep 2
  done
  ok "CUT-07  MCP socket exists: $sock"
  ok "CUT-07  whatsoup@personal started"
}

# ---------------------------------------------------------------------------
# CUT-08: Print manual instructions for ~/.claude/.mcp.json
# ---------------------------------------------------------------------------
run_cut08() {
  header "=== CUT-08: Update ~/.claude/.mcp.json (MANUAL STEP) ==="
  echo ""
  echo -e "${YELLOW}ACTION REQUIRED — edit ~/.claude/.mcp.json manually:${RESET}"
  echo ""
  echo "  REMOVE this entry:"
  echo '    "whatsapp-mcp": { "type": "stdio", "command": "/home/q/.local/bin/whatsapp-mcp" }'
  echo ""
  echo "  ADD this entry:"
  cat <<'EOF'
    "whatsoup-personal": {
      "type": "stdio",
      "command": "node",
      "args": [
        "--experimental-strip-types",
        "/home/q/LAB/WhatSoup/deploy/mcp/whatsoup-proxy.ts"
      ],
      "env": {
        "WHATSOUP_SOCKET": "/home/q/.local/state/whatsoup/instances/personal/whatsoup.sock"
      }
    }
EOF
  echo ""
  echo -e "${RED}IMPORTANT:${RESET} WHATSOUP_SOCKET must be an absolute path — tilde (~) does NOT"
  echo "  expand inside JSON strings passed by Claude Code's MCP launcher."
  echo "  A literal ~ will cause ENOENT on socket connection."
  echo ""
}

# ---------------------------------------------------------------------------
# CUT-09: Print manual instructions for ~/.claude/settings.json
# ---------------------------------------------------------------------------
run_cut09() {
  header "=== CUT-09: Update ~/.claude/settings.json (MANUAL STEP) ==="
  echo ""
  echo -e "${YELLOW}ACTION REQUIRED — edit ~/.claude/settings.json manually:${RESET}"
  echo ""
  echo "  REMOVE from permissions.allow:"
  echo '    "mcp__whatsapp-mcp__list_chats"'
  echo '    "mcp__whatsapp-mcp__list_messages"'
  echo '    "mcp__whatsapp-mcp__search_messages"'
  echo '    "mcp__whatsapp-mcp__search_contacts"'
  echo '    "mcp__whatsapp-mcp__get_chat"'
  echo '    "mcp__whatsapp-mcp__get_message_context"'
  echo ""
  echo "  ADD to permissions.allow:"
  echo '    "mcp__whatsoup-personal__list_chats"'
  echo '    "mcp__whatsoup-personal__list_messages"'
  echo '    "mcp__whatsoup-personal__search_messages"'
  echo '    "mcp__whatsoup-personal__search_contacts"'
  echo '    "mcp__whatsoup-personal__get_chat"'
  echo '    "mcp__whatsoup-personal__get_message_context"'
  echo ""
  echo "  NOTE: All other WhatSoup tools (send_message, etc.) remain unapproved"
  echo "  and will require per-call user confirmation."
  echo ""
}

# ---------------------------------------------------------------------------
# CUT-10: Print manual instruction to restart Claude Code
# ---------------------------------------------------------------------------
run_cut10() {
  header "=== CUT-10: Restart Claude Code session (MANUAL STEP) ==="
  echo ""
  echo -e "${YELLOW}ACTION REQUIRED:${RESET}"
  echo "  Restart your Claude Code session to pick up the new MCP configuration."
  echo ""
  echo "  The session must fully restart (not just reload) so that:"
  echo "    - whatsapp-mcp MCP server is deregistered"
  echo "    - whatsoup-personal MCP server is registered and connected"
  echo ""
}

# ---------------------------------------------------------------------------
# CUT-11: Print smoke verification instructions
# ---------------------------------------------------------------------------
run_cut11() {
  header "=== CUT-11: Smoke verification (MANUAL STEP) ==="
  echo ""
  echo -e "${YELLOW}ACTION REQUIRED — from your Claude Code session after restart:${RESET}"
  echo ""
  echo "  1. Call list_chats (mcp__whatsoup-personal__list_chats)"
  echo "     Expected: returns your personal WhatsApp chats"
  echo ""
  echo "  2. Call search_messages (mcp__whatsoup-personal__search_messages)"
  echo "     Expected: returns search results"
  echo ""
  echo "  3. Call send_message to yourself"
  echo "     Expected: tool requires per-call user approval, message is delivered"
  echo ""
  echo "  If any of these fail, run scripts/rollback.sh to revert."
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  echo -e "${BOLD}WhatSoup Cutover Script${RESET}"
  echo "Spec: docs/specs/2026-03-31-cutover-operations-design.md"
  echo "On failure at any point: run scripts/rollback.sh"
  echo ""

  run_preflight

  confirm "Pre-flight passed. Ready to begin cutover (CUT-01 through CUT-07 will make changes)."

  run_cut01
  run_cut02
  run_cut03

  confirm "Migration complete. Ready to start WhatSoup services (CUT-04 through CUT-07)."

  run_cut04
  run_cut05
  run_cut06
  run_cut07

  confirm "All four WhatSoup services are running. Proceed to manual config steps (CUT-08 through CUT-11)?"

  run_cut08
  run_cut09
  run_cut10
  run_cut11

  echo -e "${GREEN}${BOLD}=== CUTOVER COMPLETE ===${RESET}"
  echo ""
  echo "Services running:"
  echo "  whatsoup@besbot   port 9093"
  echo "  whatsoup@loops    port 9091"
  echo "  whatsoup@q        port 9092"
  echo "  whatsoup@personal port 9094"
  echo ""
  echo "Next steps:"
  echo "  1. Complete the manual config edits printed above (CUT-08, CUT-09)"
  echo "  2. Restart Claude Code (CUT-10)"
  echo "  3. Run smoke verification from the new session (CUT-11)"
  echo "  4. Run scripts/soak-check.sh daily for the 48-hour soak period"
  echo ""
}

main "$@"
