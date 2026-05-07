# Substrate slice 1 — runbook

## What's in the substrate

Per-instance durable memory: `beads`, `bead_triggers`, `trigger_runs`, `bead_events`, `entities`, `entity_aliases`, `entity_observations`, `bead_entity_refs`, `sweep_runs`. MCP tools live in `src/mcp/tools/substrate.ts` (18 tools). Obsidian vault defaults to `~/Documents/Obsidian/whatsoup-memory`, config key `memory.vaultPath`.

## Migration rollback

The schema lives in `MIGRATION_23` (`src/core/substrate/schema.ts`). To roll back on a single instance:

```
sqlite3 ~/.local/share/whatsoup/instances/<instance>/bot.db <<'SQL'
BEGIN;
DROP TABLE IF EXISTS bead_entity_refs;
DROP TABLE IF EXISTS entity_observations;
DROP TABLE IF EXISTS entity_aliases;
DROP TABLE IF EXISTS entities;
DROP TABLE IF EXISTS bead_events;
DROP TABLE IF EXISTS trigger_runs;
DROP TABLE IF EXISTS bead_triggers;
DROP TABLE IF EXISTS beads;
DROP TABLE IF EXISTS sweep_runs;
DELETE FROM schema_migrations WHERE version = 23;
COMMIT;
SQL
```

Greenfield migration — no data is lost on rollback unless substrate rows were already in use.

## Vault regen

The projector is library code; no CLI wrapper in slice 1. WhatSoup has no
build step (source `.ts` files are loaded via Node's native strip-types), so
the regen snippet imports the `.ts` modules directly. From the repo root:

```
node --experimental-strip-types --input-type=module -e "
  const { Database } = await import('./src/core/database.ts');
  const { regenerateVault } = await import('./src/core/substrate/vault.ts');
  const db = new Database(`${process.env.HOME}/.local/share/whatsoup/instances/example/bot.db`);
  db.open();
  console.log(regenerateVault(db.raw, { vaultPath: `${process.env.HOME}/Documents/Obsidian/whatsoup-memory` }));
  db.close();
"
```

Slice 3 will add a proper CLI wrapper.

## Common operations

**Reject all open proposals (bulk):**
```sql
UPDATE beads
   SET status='cancelled',
       cancelled_at=strftime('%s','now'),
       updated_at=strftime('%s','now')
 WHERE status='proposed';
```

**Extend an active watch to the policy cap:** use the MCP tool `extend_trigger` with `until = now + 72*3600`. Handler clamps.

**List due triggers right now (debug):**
```sql
SELECT id, kind, next_fire_at FROM bead_triggers
 WHERE status='active'
   AND next_fire_at IS NOT NULL
   AND next_fire_at <= strftime('%s','now')
   AND (terminal_at IS NULL OR terminal_at > strftime('%s','now'))
 ORDER BY next_fire_at ASC;
```

The trigger poller consumes this query shape.

## Inline-extractor behavior

Per `src/runtimes/agent/runtime.ts:handleMessage`, every inbound message authored by an admin phone is matched against the imperative whitelist (`remind me`, `schedule`, `watch for`, `follow up`, `make a task`, `track this`, `add a bead`). Matches persist a `status='proposed'` task bead with `actor='inline'`, `confidence=0.7`, and `proposal_reason='inline imperative: <verb>'`. Non-admin senders are ignored. The hook is best-effort for extractor and constraint failures: those log at warn level and the turn continues. Unrecoverable database failures are surfaced to the operator and fail the inbound turn.

To audit recent inline hits:
```sql
SELECT b.id, b.title, b.created_at, b.chat_jid
  FROM beads b
 WHERE b.status = 'proposed'
   AND EXISTS (SELECT 1 FROM bead_events e WHERE e.bead_id = b.id AND e.actor = 'inline')
 ORDER BY b.created_at DESC
 LIMIT 50;
```

Approve via the `approve_proposal` MCP tool; reject via `reject_proposal`. Both are admin-gated on `SessionContext.actorJid`.

## Admin gating model

Mutating substrate MCP tools gate on `SessionContext.actorJid` — the phone JID of the sender, NOT `deliveryJid` (the target chat). In groups these differ. Runtime callers must populate `actorJid` from the incoming message's `senderJid` before dispatching. Missing `actorJid` = rejected as admin-only, even for the admin's own DM. The runtime wires `actorJid` into socket-backed MCP sessions and updates the provider bridge before forwarding each turn.
