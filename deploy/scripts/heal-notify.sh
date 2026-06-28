#!/usr/bin/env bash
set -uo pipefail
INSTANCE="${1:?Usage: heal-notify.sh <instance-name>}"

# Config root mirrors src/fleet/paths.ts: ${XDG_CONFIG_HOME:-~/.config}/whatsoup/instances/<name>/
INSTANCE_CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/whatsoup/instances/${INSTANCE}"

# Intentional-restart suppression: a deliberate self-restart writes a private
# marker into the instance dataRoot before asking systemd to restart. If a fresh
# marker (<5 min) is present, this OnFailure run is a deliberate restart — not a
# crash — so suppress the alert and consume the marker BEFORE gathering evidence.
# Resolve dataRoot from config.json; fall back to the XDG data layout in paths.ts.
DATA_ROOT=$(jq -r '.paths.dataRoot // empty' "${INSTANCE_CONFIG_ROOT}/config.json" 2>/dev/null || echo "")
if [ -z "$DATA_ROOT" ]; then
    DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/whatsoup/instances/${INSTANCE}"
fi
RESTART_MARKER="${DATA_ROOT}/intentional-restart.marker"
if [ -f "$RESTART_MARKER" ] && [ -n "$(find "$RESTART_MARKER" -mmin -5 2>/dev/null)" ]; then
    echo "heal-notify: intentional restart detected for ${INSTANCE}; suppressing crash alert" >&2
    rm -f "$RESTART_MARKER"
    exit 0
fi

# Gather evidence
CONTEXT=$(journalctl --user -u "whatsoup@${INSTANCE}" -n 20 --no-pager -o cat 2>/dev/null || echo "no logs available")
ERROR_LINE=$(echo "$CONTEXT" | grep -oE '"msg":"[^"]*"' | tail -1 || echo "unknown error")

# Resolve this instance's own healthPort from its config.json (INSTANCE_CONFIG_ROOT set above).
HEALTH_PORT=$(jq -r '.healthPort // empty' "${INSTANCE_CONFIG_ROOT}/config.json" 2>/dev/null || echo "")
if [ -z "$HEALTH_PORT" ] || ! printf '%s' "$HEALTH_PORT" | grep -qE '^[0-9]+$'; then
    HEALTH_PORT=9090
fi

# Read the instance's own health token from tokens.env (written by generate-health-tokens.sh).
# Fall back to the legacy keyring lookup for hosts that have not migrated.
TOKEN=""
TOKENS_ENV="${INSTANCE_CONFIG_ROOT}/tokens.env"
if [ -f "$TOKENS_ENV" ]; then
    TOKEN=$(grep -E '^WHATSOUP_HEALTH_TOKEN=' "$TOKENS_ENV" 2>/dev/null \
        | head -1 | cut -d= -f2- | tr -d '[:space:]') || TOKEN=""
fi
if [ -z "$TOKEN" ]; then
    TOKEN=$(secret-tool lookup service whatsoup-health-token user "$INSTANCE" 2>/dev/null || echo "")
fi
if [ -z "$TOKEN" ]; then
    TOKEN=$(secret-tool lookup service whatsoup_health 2>/dev/null || echo "")
fi

if [ -n "$TOKEN" ]; then
    HEAL_URL="http://127.0.0.1:${HEALTH_PORT}/heal"
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
ALERT_BIN="${WHATSOUP_ALERT_BIN:-$HOME/.local/bin/whatsapp-alert}"
if [ ! -x "$ALERT_BIN" ]; then
    echo "heal-notify: alert binary not found or not executable: $ALERT_BIN" >&2
    exit 1
fi
exec "$ALERT_BIN" \
    --instance "$INSTANCE" --source service_crash \
    --summary "whatsoup@${INSTANCE} service failed (systemd OnFailure)" \
    --evidence "$EVIDENCE"
