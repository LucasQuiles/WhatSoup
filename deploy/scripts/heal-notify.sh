#!/usr/bin/env bash
set -uo pipefail
INSTANCE="${1:?Usage: heal-notify.sh <instance-name>}"

# Gather evidence
CONTEXT=$(journalctl --user -u "whatsoup@${INSTANCE}" -n 20 --no-pager -o cat 2>/dev/null || echo "no logs available")
ERROR_LINE=$(echo "$CONTEXT" | grep -oP '"msg":"[^"]*"' | tail -1 || echo "unknown error")

# Try the internal heal path first
TOKEN=$(secret-tool lookup service whatsoup_health 2>/dev/null || echo "")
if [ -n "$TOKEN" ]; then
    HEAL_URL="http://127.0.0.1:9092/heal"
    PAYLOAD=$(jq -n --arg inst "$INSTANCE" --arg ctx "$CONTEXT" --arg err "$ERROR_LINE" \
        '{type:"service_crash",instance:$inst,context:$ctx,errorHint:$err}')

    HEAL_STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -d "$PAYLOAD" "$HEAL_URL" 2>/dev/null) || HEAL_STATUS=0

    if [ "$HEAL_STATUS" -ge 200 ] && [ "$HEAL_STATUS" -lt 300 ]; then
        exit 0
    fi
fi

# Heal path failed or unavailable — fall back to WhatsApp alert lane
EVIDENCE=$(echo "$CONTEXT" | tail -3)
exec /home/q/.local/bin/whatsapp-alert \
    --instance "$INSTANCE" --source service_crash \
    --summary "whatsoup@${INSTANCE} service failed (systemd OnFailure)" \
    --evidence "$EVIDENCE"
