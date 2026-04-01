# WhatSoup Operational Runbook

> Practical reference for operating WhatSoup in production.
> Assumes the user systemd target is active and instances are installed under `~/.config/whatsoup/instances/<name>/`.

---

## Table of Contents

1. [Instances Quick Reference](#1-instances-quick-reference)
2. [Service Management](#2-service-management)
3. [Logs](#3-logs)
4. [Health Endpoint](#4-health-endpoint)
5. [Troubleshooting Guide](#5-troubleshooting-guide)
6. [Recovery Procedures](#6-recovery-procedures)
7. [Admin Operations](#7-admin-operations)
8. [Monitoring](#8-monitoring)

---

## 1. Instances Quick Reference

| Instance | Type | Access Mode | Health Port | Description |
|----------|------|-------------|-------------|-------------|
| `primary-line` | passive | self_only | **9094** | Primary line — MCP-only, no auto-response |
| `operator-agent` | agent | allowlist | **9092** | Full-access autonomous agent |
| `sandbox-agent` | agent | allowlist | **9091** | Sandboxed per-chat agent |
| `chat-bot` | chat | open_dm | **9093** | Chat Bot — direct LLM chat, no agent, no MCP |

**Key paths (per instance, replace `<name>`):**

| Resource | Path |
|----------|------|
| Config | `~/.config/whatsoup/instances/<name>/config.json` |
| Auth credentials | `~/.config/whatsoup/instances/<name>/auth/` |
| Database | `~/.local/share/whatsoup/instances/<name>/bot.db` |
| Logs | `~/.local/share/whatsoup/instances/<name>/logs/` |
| Lock file | `~/.local/state/whatsoup/instances/<name>/whatsoup.lock` |
| Media temp | `~/.local/share/whatsoup/instances/<name>/media/tmp/` |

---

## 2. Service Management

WhatSoup runs as a systemd user template unit (`whatsoup@<name>.service`).

### Start / Stop / Restart

```bash
# Start an instance
systemctl --user start whatsoup@sandbox-agent

# Stop an instance (graceful SIGTERM, 10s timeout then forced exit)
systemctl --user stop whatsoup@sandbox-agent

# Restart an instance
systemctl --user restart whatsoup@sandbox-agent

# Check status
systemctl --user status whatsoup@sandbox-agent

# Reload without full restart (not supported — always use restart)
```

### Enable / Disable on Login

```bash
# Enable auto-start on graphical login
systemctl --user enable whatsoup@sandbox-agent

# Disable auto-start
systemctl --user disable whatsoup@sandbox-agent
```

### Manage All Instances

```bash
# Start all four instances
for i in primary-line operator-agent sandbox-agent chat-bot; do systemctl --user start whatsoup@$i; done

# Stop all four instances
for i in primary-line operator-agent sandbox-agent chat-bot; do systemctl --user stop whatsoup@$i; done

# Check status of all instances
systemctl --user status 'whatsoup@*'
```

### Systemd Unit Configuration

The unit file is at `deploy/whatsoup@.service`.

Key parameters:
- `Restart=on-failure` — automatically restarts on non-zero exit
- `RestartSec=15` — waits 15 seconds before each restart attempt
- `StartLimitBurst=5` — max 5 restarts within `StartLimitIntervalSec=120` seconds
- After 5 failures in 2 minutes, systemd marks the unit as failed and stops restarting

To reset the restart counter after fixing a crash loop:
```bash
systemctl --user reset-failed whatsoup@sandbox-agent
systemctl --user start whatsoup@sandbox-agent
```

---

## 3. Logs

### Log Location

Logs are written to two sinks simultaneously:
- **stdout** — captured by journald (`systemctl --user status` / `journalctl`)
- **Rolling file** — daily rotation with 10-file retention at `~/.local/share/whatsoup/instances/<name>/logs/`

### Tail Logs

```bash
# Via journald (real-time)
journalctl --user -u whatsoup@sandbox-agent -f

# Via journald (last 100 lines)
journalctl --user -u whatsoup@sandbox-agent -n 100

# Via rolling log file
tail -f ~/.local/share/whatsoup/instances/sandbox-agent/logs/*.log

# All instances combined (journald)
journalctl --user -u 'whatsoup@*' -f
```

### Log Format

Logs are structured JSON (Pino v9). Each line is a JSON object. Key fields:

| Field | Description |
|-------|-------------|
| `time` | ISO 8601 timestamp |
| `level` | Log level (10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal) |
| `component` | Module that emitted the log (e.g. `main`, `health`, `session-manager`, `durability`) |
| `msg` | Human-readable message |
| `traceId` | 8-char hex per message — correlates ingest → runtime → outbound |
| `chatJid` | WhatsApp JID of the conversation |
| `sessionId` | Claude Code session ID (agent instances) |
| `durationMs` | Elapsed time for operations |
| `err` | Error object with `message` and `stack` |

### Log Levels

| Level | Meaning |
|-------|---------|
| `error` | Unrecoverable failures, crash notifications |
| `warn` | Degraded state, failed sends, missing config, stale lock files |
| `info` | Lifecycle events, tool completions, admin actions, access decisions |
| `debug` | Access policy decisions (demoted), frame processing, enrichment details |

### Change Log Level at Runtime

Set `LOG_LEVEL` in the instance's environment before starting, or add it to a systemd override:

```bash
# Create a drop-in override
systemctl --user edit whatsoup@sandbox-agent
# Add:
# [Service]
# Environment="LOG_LEVEL=debug"
```

### Useful Log Queries

```bash
# Show only errors and fatals
journalctl --user -u whatsoup@sandbox-agent | grep '"level":5'

# Show WhatsApp connection events
journalctl --user -u whatsoup@sandbox-agent | grep 'connection'

# Show access decisions for a specific phone
journalctl --user -u whatsoup@sandbox-agent | grep '15551234567'

# Show durability/recovery events
journalctl --user -u whatsoup@sandbox-agent | grep -E 'preConnect|postConnect|quarantine'
```

---

## 4. Health Endpoint

### URLs

| Instance | URL |
|----------|-----|
| primary-line | `http://127.0.0.1:9094/health` |
| q | `http://127.0.0.1:9092/health` |
| sandbox-agent | `http://127.0.0.1:9091/health` |
| chat-bot | `http://127.0.0.1:9093/health` |

### Authentication

The `GET /health` endpoint requires no authentication.

The `POST /send` endpoint requires a `Bearer` token:
```
Authorization: Bearer <WHATSOUP_HEALTH_TOKEN>
```
The token comes from the `WHATSOUP_HEALTH_TOKEN` environment variable. If unset, all `/send` calls return 401.

### Response Format

```json
{
  "status": "healthy",
  "uptime_seconds": 12345,
  "whatsapp": {
    "connected": true,
    "account_jid": "15551234567@s.whatsapp.net"
  },
  "sqlite": {
    "messages_total": 5000,
    "unprocessed": 12
  },
  "access_control": {
    "pending_count": 0
  },
  "enrichment": {
    "last_run": "2026-03-30T14:22:00.000Z"
  },
  "models": {
    "conversation": "claude-opus-4-6",
    "extraction": "claude-sonnet-4-6",
    "validation": "claude-haiku-4-5",
    "fallback": "gpt-5.4"
  },
  "durability": {
    "pendingOutbound": 0,
    "quarantinedOutbound": 0,
    "lastRecoveryAt": "2026-03-30T14:00:05.123Z"
  }
}
```

### Status Meanings

| Status | HTTP Code | Meaning |
|--------|-----------|---------|
| `healthy` | 200 | WhatsApp connected, enrichment fresh, no degraded state |
| `degraded` | 200 | WhatsApp connected but enrichment stale (>10 min) or runtime reports degraded state. Service is operational but impaired. |
| `unhealthy` | 503 | WhatsApp disconnected. Messages cannot be received or sent. |

**Important:** `degraded` returns HTTP 200 — enrichment staleness is a warning, not an outage. Monitoring scripts must inspect the JSON `status` field, not just the HTTP status code.

### Quick Health Check

```bash
# Check all instances
for port in 9091 9092 9093 9094; do
  echo -n "Port $port: "
  curl -s http://127.0.0.1:$port/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['status'], '| WA:', d['whatsapp']['connected'])"
done
```

---

## 5. Troubleshooting Guide

### 5.1 Agent Not Responding to Messages

**Symptoms:** Messages sent to the bot get no reply.

**Diagnostic steps:**

```bash
# 1. Check service is running
systemctl --user status whatsoup@q

# 2. Check WhatsApp connection
curl -s http://127.0.0.1:9092/health | python3 -c "import sys,json; d=json.load(sys.stdin); print(d)"

# 3. Check logs for the conversation
journalctl --user -u whatsoup@q -n 50 | grep -E 'ingest|dispatch|session|error'

# 4. Check if a Claude process is running
ps aux | grep claude | grep -v grep

# 5. Check for a stale session in the database
sqlite3 ~/.local/share/whatsoup/instances/q/bot.db \
  "SELECT conversation_key, session_status, claude_pid, updated_at FROM session_checkpoints ORDER BY updated_at DESC LIMIT 10;"
```

**Common causes:**
- Service is stopped — start it: `systemctl --user start whatsoup@q`
- WhatsApp disconnected — see §5.3
- Agent session crashed and didn't recover — send any message to spawn a new session
- Access list blocks the sender — check `access_list` table (see §7.1)
- Rate limit hit — check `rate_limits` table

---

### 5.2 Health Endpoint Returns Degraded

**Symptoms:** `GET /health` returns `"status": "degraded"`.

**Diagnostic steps:**

```bash
# 1. Get the full health response
curl -s http://127.0.0.1:9091/health | python3 -m json.tool

# 2. Check enrichment last_run timestamp
# If enrichment.last_run is > 10 minutes ago on a chat instance, this triggers degraded.
# Enrichment only runs on ChatRuntime (chat-bot). AgentRuntime and PassiveRuntime
# report degraded only if the runtime itself flags an issue.

# 3. Check durability quarantine count
# If durability.quarantinedOutbound > 0, messages were lost — investigate.

# 4. Check logs for enrichment errors (chat-bot only)
journalctl --user -u whatsoup@chat-bot -n 100 | grep -i enrich
```

**Common causes for chat-bot:**
- Anthropic/OpenAI API key expired or rate-limited
- Network connectivity issue
- `enrichment_retries` maxed out on many messages (run `reset_enrichment_errors` MCP tool)

**Common causes for agent instances:**
- Recent session crashes — check `durability.quarantinedOutbound` and `recentCrashCount` in the health JSON

---

### 5.3 WhatsApp Disconnected / Auth Expired

**Symptoms:** `whatsapp.connected = false` in health response, or logs show `DisconnectReason.loggedOut`.

**Quick check:**
```bash
journalctl --user -u whatsoup@sandbox-agent -n 30 | grep -E 'disconnect|loggedOut|reconnect'
```

**If the process is reconnecting automatically:** Wait — the connection manager retries on transient disconnects (e.g. `restartRequired`).

**If logged out (credentials expired):** Credentials must be refreshed via QR code. See §6.1 — Re-pairing WhatsApp.

**If the service keeps restart-looping:**
```bash
# Check restart count
systemctl --user status whatsoup@sandbox-agent | grep 'Start Limit'

# If hit the burst limit, reset it
systemctl --user reset-failed whatsoup@sandbox-agent
```

---

### 5.4 Stale Socket File

**Symptoms:** `health server port in use` in logs on startup, or `EADDRINUSE` error.

This occurs when a previous process died without releasing the health port, or (for agent instances) a Unix socket file was left behind.

**Fix:**

```bash
# 1. Check what holds the port (e.g. 9091 for sandbox-agent)
lsof -i :9091

# 2. If it's a zombie whatsoup process, kill it
kill -9 <PID>

# 3. Check for orphaned lock file
ls -la ~/.local/state/whatsoup/instances/sandbox-agent/whatsoup.lock

# 4. The lock file is self-healing: on next startup, WhatSoup checks if the PID
# in the lock is still alive. If not, it removes the stale lock and continues.
# Force-remove only if you're sure the process is dead:
rm ~/.local/state/whatsoup/instances/sandbox-agent/whatsoup.lock

# 5. Restart
systemctl --user start whatsoup@sandbox-agent
```

---

### 5.5 Orphaned Claude Processes

**Symptoms:** Multiple `claude` processes in `ps aux`, high CPU/memory.

This happens when the WhatSoup process crashed before it could SIGTERM its Claude Code children.

```bash
# 1. Find all claude processes
ps aux | grep 'claude ' | grep -v grep

# 2. Check which are legitimate (owned by running whatsoup instances)
sqlite3 ~/.local/share/whatsoup/instances/q/bot.db \
  "SELECT conversation_key, claude_pid, session_status FROM session_checkpoints WHERE session_status = 'active';"

# 3. Kill orphaned processes (PIDs not in the session_checkpoints table)
kill <PID>

# 4. After cleanup, the database will self-heal on next startup:
# preConnectRecovery() runs kill -0 on each checkpoint's claude_pid and marks
# dead sessions as 'orphaned' before any new connections are established.
```

---

### 5.6 Lock File Prevents Startup

**Symptoms:** Log shows `another instance is already running` and process exits immediately.

```bash
# 1. Check who holds the lock
cat ~/.local/state/whatsoup/instances/sandbox-agent/whatsoup.lock
# Output: {"pid":12345,"startedAt":"2026-03-30T10:00:00.000Z"}

# 2. Check if that PID is alive
kill -0 12345 2>&1
# "No such process" = stale lock

# 3. If stale, WhatSoup removes it automatically on the next startup attempt.
# If it doesn't (e.g. permission issue), remove manually:
rm ~/.local/state/whatsoup/instances/sandbox-agent/whatsoup.lock

# 4. Start the service
systemctl --user start whatsoup@sandbox-agent
```

---

### 5.7 Messages Not Being Delivered

**Symptoms:** Bot processes a message and generates a reply, but the reply never appears in WhatsApp.

```bash
# 1. Check outbound_ops for stuck or quarantined operations
sqlite3 ~/.local/share/whatsoup/instances/sandbox-agent/bot.db \
  "SELECT id, status, op_type, replay_policy, submitted_at, error
   FROM outbound_ops
   WHERE status NOT IN ('echoed', 'failed_permanent')
   ORDER BY id DESC LIMIT 20;"

# 2. Check for quarantined outbound ops (messages durability engine gave up on)
sqlite3 ~/.local/share/whatsoup/instances/sandbox-agent/bot.db \
  "SELECT COUNT(*) FROM outbound_ops WHERE status = 'quarantined';"

# 3. Check health for durability stats
curl -s http://127.0.0.1:9091/health | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print('pending:', d['durability']['pendingOutbound'], '| quarantined:', d['durability']['quarantinedOutbound'])"

# 4. Check WhatsApp is connected
curl -s http://127.0.0.1:9091/health | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d['whatsapp'])"
```

**Status meanings for `outbound_ops.status`:**
- `pending` — waiting to send (normal during queue flush)
- `sending` — send in progress
- `submitted` — sent to WhatsApp, waiting for echo confirmation
- `echoed` — confirmed delivered (normal terminal state)
- `maybe_sent` — send attempted but uncertain (network issue or crash mid-send)
- `failed_permanent` — permanent failure (e.g. invalid JID)
- `quarantined` — durability engine gave up; message may have been lost

---

## 6. Recovery Procedures

### 6.1 Re-pairing WhatsApp (QR Code Flow)

Use when credentials are expired (logged out) or the auth directory is corrupted.

**Prerequisites:** The bot instance must be stopped before running auth.

```bash
# 1. Stop the instance
systemctl --user stop whatsoup@sandbox-agent

# 2. (Optional) Back up existing auth state
cp -r ~/.config/whatsoup/instances/sandbox-agent/auth/ \
      ~/.config/whatsoup/instances/sandbox-agent/auth.bak.$(date +%Y%m%d)/

# 3. (If logged out / corrupted) Delete old auth state
rm -rf ~/.config/whatsoup/instances/sandbox-agent/auth/

# 4. Run the auth CLI — this prints a QR code to terminal
# Ensure no bot process holds the lock first (auth.ts checks for this)
node --experimental-strip-types ./src/transport/auth.ts

# 5. Scan the QR code with WhatsApp on your phone:
#    WhatsApp > Settings > Linked Devices > Link a Device
# You have 120 seconds to scan.

# 6. Wait for "Authenticated successfully as <jid>" and "Done. You can now start the bot."

# 7. Start the instance
systemctl --user start whatsoup@sandbox-agent
```

**Note:** The auth CLI uses `config.authDir` from the instance config — it reads `INSTANCE_CONFIG` from the environment. To pair for a specific instance, set the env var first, or run through the whatsoup launcher wrapper which sets it automatically.

A simpler approach is to run via the launcher with a temporary config:
```bash
# Stop, auth, restart
systemctl --user stop whatsoup@sandbox-agent
INSTANCE_CONFIG="$(cat ~/.config/whatsoup/instances/sandbox-agent/config.json | \
  node -e "const p=require('./src/instance-loader.ts'); ...")" \
  node --experimental-strip-types src/transport/auth.ts
systemctl --user start whatsoup@sandbox-agent
```

---

### 6.2 Clearing Stale State After Crash

After an unclean shutdown (OOM kill, power loss, etc.), run this before restarting:

```bash
INSTANCE=sandbox-agent

# 1. Stop the service (in case systemd is still trying to restart it)
systemctl --user stop whatsoup@$INSTANCE

# 2. Remove stale lock file (if present)
rm -f ~/.local/state/whatsoup/instances/$INSTANCE/whatsoup.lock

# 3. Kill any orphaned Claude processes
# Get PIDs from session_checkpoints
sqlite3 ~/.local/share/whatsoup/instances/$INSTANCE/bot.db \
  "SELECT claude_pid FROM session_checkpoints WHERE claude_pid IS NOT NULL AND session_status = 'active';" \
  | xargs -I{} sh -c 'kill -0 {} 2>/dev/null && kill {} || true'

# 4. The next startup will run preConnectRecovery() automatically:
#    - Marks orphaned sessions (dead claude_pid)
#    - Promotes 'sending' outbound ops to 'maybe_sent'
#    - Quarantines unsafe tool calls that were mid-execution
#    - Marks inbound events stuck in 'processing' as failed
#
# Then postConnectRecovery() runs after reconnect:
#    - Reconciles 'maybe_sent' ops against the messages table
#    - Re-enqueues safe ops for replay
#    - Quarantines unsafe ops

# 5. Start the service
systemctl --user start whatsoup@$INSTANCE

# 6. Verify recovery in logs
journalctl --user -u whatsoup@$INSTANCE -n 50 | grep -E 'preConnect|postConnect|recovery'
```

---

### 6.3 Handling Quarantined Messages

Quarantined outbound operations are messages the durability engine could not safely replay after a crash. They are preserved in the database for manual inspection.

```bash
INSTANCE=sandbox-agent
DB=~/.local/share/whatsoup/instances/$INSTANCE/bot.db

# 1. Inspect quarantined messages
sqlite3 $DB \
  "SELECT id, conversation_key, payload, error, submitted_at
   FROM outbound_ops WHERE status = 'quarantined'
   ORDER BY id DESC;"

# 2. Check the linked inbound event (the message that triggered this response)
sqlite3 $DB \
  "SELECT ie.seq, ie.message_id, ie.processing_status, ie.completed_at
   FROM outbound_ops op
   JOIN inbound_events ie ON op.source_inbound_seq = ie.seq
   WHERE op.status = 'quarantined';"

# 3. Decision options:
#    a) The message was actually sent (user received it): mark it echoed
sqlite3 $DB "UPDATE outbound_ops SET status = 'echoed' WHERE id = <ID>;"

#    b) The message was not sent and you want to discard it: mark failed_permanent
sqlite3 $DB "UPDATE outbound_ops SET status = 'failed_permanent', error = 'manually_discarded' WHERE id = <ID>;"

#    c) You want to re-attempt delivery: reset to pending (use with caution — may duplicate)
sqlite3 $DB "UPDATE outbound_ops SET status = 'pending', error = NULL WHERE id = <ID>;"
```

---

### 6.4 Restarting After Database Corruption

```bash
INSTANCE=sandbox-agent
DB=~/.local/share/whatsoup/instances/$INSTANCE/bot.db

# 1. Stop the service
systemctl --user stop whatsoup@$INSTANCE

# 2. Run SQLite integrity check
sqlite3 $DB "PRAGMA integrity_check;"
# Expected output: "ok"

# 3. If corruption is detected, attempt repair
sqlite3 $DB ".recover" | sqlite3 ${DB}.recovered
mv $DB ${DB}.corrupted.$(date +%Y%m%d%H%M%S)
mv ${DB}.recovered $DB

# 4. If unrecoverable, start fresh (auth state is separate — preserved)
mv $DB ${DB}.corrupted.$(date +%Y%m%d%H%M%S)
# The next startup will create a fresh database and run all 8 migrations.
# If another instance has the same phone's message history, a warm-start import
# will be attempted automatically from legacy paths.

# 5. Start the service
systemctl --user start whatsoup@$INSTANCE
```

---

## 7. Admin Operations

### 7.1 Approve or Block Users

Admins receive approval requests as WhatsApp messages when an unknown sender contacts the bot. Reply directly in WhatsApp:

```
ALLOW 15551234567       # approve a phone number
BLOCK 15551234567       # block a phone number
ALLOW 120363xxxxxx@g.us # approve a group
BLOCK 120363xxxxxx@g.us # block a group
```

After `ALLOW`, any messages the user sent while pending are replayed automatically.

**Groups:** If an admin adds the bot to a WhatsApp group, the group is auto-allowed without requiring an explicit `ALLOW` command.

### 7.2 Manage the Access List Directly

```bash
INSTANCE=sandbox-agent
DB=~/.local/share/whatsoup/instances/$INSTANCE/bot.db

# View all access list entries
sqlite3 $DB \
  "SELECT subject_type, subject_id, status, display_name, requested_at, decided_at
   FROM access_list ORDER BY status, decided_at DESC;"

# View pending approvals
sqlite3 $DB \
  "SELECT subject_type, subject_id, display_name, requested_at
   FROM access_list WHERE status = 'pending';"

# Manually allow a phone number
sqlite3 $DB \
  "UPDATE access_list SET status = 'allowed', decided_at = datetime('now')
   WHERE subject_type = 'phone' AND subject_id = '15551234567';"

# Manually block a phone number
sqlite3 $DB \
  "UPDATE access_list SET status = 'blocked', decided_at = datetime('now')
   WHERE subject_type = 'phone' AND subject_id = '15551234567';"

# Insert a new entry directly (e.g. pre-allow someone before they message)
sqlite3 $DB \
  "INSERT INTO access_list (subject_type, subject_id, status, display_name, decided_at)
   VALUES ('phone', '15551234567', 'allowed', 'Alice', datetime('now'));"
```

### 7.3 Check Inbound/Outbound Durability State

```bash
DB=~/.local/share/whatsoup/instances/sandbox-agent/bot.db

# Inbound events — messages currently being processed
sqlite3 $DB \
  "SELECT seq, message_id, processing_status, routed_to, received_at, completed_at
   FROM inbound_events
   WHERE processing_status NOT IN ('complete', 'failed')
   ORDER BY seq DESC LIMIT 20;"

# Outbound ops — pending/in-flight message sends
sqlite3 $DB \
  "SELECT id, status, op_type, replay_policy, submitted_at, error
   FROM outbound_ops
   WHERE status NOT IN ('echoed', 'failed_permanent')
   ORDER BY id DESC LIMIT 20;"

# Recent recovery runs
sqlite3 $DB \
  "SELECT trigger, inbound_replayed, outbound_reconciled, outbound_replayed,
          outbound_quarantined, tool_calls_quarantined, completed_at
   FROM recovery_runs ORDER BY id DESC LIMIT 5;"

# Session checkpoints (agent instances)
sqlite3 $DB \
  "SELECT conversation_key, session_id, session_status, claude_pid, updated_at
   FROM session_checkpoints ORDER BY updated_at DESC LIMIT 10;"
```

### 7.4 Useful SQL Queries

```bash
DB=~/.local/share/whatsoup/instances/sandbox-agent/bot.db

# Recent messages (last 20)
sqlite3 $DB \
  "SELECT timestamp, sender_name, content_type, substr(content, 1, 80)
   FROM messages ORDER BY timestamp DESC LIMIT 20;"

# Messages from a specific sender
sqlite3 $DB \
  "SELECT timestamp, content_type, substr(content, 1, 100)
   FROM messages WHERE sender_jid LIKE '%15551234567%'
   ORDER BY timestamp DESC LIMIT 20;"

# Message count by conversation
sqlite3 $DB \
  "SELECT conversation_key, COUNT(*) as count
   FROM messages GROUP BY conversation_key ORDER BY count DESC LIMIT 10;"

# Active agent sessions
sqlite3 $DB \
  "SELECT s.id, s.chat_jid, s.status, s.session_id, s.started_at
   FROM agent_sessions s WHERE s.status = 'active' ORDER BY s.started_at DESC;"

# Rate limit status
sqlite3 $DB \
  "SELECT conversation_key, count, window_start
   FROM rate_limits ORDER BY count DESC LIMIT 10;"

# Contacts directory
sqlite3 $DB \
  "SELECT jid, display_name, updated_at FROM contacts
   ORDER BY updated_at DESC LIMIT 20;"

# Enrichment errors (chat instances)
sqlite3 $DB \
  "SELECT message_id, enrichment_retries, content_type
   FROM messages WHERE enrichment_retries > 0 ORDER BY enrichment_retries DESC LIMIT 10;"
```

---

## 8. Monitoring

### What to Watch

| Signal | Check | Alert Threshold |
|--------|-------|-----------------|
| WhatsApp connected | `health.whatsapp.connected` | False for >2 min |
| Health status | `health.status` | `unhealthy` |
| Enrichment staleness | `health.enrichment.last_run` | Null or >15 min ago (chat instances only) |
| Quarantined messages | `health.durability.quarantinedOutbound` | >0 (means message was lost) |
| Pending outbound | `health.durability.pendingOutbound` | >50 (queue buildup) |
| Access list backlog | `health.access_control.pending_count` | >10 (new users queued) |
| Service restarts | `systemctl status` / journald | Restarted >3 times in 10 min |
| Disk space | Log directory size | >500MB (10 rolling files) |

### Simple Polling Script

```bash
#!/usr/bin/env bash
# Check all instance health endpoints
INSTANCES=( "primary-line:9094" "operator-agent:9092" "sandbox-agent:9091" "chat-bot:9093" )

for entry in "${INSTANCES[@]}"; do
  name="${entry%%:*}"
  port="${entry##*:}"
  result=$(curl -s --max-time 3 "http://127.0.0.1:$port/health" 2>/dev/null)
  if [ -z "$result" ]; then
    echo "[$name] UNREACHABLE (service may be down)"
    continue
  fi
  status=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','unknown'))" 2>/dev/null)
  connected=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['whatsapp']['connected'])" 2>/dev/null)
  quarantined=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('durability',{}).get('quarantinedOutbound',0))" 2>/dev/null)
  echo "[$name] status=$status  wa=$connected  quarantined=$quarantined"
done
```

### Alerting Suggestions

- **WhatsApp disconnect:** Alert immediately after 2 minutes. WhatsApp sessions expire if offline too long. Priority: high.
- **Service not running:** `systemctl --user is-active whatsoup@<name>` returning non-zero. Priority: high.
- **Quarantined messages accumulating:** Means the bot has lost messages it cannot replay. Investigate outbound_ops table. Priority: medium.
- **Start limit hit:** `systemctl --user status whatsoup@<name>` shows "failed" state. Needs manual `reset-failed` + investigation. Priority: high.
- **Large pending access list:** Unanswered approval requests from new users. Priority: low (informational).

### Log-Based Alerts

Key log patterns to monitor:

```bash
# Session crash (agent instances)
'claude process exited unexpectedly'

# Lock contention (another instance already running)
'another instance is already running'

# Auth expired
'Logged out'

# Quarantine events (messages lost)
'quarantined'

# Fatal errors
'"level":60'  # level 60 = fatal in pino
```

---

## Repair Reference

### Log locations
- journalctl: `journalctl --user -u whatsoup@<instance> -n 50 --no-pager`
- File logs: `~/.local/share/whatsoup/instances/<name>/logs/`

### Common error patterns
- **Session crash (exit code 1):** Usually from unhandled rejection or strip-types parse error. Check stderr in journal.
- **Decryption failure:** Signal session key desync. Check `decryption_failures` table. Usually self-resolves via Baileys retry.
- **Connection exhaustion:** Baileys reconnect loop. Check connection component logs.

### Service management
```
systemctl --user {start,stop,restart,status} whatsoup@<name>
```

### Test commands
```
cd ~/LAB/WhatSoup && npm test
```

### Health checks
```
curl -s localhost:<port>/health | python3 -m json.tool
```
Instance ports: primary-line=9094, sandbox-agent=9091, operator-agent=9092, chat-bot=9093

### DB locations
`~/.local/share/whatsoup/instances/<name>/bot.db`

### Heal system
- `heal_reports` table: circuit breaker state per error class
- `control_messages` table: audit trail of all control traffic
- `pending_heal_reports` table: the operator agent's temporary dedupe state for Type 3
