import type { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS protected_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage_operation_id TEXT NOT NULL UNIQUE,
    resolve_operation_id TEXT NOT NULL UNIQUE,
    delivery_ref TEXT UNIQUE,
    delivery_id TEXT,
    principal TEXT NOT NULL,
    recipient_jid TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('rustdesk', 'secret')),
    device_id TEXT,
    purpose TEXT CHECK (purpose IS NULL OR purpose IN ('login', 'recovery')),
    whatsapp_message_id TEXT NOT NULL UNIQUE,
    outbound_send_id INTEGER,
    state TEXT NOT NULL CHECK (state IN (
      'staging', 'staged', 'resolving', 'submitted', 'delivered', 'read', 'ambiguous', 'failed', 'expired'
    )),
    expires_at TEXT,
    issued_at TEXT NOT NULL,
    first_attempt_at TEXT,
    last_attempt_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 3),
    send_claim_token TEXT,
    send_claimed_at TEXT,
    terminal_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (
      (kind = 'rustdesk' AND device_id IS NOT NULL AND purpose IS NOT NULL)
      OR (kind = 'secret' AND device_id IS NULL AND purpose IS NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS idx_protected_deliveries_principal_state
    ON protected_deliveries(principal, state, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_protected_deliveries_whatsapp_message
    ON protected_deliveries(whatsapp_message_id);
  CREATE INDEX IF NOT EXISTS idx_protected_deliveries_issued
    ON protected_deliveries(issued_at);

  CREATE TABLE IF NOT EXISTS protected_delivery_events (
    event_id TEXT PRIMARY KEY,
    delivery_ref TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('submitted', 'delivered', 'read', 'ambiguous', 'failed')),
    observed_at TEXT NOT NULL,
    relayed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (delivery_ref) REFERENCES protected_deliveries(delivery_ref) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_protected_delivery_events_unrelayed
    ON protected_delivery_events(relayed_at, created_at)
    WHERE relayed_at IS NULL;
`;

export function runMigration67(db: DatabaseSync): void {
  db.exec('SAVEPOINT migration_67');
  try {
    db.exec(SCHEMA);
    db.exec('RELEASE migration_67');
  } catch (error) {
    db.exec('ROLLBACK TO migration_67');
    db.exec('RELEASE migration_67');
    throw error;
  }
}
