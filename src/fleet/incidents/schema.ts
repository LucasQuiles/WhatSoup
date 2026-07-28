export const DISPOSITIONS = [
  'incident_opened',
  'incident_updated',
  'incident_resolved',
  'heartbeat_recorded',
  'notice_recorded',
  'stored_no_state_change',
  'stored_stale_observation',
  'stored_quarantined_observation',
] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

export interface IncidentMigration {
  version: number;
  statements: readonly string[];
}

export const MIGRATIONS: readonly IncidentMigration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE meta (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL
       ) STRICT`,
      `CREATE TABLE events (
         event_id INTEGER PRIMARY KEY AUTOINCREMENT,
         producer_id TEXT NOT NULL,
         producer_domain_id TEXT NOT NULL,
         signal_id TEXT NOT NULL,
         payload_digest TEXT NOT NULL,
         payload_json TEXT NOT NULL,
         kind TEXT NOT NULL CHECK (kind IN (
           'condition_observed', 'condition_recovered',
           'heartbeat_observed', 'notice_recorded')),
         subject TEXT NOT NULL,
         condition_class TEXT,
         occurrence_id TEXT,
         occurrence_seq INTEGER,
         observed_at TEXT NOT NULL,
         received_at TEXT NOT NULL,
         disposition TEXT NOT NULL CHECK (disposition IN (
           'incident_opened', 'incident_updated', 'incident_resolved',
           'heartbeat_recorded', 'notice_recorded', 'stored_no_state_change',
           'stored_stale_observation', 'stored_quarantined_observation')),
         incident_id INTEGER,
         transition_id INTEGER,
         UNIQUE (producer_id, signal_id)
       ) STRICT`,
      `CREATE TABLE incidents (
         incident_id INTEGER PRIMARY KEY AUTOINCREMENT,
         producer_domain_id TEXT NOT NULL,
         subject TEXT NOT NULL,
         condition_class TEXT NOT NULL,
         occurrence_id TEXT NOT NULL,
         condition_state TEXT NOT NULL CHECK (condition_state IN (
           'open', 'resolved', 'superseded', 'orphaned', 'closed_by_override')),
         severity TEXT,
         opened_event_id INTEGER NOT NULL,
         last_observed_at TEXT NOT NULL,
         last_occurrence_seq INTEGER NOT NULL,
         projection_version INTEGER NOT NULL,
         UNIQUE (producer_domain_id, subject, condition_class, occurrence_id)
       ) STRICT`,
      `CREATE TABLE transitions (
         transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
         incident_id INTEGER NOT NULL,
         from_state TEXT,
         to_state TEXT NOT NULL,
         actor_type TEXT NOT NULL CHECK (actor_type IN ('evaluator', 'operator', 'override')),
         cause_event_id INTEGER,
         reason_code TEXT NOT NULL,
         created_at TEXT NOT NULL
       ) STRICT`,
      `CREATE INDEX idx_incidents_condition_key
         ON incidents (producer_domain_id, subject, condition_class, condition_state)`,
      `CREATE INDEX idx_incidents_subject ON incidents (subject, condition_state)`,
      `CREATE INDEX idx_transitions_incident ON transitions (incident_id)`,
    ],
  },
];

export const INCIDENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
