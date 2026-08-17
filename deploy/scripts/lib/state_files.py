"""Single source of truth for bot-errors state filenames (QPKT-3051-3050 §4 Module 2).

Imported by every component so a rename propagates to all readers/writers
atomically. Cures the #3050 false-green class (watchdog reads other components'
state by literal name; a rename in the writer silently desyncs the reader →
missing file → spurious green).

Car A (#3050 ONLY): these are plain string constants — byte-identical to the
literals they replace. No path-shape changes, no state_root reconciliation
(that is Car B / #3051, packet §7).
"""

# Cross-component controller state (writers: collector/dispatcher; readers: watchdog/health-check)
COLLECTOR_STATE = "collector-state.json"
DISPATCHER_STATE = "dispatcher-state.json"
INCIDENT_STATE = "incident-state.json"
DISPATCHER_META_STATE = "dispatcher-meta-state.json"

# Maintenance window (written by BOTH dispatcher and maintenance.py — MUST share one constant)
MAINTENANCE = "maintenance.json"

# Per-component self state
HEARTBEAT_WATCHDOG_STATE = "heartbeat-watchdog-state.json"
SELFCHECK_STATE = "selfcheck-state.json"
DEADMAN_STATE = "deadman-state.json"
TOOL_INVENTORY_STATE = "tool-inventory-state.json"
GUI_SESSION_MONITOR_STATE = "gui-session-monitor-state.json"
RUNTIME_STALENESS_STATE = "runtime-staleness-state.json"
REPLY_GUARANTEE_OBSERVER_STATE = "reply-guarantee-observer-state.json"

# Sentinel component (written under fleet-sentinel root; read cross-component by watchdog)
SENTINEL_HEARTBEAT = "sentinel-heartbeat.json"
FLEET_SENTINEL_STATE = "fleet-sentinel-state.json"

# q-loop parallel namespace — filename only (the q-loop STATE_DIR is a separate
# root, #3051/Car-B surface; only the filename literal is centralized here)
Q_LOOP_STATE = "state.json"
