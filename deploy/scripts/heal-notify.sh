#!/usr/bin/env bash
set -euo pipefail
INSTANCE="${1:?Usage: heal-notify.sh <instance-name>}"
CONTEXT=$(journalctl --user -u "whatsoup@${INSTANCE}" -n 20 --no-pager -o cat 2>/dev/null || echo "no logs available")
ERROR_LINE=$(echo "$CONTEXT" | grep -oP '"msg":"[^"]*"' | tail -1 || echo "unknown error")
TOKEN=$(secret-tool lookup service whatsoup_health 2>/dev/null || echo "")
if [ -z "$TOKEN" ]; then
  echo "WHATSOUP_HEALTH_TOKEN not in keyring — cannot notify Q" >&2
  exit 1
fi
curl -sf -X POST http://127.0.0.1:9092/heal \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "$(jq -n --arg inst "$INSTANCE" --arg ctx "$CONTEXT" --arg err "$ERROR_LINE" \
    '{type:"service_crash",instance:$inst,context:$ctx,errorHint:$err}')" \
  || echo "Failed to notify Q — is whatsoup@q running?" >&2
