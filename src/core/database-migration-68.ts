import type { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS protected_secret_inputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    create_operation_id TEXT NOT NULL UNIQUE,
    resolve_operation_id TEXT NOT NULL UNIQUE,
    intake_id TEXT UNIQUE,
    principal TEXT NOT NULL,
    recipient_jid TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('password', 'token', 'mfa')),
    purpose TEXT NOT NULL,
    account_label TEXT,
    consumer_label TEXT,
    action TEXT,
    save_allowed INTEGER,
    input_state TEXT NOT NULL CHECK (input_state IN (
      'creating', 'awaiting_input', 'submitted', 'consuming', 'succeeded',
      'failed', 'expired', 'revoked', 'ambiguous', 'cancelled'
    )),
    delivery_status TEXT NOT NULL CHECK (delivery_status IN (
      'pending', 'resolving', 'submitted', 'delivered', 'read', 'ambiguous', 'failed'
    )),
    whatsapp_message_id TEXT NOT NULL UNIQUE,
    outbound_send_id INTEGER,
    expires_at TEXT,
    issued_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (save_allowed IS NULL OR save_allowed IN (0, 1))
  );
  CREATE INDEX IF NOT EXISTS idx_protected_secret_inputs_principal_state
    ON protected_secret_inputs(principal, input_state, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_protected_secret_inputs_whatsapp_message
    ON protected_secret_inputs(whatsapp_message_id);
  CREATE INDEX IF NOT EXISTS idx_protected_secret_inputs_issued
    ON protected_secret_inputs(issued_at);
`;

export function runMigration68(db: DatabaseSync): void {
  db.exec('SAVEPOINT migration_68');
  try {
    db.exec(SCHEMA);
    db.exec('RELEASE migration_68');
  } catch (error) {
    db.exec('ROLLBACK TO migration_68');
    db.exec('RELEASE migration_68');
    throw error;
  }
}
