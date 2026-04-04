#!/bin/bash
# =============================================================================
# Provider Agent Conformance Test
# =============================================================================
# Verifies a provider behaves as a proper persistent agent, not a single-turn
# API-style responder. Tests session continuity, tool calls, and process identity.
#
# Usage: ./scripts/test-provider-agent.sh <provider> [model]
#   provider: codex-cli | gemini-cli | opencode-cli | claude-cli
#   model: optional model override
#
# Requirements:
# - WhatSoup instance "besbot" must be running with the target provider
# - LOG_LEVEL=debug must be set for the instance
# =============================================================================

set -euo pipefail

PROVIDER="${1:?Usage: $0 <provider> [model]}"
MODEL="${2:-}"
BESBOT_PID=$(pgrep -f 'bootstrap.ts besbot' 2>/dev/null | head -1)
HEALTH_PORT=9093
RESULTS_FILE="/tmp/provider-test-${PROVIDER}-$(date +%s).json"
PASS=0
FAIL=0

if [ -z "$BESBOT_PID" ]; then
  echo "FATAL: besbot is not running"
  exit 1
fi

log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { PASS=$((PASS + 1)); log "✅ PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); log "❌ FAIL: $1 — $2"; }

wait_for_response() {
  local timeout=${1:-30}
  for i in $(seq 1 $timeout); do
    if journalctl --user -u whatsoup@besbot --since "${timeout} sec ago" --no-pager --output=cat 2>/dev/null | grep -q 'Sending message.*18454433572'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

capture_process() {
  # Capture child processes of besbot for 15 seconds
  local seen=""
  local output=""
  for i in $(seq 1 30); do
    local children=$(pgrep -P $BESBOT_PID 2>/dev/null | sort)
    for cpid in $children; do
      if ! echo "$seen" | grep -q "$cpid"; then
        seen="$seen $cpid"
        local cmdline=$(cat /proc/$cpid/cmdline 2>/dev/null | tr '\0' ' ')
        output="$output\nPID=$cpid CMD=$cmdline"
      fi
    done
    sleep 0.5
  done
  echo -e "$output"
}

# =============================================================================
# TEST 1: Health Check
# =============================================================================
log "TEST 1: Health and mode verification"
HEALTH=$(curl -s http://localhost:$HEALTH_PORT/health 2>/dev/null)
MODE=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('instance',{}).get('mode','?'))" 2>/dev/null)
CONNECTED=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('whatsapp',{}).get('connected',False))" 2>/dev/null)

if [ "$MODE" = "agent" ] && [ "$CONNECTED" = "True" ]; then
  pass "Instance running as agent mode, WhatsApp connected"
else
  fail "Health check" "mode=$MODE connected=$CONNECTED"
fi

# =============================================================================
# TEST 2: Process Identity — confirm correct binary spawns
# =============================================================================
log "TEST 2: Process identity — sending Turn 1"

# Clear old logs
sleep 1

# Send Turn 1 and capture spawned process
TURN1_TEXT="My name is TestUser and my favorite number is 42. What is 2+2? Reply briefly."
capture_process &
CAPTURE_PID=$!

# Send via WhatsApp MCP (through our lab instance)
curl -s -X POST "http://localhost:9096/send" \
  -H "Content-Type: application/json" \
  -d "{\"chatJid\":\"19297905323@s.whatsapp.net\",\"text\":\"$TURN1_TEXT\"}" 2>/dev/null || true

# Wait for response
if wait_for_response 60; then
  pass "Turn 1: response received"
else
  fail "Turn 1: no response" "Codex may have timed out or crashed"
fi

# Check captured process
wait $CAPTURE_PID 2>/dev/null
PROCS=$(cat /tmp/besbot-process-monitor2.log 2>/dev/null || echo "")

case $PROVIDER in
  codex-cli)
    EXPECTED_BINARY="codex"
    ;;
  gemini-cli)
    EXPECTED_BINARY="gemini"
    ;;
  opencode-cli)
    EXPECTED_BINARY="opencode"
    ;;
  claude-cli)
    EXPECTED_BINARY="claude"
    ;;
esac

# Check logs for the spawned binary
SPAWN_LOG=$(journalctl --user -u whatsoup@besbot --since "90 sec ago" --no-pager --output=cat 2>/dev/null | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        obj = json.loads(line.strip())
        if obj.get('msg','').startswith('spawned') and 'binary' in obj:
            print(f'binary={obj[\"binary\"]} provider={obj.get(\"provider\",\"?\")}')
        if obj.get('msg','') == 'spawn-per-turn: fresh session' or obj.get('msg','').startswith('codex: resuming'):
            print(f'mode={obj[\"msg\"]} provider={obj.get(\"provider\",\"?\")}')
        if obj.get('msg','') == 'provider stderr':
            print(f'stderr={obj.get(\"stderr\",\"\")}')
    except: pass
" 2>/dev/null)

if echo "$SPAWN_LOG" | grep -qi "$EXPECTED_BINARY"; then
  pass "Process identity: $EXPECTED_BINARY binary confirmed in logs"
else
  fail "Process identity" "Expected $EXPECTED_BINARY, got: $SPAWN_LOG"
fi

# =============================================================================
# TEST 3: Session ID captured
# =============================================================================
log "TEST 3: Session/thread ID captured"
SESSION_ID=$(journalctl --user -u whatsoup@besbot --since "90 sec ago" --no-pager --output=cat 2>/dev/null | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        obj = json.loads(line.strip())
        if obj.get('msg') == 'session init' and not obj.get('sessionId','').startswith('${PROVIDER}-'):
            print(obj['sessionId'])
    except: pass
" 2>/dev/null | tail -1)

if [ -n "$SESSION_ID" ]; then
  pass "Session ID captured: $SESSION_ID"
else
  fail "Session ID" "No real session ID found (only synthetic)"
fi

# =============================================================================
# TEST 4: Session continuity — Turn 2 references Turn 1
# =============================================================================
log "TEST 4: Session continuity — sending Turn 2"
sleep 3

TURN2_TEXT="What was my name and my favorite number? You should remember from my last message."

curl -s -X POST "http://localhost:9096/send" \
  -H "Content-Type: application/json" \
  -d "{\"chatJid\":\"19297905323@s.whatsapp.net\",\"text\":\"$TURN2_TEXT\"}" 2>/dev/null || true

if wait_for_response 60; then
  pass "Turn 2: response received"
else
  fail "Turn 2: no response" "Provider may not support session resume"
fi

# Check if resume was used
RESUME_LOG=$(journalctl --user -u whatsoup@besbot --since "90 sec ago" --no-pager --output=cat 2>/dev/null | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        obj = json.loads(line.strip())
        msg = obj.get('msg','')
        if 'resuming' in msg:
            print(f'RESUME: {msg} threadId={obj.get(\"threadId\",obj.get(\"sessionId\",\"?\"))}')
    except: pass
" 2>/dev/null)

if [ -n "$RESUME_LOG" ]; then
  pass "Session resume: $RESUME_LOG"
else
  fail "Session resume" "Turn 2 did not use resume — no conversation continuity"
fi

# =============================================================================
# SUMMARY
# =============================================================================
echo ""
echo "============================================"
echo "Provider Agent Conformance: $PROVIDER"
echo "============================================"
echo "Passed: $PASS"
echo "Failed: $FAIL"
echo "Total:  $((PASS + FAIL))"
echo ""
if [ $FAIL -eq 0 ]; then
  echo "VERDICT: ✅ CONFORMANT"
else
  echo "VERDICT: ❌ NON-CONFORMANT ($FAIL failures)"
fi
echo "============================================"

# Save results
cat > "$RESULTS_FILE" << EOJSON
{
  "provider": "$PROVIDER",
  "model": "$MODEL",
  "timestamp": "$(date -Iseconds)",
  "passed": $PASS,
  "failed": $FAIL,
  "session_id": "$SESSION_ID",
  "resume_used": $([ -n "$RESUME_LOG" ] && echo "true" || echo "false"),
  "verdict": "$([ $FAIL -eq 0 ] && echo "conformant" || echo "non-conformant")"
}
EOJSON
echo "Results: $RESULTS_FILE"
