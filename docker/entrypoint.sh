#!/usr/bin/env bash
set -euo pipefail

MODE="${WHATSOUP_MODE:-supervisor}"

case "$MODE" in

  # ── Supervisor: fleet + instances in one container ─────────────────────────
  supervisor)
    FLEET_PORT="${FLEET_PORT:-9099}"
    PIDS=()
    STOPPING=false

    cleanup() {
      STOPPING=true
      for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
      done
      wait
    }
    trap cleanup SIGTERM SIGINT

    # Start fleet server
    node src/fleet/standalone.ts "$FLEET_PORT" &
    PIDS+=($!)

    # Start each instance listed in WHATSOUP_INSTANCES (comma-separated)
    if [[ -n "${WHATSOUP_INSTANCES:-}" ]]; then
      IFS=',' read -ra INSTANCES <<< "$WHATSOUP_INSTANCES"
      for inst in "${INSTANCES[@]}"; do
        inst="$(echo "$inst" | xargs)"  # trim whitespace
        [ -z "$inst" ] && continue
        node src/bootstrap.ts "$inst" &
        PIDS+=($!)
      done
    fi

    # Wait for any child to exit. If a child dies unexpectedly, we tear down
    # the remaining children and let Docker (restart: unless-stopped) restart
    # the container — we intentionally do NOT try to restart children in-place.
    wait -n || true

    if [ "$STOPPING" = false ]; then
      cleanup
    fi
    ;;

  # ── Fleet only ─────────────────────────────────────────────────────────────
  fleet)
    FLEET_PORT="${FLEET_PORT:-9099}"
    exec node src/fleet/standalone.ts "$FLEET_PORT"
    ;;

  # ── Single instance ────────────────────────────────────────────────────────
  instance)
    INSTANCE="${WHATSOUP_INSTANCE:?WHATSOUP_INSTANCE is required}"
    exec node src/bootstrap.ts "$INSTANCE"
    ;;

  # ── Auth (QR code flow) ────────────────────────────────────────────────────
  auth)
    INSTANCE="${WHATSOUP_INSTANCE:?WHATSOUP_INSTANCE is required}"
    exec node src/bootstrap-auth.ts "$INSTANCE"
    ;;

  *)
    echo "Unknown WHATSOUP_MODE: $MODE (expected: supervisor, fleet, instance, auth)" >&2
    exit 1
    ;;
esac
