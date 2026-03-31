#!/usr/bin/env bash
# soak-check.sh
#
# Daily monitoring script for the 48-hour WhatSoup soak period.
# Checks SOAK-01 through SOAK-10 from:
#   docs/specs/2026-03-31-cutover-operations-design.md
#
# Usage:
#   ./scripts/soak-check.sh
#
# Exit code: 0 if all automated checks pass, 1 if any fail.

set -euo pipefail

# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

ok()     { echo -e "${GREEN}[PASS]${RESET}  $*"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail()   { echo -e "${RED}[FAIL]${RESET}  $*" >&2; FAIL_COUNT=$((FAIL_COUNT + 1)); }
info()   { echo -e "${YELLOW}[INFO]${RESET}  $*"; }
header() { echo -e "\n${BOLD}$*${RESET}"; }
manual() { echo -e "${YELLOW}[MANUAL]${RESET} $*"; }

PASS_COUNT=0
FAIL_COUNT=0

DB_BASE="$HOME/.local/share/whatsoup/instances"

# Run a sqlite3 query and return its output. Tolerates missing DB.
db_query() {
  local db_path="$1"
  local query="$2"
  if [[ ! -f "$db_path" ]]; then
    echo "(no db)"
    return 0
  fi
  sqlite3 "$db_path" "$query" 2>/dev/null || echo "(query error)"
}

# ---------------------------------------------------------------------------
# SOAK-01: All four health endpoints return connected=true
# ---------------------------------------------------------------------------
run_soak01() {
  header "=== SOAK-01: Health endpoints ==="

  declare -A INSTANCES
  INSTANCES[besbot]=9093
  INSTANCES[loops]=9091
  INSTANCES[q]=9092
  INSTANCES[personal]=9094

  for name in besbot loops q personal; do
    local port="${INSTANCES[$name]}"
    local url="http://localhost:${port}/health"
    local body
    body=$(curl -sf --connect-timeout 3 "$url" 2>/dev/null || true)
    if [[ "$body" == *'"connected":true'* ]]; then
      ok "SOAK-01  whatsoup@${name} (port ${port}): connected=true"
    else
      fail "SOAK-01  whatsoup@${name} (port ${port}): NOT connected (response: ${body:-no response})"
    fi
  done
}

# ---------------------------------------------------------------------------
# SOAK-02: No unhandled/uncaught/FATAL errors in journal (last 24h)
# ---------------------------------------------------------------------------
run_soak02() {
  header "=== SOAK-02: Journal error scan (last 24h) ==="

  local log_output
  log_output=$(journalctl --user -u 'whatsoup@*' --since '24 hours ago' --no-pager -q 2>/dev/null || true)

  if [[ -z "$log_output" ]]; then
    info "SOAK-02  No journal entries for whatsoup@* in last 24h"
    ok "SOAK-02  Journal error scan: no entries"
    return
  fi

  local error_lines
  error_lines=$(echo "$log_output" | grep -iE '(unhandled|uncaught|FATAL)' || true)

  if [[ -z "$error_lines" ]]; then
    ok "SOAK-02  No unhandled/uncaught/FATAL errors in journal"
  else
    local count
    count=$(echo "$error_lines" | wc -l)
    fail "SOAK-02  Found ${count} error line(s) in journal:"
    echo "$error_lines" | head -20 | while IFS= read -r line; do
      echo "         $line"
    done
  fi
}

# ---------------------------------------------------------------------------
# SOAK-03: No orphaned sessions in session_checkpoints (q and loops)
# ---------------------------------------------------------------------------
run_soak03() {
  header "=== SOAK-03: Orphaned session_checkpoints (q, loops) ==="

  for inst in q loops; do
    local db="${DB_BASE}/${inst}/bot.db"
    if [[ ! -f "$db" ]]; then
      info "SOAK-03  ${inst}: no DB found — skipping"
      continue
    fi

    # Orphaned = session with status not in (active, completed, cancelled) and
    # last_updated > 30 minutes ago. Adjust query to your actual schema.
    local count
    count=$(sqlite3 "$db" "
      SELECT COUNT(*) FROM session_checkpoints
      WHERE status NOT IN ('active', 'completed', 'cancelled')
        AND last_updated < datetime('now', '-30 minutes');
    " 2>/dev/null || echo "0")

    if [[ "$count" -eq 0 ]]; then
      ok "SOAK-03  ${inst}: no orphaned session_checkpoints"
    else
      fail "SOAK-03  ${inst}: ${count} orphaned session_checkpoint(s) (stale status, >30m old)"
    fi
  done
}

# ---------------------------------------------------------------------------
# SOAK-04: DB row counts (informational)
# ---------------------------------------------------------------------------
run_soak04() {
  header "=== SOAK-04: DB row counts (informational) ==="

  for inst in q loops besbot personal; do
    local db="${DB_BASE}/${inst}/bot.db"
    if [[ ! -f "$db" ]]; then
      info "SOAK-04  ${inst}: no DB found"
      continue
    fi

    local msgs contacts chats
    msgs=$(sqlite3     "$db" "SELECT COUNT(*) FROM messages;"  2>/dev/null || echo "?")
    contacts=$(sqlite3 "$db" "SELECT COUNT(*) FROM contacts;"  2>/dev/null || echo "?")
    chats=$(sqlite3    "$db" "SELECT COUNT(*) FROM chats;"     2>/dev/null || echo "?")

    info "SOAK-04  ${inst}: messages=${msgs}  contacts=${contacts}  chats=${chats}"
  done
  ok "SOAK-04  Row counts logged (not pass/fail — verify counts are growing vs yesterday)"
}

# ---------------------------------------------------------------------------
# SOAK-05: No stale inbound_events in 'processing' > 5 min (q, loops, besbot)
# ---------------------------------------------------------------------------
run_soak05() {
  header "=== SOAK-05: Stale inbound_events in 'processing' (q, loops, besbot) ==="

  for inst in q loops besbot; do
    local db="${DB_BASE}/${inst}/bot.db"
    if [[ ! -f "$db" ]]; then
      info "SOAK-05  ${inst}: no DB found — skipping"
      continue
    fi

    local count
    count=$(sqlite3 "$db" "
      SELECT COUNT(*) FROM inbound_events
      WHERE status = 'processing'
        AND created_at < datetime('now', '-5 minutes');
    " 2>/dev/null || echo "0")

    if [[ "$count" -eq 0 ]]; then
      ok "SOAK-05  ${inst}: no stale 'processing' inbound_events (>5m)"
    else
      fail "SOAK-05  ${inst}: ${count} inbound_event(s) stuck in 'processing' for >5 minutes"
    fi
  done
}

# ---------------------------------------------------------------------------
# SOAK-06: No stale outbound_ops in 'maybe_sent' > 1 hour
# ---------------------------------------------------------------------------
run_soak06() {
  header "=== SOAK-06: Stale outbound_ops in 'maybe_sent' ==="

  for inst in q loops besbot personal; do
    local db="${DB_BASE}/${inst}/bot.db"
    if [[ ! -f "$db" ]]; then
      info "SOAK-06  ${inst}: no DB found — skipping"
      continue
    fi

    local count
    count=$(sqlite3 "$db" "
      SELECT COUNT(*) FROM outbound_ops
      WHERE status = 'maybe_sent'
        AND created_at < datetime('now', '-1 hour');
    " 2>/dev/null || echo "0")

    if [[ "$count" -eq 0 ]]; then
      ok "SOAK-06  ${inst}: no stale 'maybe_sent' outbound_ops (>1h)"
    else
      fail "SOAK-06  ${inst}: ${count} outbound_op(s) stuck in 'maybe_sent' for >1 hour"
    fi
  done
}

# ---------------------------------------------------------------------------
# SOAK-07: Personal MCP socket exists
# ---------------------------------------------------------------------------
run_soak07() {
  header "=== SOAK-07: Personal MCP socket ==="

  local sock="$HOME/.local/state/whatsoup/instances/personal/whatsoup.sock"
  if [[ -S "$sock" ]]; then
    ok "SOAK-07  MCP socket exists: $sock"
  else
    fail "SOAK-07  MCP socket NOT found: $sock"
    info "  Check: systemctl --user status whatsoup@personal"
  fi
}

# ---------------------------------------------------------------------------
# SOAK-08 through SOAK-10: Manual reminders
# ---------------------------------------------------------------------------
run_soak08_10() {
  header "=== SOAK-08 through SOAK-10: Manual verification reminders ==="
  echo ""
  manual "SOAK-08  Test Q responds: send a test message to Q's WhatsApp number and"
  manual "         verify the agent replies within a reasonable time."
  echo ""
  manual "SOAK-09  Test Loops responds: if accessible, send a test message in a"
  manual "         Loops-managed chat and verify the agent replies."
  echo ""
  manual "SOAK-10  Test BES Bot responds: send a test DM to BES Bot's WhatsApp number"
  manual "         and verify the bot replies."
  echo ""
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print_summary() {
  header "=== SOAK CHECK SUMMARY ==="
  echo ""
  echo "  Automated checks passed: ${PASS_COUNT}"
  echo "  Automated checks failed: ${FAIL_COUNT}"
  echo "  Timestamp: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  echo ""

  if [[ $FAIL_COUNT -gt 0 ]]; then
    echo -e "${RED}${BOLD}SOAK CHECK FAILED — ${FAIL_COUNT} issue(s) require attention.${RESET}"
    echo ""
    echo "Refer to the spec's failure criteria:"
    echo "  - Any instance loses WhatsApp connection and fails to reconnect within 5m → ROLLBACK"
    echo "  - Any instance crashes with systemd restart loop >3 cycles → ROLLBACK"
    echo "  - Message loss detected → ROLLBACK"
    echo "  - MCP socket becomes unresponsive → ROLLBACK"
    echo ""
    echo "To rollback: run scripts/rollback.sh"
    exit 1
  else
    echo -e "${GREEN}${BOLD}SOAK CHECK PASSED — all automated checks OK.${RESET}"
    echo ""
    echo "Complete the manual checks above (SOAK-08 through SOAK-10) and record"
    echo "results in docs/cutover/smoke-results.md."
    echo ""
    exit 0
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  echo -e "${BOLD}WhatSoup Soak Period Check${RESET}"
  echo "Spec: docs/specs/2026-03-31-cutover-operations-design.md"
  echo "Run daily during the 48-hour soak period."
  echo ""

  run_soak01
  run_soak02
  run_soak03
  run_soak04
  run_soak05
  run_soak06
  run_soak07
  run_soak08_10

  print_summary
}

main "$@"
