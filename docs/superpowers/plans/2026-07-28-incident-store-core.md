# Incident Store Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the dedicated SQLite incident store — immutable event ledger, incident episodes, append-only transitions — with byte-stable idempotent signal acceptance, as Plan 1 of the incident control plane series.

**Architecture:** A new `src/fleet/incidents/` module owned by the fleet controller: `db.ts` opens/creates a private SQLite database fail-closed (corruption never re-initializes state), `envelope.ts` validates the closed metadata-only signal schema, and `store.ts` exposes `IncidentStore` whose `acceptSignal` runs the whole accept path (digest → idempotency → validation → lifecycle → receipt) in one transaction. No HTTP surface, no policy registry, no timers, no delivery — those are Plans 2–5 (see spec section 7).

**Tech Stack:** TypeScript (repo type-stripping conventions, explicit `.ts` import extensions), `node:sqlite` `DatabaseSync` (established repo driver), `zod` (existing dependency) for envelope validation, vitest for tests.

**Spec:** `docs/superpowers/specs/2026-07-28-incident-control-plane-design.md` (sections 1, 2, and the section 3/4 fragments noted per task).

## Global Constraints

- Node pin: `engines` `>=24.0.0 <26`; run tests with `npm test -- <paths>` (vitest; `pretest` runs `strip-types-compat` automatically). If a suite is flaky under the default pool, use the repo stability convention: `npx vitest run --pool=forks <paths>`.
- Imports between repo modules use explicit `.ts` extensions (e.g. `from './schema.ts'`).
- No new npm dependencies. `zod` is already in `dependencies`.
- Private data: database directory mode `0o700`, database file `0o600` (repo convention, see `src/fleet/alert-throttle-store.ts`).
- Fail-closed recovery (spec §4 failure behavior): a non-empty database that fails validation throws; the store NEVER re-initializes an empty schema over existing bytes.
- Privacy (spec §2): envelope attributes are bounded typed scalars only — no nested objects, no free-form long strings.
- Severity is NOT set in this plan. The `severity` column exists but stays NULL until the evaluator plan (Plan 3) introduces policy-driven severity mapping. Producers cannot declare severity (spec §2).
- All timestamps are ISO-8601 UTC strings; "now" is always an explicit `Date` parameter — never `Date.now()` inside store logic (spec §4: evaluation time is an explicit input).
- Commits: conventional style (`feat(incidents): …`, `test(incidents): …`). NEVER add `Co-Authored-By`, model names, or generated-with attribution (machine-global ban; `commit-msg` hook enforces). `git add` explicit paths only — `git add -A` is banned.
- Do NOT push. Pushing is a named hold point requiring owner approval of the target.

---

### Task 1: Schema and fail-closed database open

**Files:**
- Create: `src/fleet/incidents/schema.ts`
- Create: `src/fleet/incidents/db.ts`
- Test: `tests/fleet/incidents/incident-db.test.ts`

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces:
  - `schema.ts`: `export const INCIDENT_SCHEMA_VERSION = 1` and `export const SCHEMA_STATEMENTS: readonly string[]` (DDL).
  - `db.ts`: `export class IncidentStoreCorruptError extends Error { readonly reason: string }`;
    `export function openIncidentDb(dbPath: string): DatabaseSync` — creates parent dir `0o700`, opens the DB, enables WAL + foreign keys, creates schema v1 on a fresh/empty file, validates `meta.schema_version` on an existing file, chmods the file `0o600`, and throws `IncidentStoreCorruptError` (message includes `state_recovery_required`) on corruption or unknown schema version.
  - `export function defaultIncidentDbPath(): string` — `join(xdgDir('XDG_DATA_HOME', '.local/share'), 'whatsoup', 'fleet', 'incidents.db')` using `xdgDir` from `src/fleet/paths.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/fleet/incidents/incident-db.test.ts
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openIncidentDb, IncidentStoreCorruptError } from '../../../src/fleet/incidents/db.ts';
import { INCIDENT_SCHEMA_VERSION } from '../../../src/fleet/incidents/schema.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whatsoup-incident-db-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function dbPath(): string {
  return join(dir, 'fleet', 'incidents.db');
}

describe('openIncidentDb', () => {
  it('creates a fresh database with schema v1 and private modes', () => {
    const db = openIncidentDb(dbPath());
    const version = db
      .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
      .get() as { value: string };
    expect(version.value).toBe(String(INCIDENT_SCHEMA_VERSION));

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('events');
    expect(names).toContain('incidents');
    expect(names).toContain('transitions');

    expect(statSync(dbPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'fleet')).mode & 0o777).toBe(0o700);
    db.close();
  });

  it('reopens an existing database without touching stored rows', () => {
    const db1 = openIncidentDb(dbPath());
    db1.prepare(`INSERT INTO meta (key, value) VALUES ('canary', 'kept')`).run();
    db1.close();

    const db2 = openIncidentDb(dbPath());
    const row = db2
      .prepare(`SELECT value FROM meta WHERE key = 'canary'`)
      .get() as { value: string };
    expect(row.value).toBe('kept');
    db2.close();
  });

  it('fails closed on a corrupt non-empty file instead of re-initializing', () => {
    const db = openIncidentDb(dbPath());
    db.close();
    writeFileSync(dbPath(), 'not a sqlite database, definitely corrupt bytes');

    expect(() => openIncidentDb(dbPath())).toThrow(IncidentStoreCorruptError);
    expect(() => openIncidentDb(dbPath())).toThrow(/state_recovery_required/);
  });

  it('fails closed on an unknown schema version', () => {
    const db = openIncidentDb(dbPath());
    db.prepare(`UPDATE meta SET value = '999' WHERE key = 'schema_version'`).run();
    db.close();

    expect(() => openIncidentDb(dbPath())).toThrow(IncidentStoreCorruptError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/fleet/incidents/incident-db.test.ts`
Expected: FAIL — cannot resolve `../../../src/fleet/incidents/db.ts`.

- [ ] **Step 3: Write the schema module**

```ts
// src/fleet/incidents/schema.ts
export const INCIDENT_SCHEMA_VERSION = 1;

export const SCHEMA_STATEMENTS: readonly string[] = [
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
     disposition TEXT NOT NULL,
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
];
```

- [ ] **Step 4: Write the db module**

```ts
// src/fleet/incidents/db.ts
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { xdgDir } from '../paths.ts';
import { INCIDENT_SCHEMA_VERSION, SCHEMA_STATEMENTS } from './schema.ts';

export class IncidentStoreCorruptError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`incident store state_recovery_required: ${reason}`);
    this.name = 'IncidentStoreCorruptError';
    this.reason = reason;
  }
}

export function defaultIncidentDbPath(): string {
  return join(xdgDir('XDG_DATA_HOME', '.local/share'), 'whatsoup', 'fleet', 'incidents.db');
}

function isFreshTarget(dbPath: string): boolean {
  if (!existsSync(dbPath)) return true;
  return statSync(dbPath).size === 0;
}

function initializeSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(
      String(INCIDENT_SCHEMA_VERSION),
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function validateExisting(db: DatabaseSync): void {
  let versionRow: unknown;
  try {
    const check = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    if (!check || check.quick_check !== 'ok') {
      throw new IncidentStoreCorruptError('quick_check failed');
    }
    versionRow = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  } catch (err) {
    if (err instanceof IncidentStoreCorruptError) throw err;
    throw new IncidentStoreCorruptError('database unreadable');
  }
  const value =
    versionRow && typeof (versionRow as { value?: unknown }).value === 'string'
      ? (versionRow as { value: string }).value
      : null;
  if (value !== String(INCIDENT_SCHEMA_VERSION)) {
    throw new IncidentStoreCorruptError(`unsupported schema_version ${value ?? 'missing'}`);
  }
}

export function openIncidentDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const fresh = isFreshTarget(dbPath);

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch {
    throw new IncidentStoreCorruptError('failed to open database file');
  }

  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    if (fresh) {
      initializeSchema(db);
    } else {
      validateExisting(db);
    }
  } catch (err) {
    db.close();
    throw err instanceof IncidentStoreCorruptError
      ? err
      : new IncidentStoreCorruptError('database unreadable');
  }

  chmodSync(dbPath, 0o600);
  return db;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/fleet/incidents/incident-db.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/fleet/incidents/schema.ts src/fleet/incidents/db.ts tests/fleet/incidents/incident-db.test.ts
git commit -m "feat(incidents): add fail-closed incident store database and schema v1"
```

---

### Task 2: Closed envelope validation

**Files:**
- Create: `src/fleet/incidents/envelope.ts`
- Test: `tests/fleet/incidents/envelope.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `export const SIGNAL_KINDS = ['condition_observed', 'condition_recovered', 'heartbeat_observed', 'notice_recorded'] as const`
  - `export type SignalKind = (typeof SIGNAL_KINDS)[number]`
  - `export interface SignalEnvelope { schemaVersion: 1; signalId: string; kind: SignalKind; subject: string; conditionClass?: string; occurrenceId?: string; occurrenceSeq?: number; observedAt: string; attributes?: Record<string, string | number | boolean>; recoveryProofClass?: string }`
  - `export type EnvelopeResult = { ok: true; envelope: SignalEnvelope } | { ok: false; errors: string[] }`
  - `export function parseSignalEnvelope(rawJsonText: string): EnvelopeResult`

- [ ] **Step 1: Write the failing test**

```ts
// tests/fleet/incidents/envelope.test.ts
import { describe, expect, it } from 'vitest';
import { parseSignalEnvelope } from '../../../src/fleet/incidents/envelope.ts';

function base(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    signalId: 'sig-001',
    kind: 'condition_observed',
    subject: 'host:alpha',
    conditionClass: 'selfcheck_drift',
    occurrenceId: 'occ-001',
    occurrenceSeq: 1,
    observedAt: '2026-07-28T12:00:00.000Z',
    ...overrides,
  });
}

describe('parseSignalEnvelope', () => {
  it('accepts a well-formed condition_observed envelope', () => {
    const result = parseSignalEnvelope(base());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.kind).toBe('condition_observed');
      expect(result.envelope.occurrenceId).toBe('occ-001');
    }
  });

  it('rejects unknown top-level keys (closed schema)', () => {
    const result = parseSignalEnvelope(base({ freeFormEvidence: 'stack trace here' }));
    expect(result.ok).toBe(false);
  });

  it('rejects condition kinds without occurrence identity', () => {
    const result = parseSignalEnvelope(
      base({ occurrenceId: undefined, occurrenceSeq: undefined }),
    );
    expect(result.ok).toBe(false);
  });

  it('accepts heartbeat_observed without occurrence fields', () => {
    const result = parseSignalEnvelope(
      JSON.stringify({
        schemaVersion: 1,
        signalId: 'hb-001',
        kind: 'heartbeat_observed',
        subject: 'host:alpha',
        observedAt: '2026-07-28T12:00:00.000Z',
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects malformed observedAt timestamps', () => {
    const result = parseSignalEnvelope(base({ observedAt: 'yesterday-ish' }));
    expect(result.ok).toBe(false);
  });

  it('rejects nested objects in attributes', () => {
    const result = parseSignalEnvelope(base({ attributes: { nested: { deep: true } } }));
    expect(result.ok).toBe(false);
  });

  it('rejects oversized attribute values and oversized key counts', () => {
    const big = 'x'.repeat(300);
    expect(parseSignalEnvelope(base({ attributes: { note: big } })).ok).toBe(false);

    const many: Record<string, number> = {};
    for (let i = 0; i < 20; i += 1) many[`k${i}`] = i;
    expect(parseSignalEnvelope(base({ attributes: many })).ok).toBe(false);
  });

  it('rejects non-JSON input without throwing', () => {
    const result = parseSignalEnvelope('{not json');
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/fleet/incidents/envelope.test.ts`
Expected: FAIL — cannot resolve `envelope.ts`.

- [ ] **Step 3: Write the envelope module**

```ts
// src/fleet/incidents/envelope.ts
import { z } from 'zod';

export const SIGNAL_KINDS = [
  'condition_observed',
  'condition_recovered',
  'heartbeat_observed',
  'notice_recorded',
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

const MAX_ATTRIBUTE_KEYS = 16;
const MAX_ATTRIBUTE_KEY_LENGTH = 64;
const MAX_ATTRIBUTE_STRING_LENGTH = 256;
const MAX_ID_LENGTH = 128;

const boundedId = z.string().min(1).max(MAX_ID_LENGTH);

const isoUtcTimestamp = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), 'observedAt must be an ISO-8601 timestamp');

const attributeValue = z.union([
  z.string().max(MAX_ATTRIBUTE_STRING_LENGTH),
  z.number().finite(),
  z.boolean(),
]);

const attributes = z
  .record(z.string().min(1).max(MAX_ATTRIBUTE_KEY_LENGTH), attributeValue)
  .refine(
    (record) => Object.keys(record).length <= MAX_ATTRIBUTE_KEYS,
    `attributes may not exceed ${MAX_ATTRIBUTE_KEYS} keys`,
  );

const envelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    signalId: boundedId,
    kind: z.enum(SIGNAL_KINDS),
    subject: boundedId,
    conditionClass: boundedId.optional(),
    occurrenceId: boundedId.optional(),
    occurrenceSeq: z.number().int().nonnegative().optional(),
    observedAt: isoUtcTimestamp,
    attributes: attributes.optional(),
    recoveryProofClass: boundedId.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const isConditionKind =
      value.kind === 'condition_observed' || value.kind === 'condition_recovered';
    if (isConditionKind) {
      if (!value.conditionClass) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'conditionClass required for condition kinds' });
      }
      if (!value.occurrenceId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'occurrenceId required for condition kinds' });
      }
      if (value.occurrenceSeq === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'occurrenceSeq required for condition kinds' });
      }
    }
  });

export interface SignalEnvelope {
  schemaVersion: 1;
  signalId: string;
  kind: SignalKind;
  subject: string;
  conditionClass?: string;
  occurrenceId?: string;
  occurrenceSeq?: number;
  observedAt: string;
  attributes?: Record<string, string | number | boolean>;
  recoveryProofClass?: string;
}

export type EnvelopeResult =
  | { ok: true; envelope: SignalEnvelope }
  | { ok: false; errors: string[] };

export function parseSignalEnvelope(rawJsonText: string): EnvelopeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJsonText);
  } catch {
    return { ok: false, errors: ['body is not valid JSON'] };
  }

  const result = envelopeSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`),
    };
  }
  return { ok: true, envelope: result.data };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/fleet/incidents/envelope.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/fleet/incidents/envelope.ts tests/fleet/incidents/envelope.test.ts
git commit -m "feat(incidents): add closed metadata-only signal envelope validation"
```

---

### Task 3: acceptSignal — digest, idempotent replay, conflict, state-inert kinds

**Files:**
- Create: `src/fleet/incidents/store.ts`
- Test: `tests/fleet/incidents/store-accept.test.ts`

**Interfaces:**
- Consumes: `openIncidentDb`/`IncidentStoreCorruptError` (Task 1), `parseSignalEnvelope`/`SignalEnvelope` (Task 2).
- Produces (used by Tasks 4–8 and by Plan 2's HTTP surface):
  - `export interface ProducerContext { producerId: string; producerDomainId: string }`
  - `export type Disposition = 'incident_opened' | 'incident_updated' | 'incident_resolved' | 'heartbeat_recorded' | 'notice_recorded' | 'stored_no_state_change' | 'stored_stale_observation' | 'stored_quarantined_observation'`
  - `export interface SignalReceipt { schemaVersion: 1; eventId: number; producerId: string; signalId: string; payloadDigest: string; receivedAt: string; disposition: Disposition; incidentId: number | null; transitionId: number | null }`
  - `export type AcceptResult = { outcome: 'accepted'; receipt: SignalReceipt } | { outcome: 'idempotent_replay'; receipt: SignalReceipt } | { outcome: 'identity_conflict'; existingDigest: string } | { outcome: 'invalid'; errors: string[] }`
  - `export class IncidentStore { constructor(db: DatabaseSync, options?: { maxFutureSkewMs?: number }); acceptSignal(rawBody: string, producer: ProducerContext, now: Date): AcceptResult; close(): void }`
  - Digest format: `sha256:<hex>` over the exact UTF-8 bytes of `rawBody`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/fleet/incidents/store-accept.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openIncidentDb } from '../../../src/fleet/incidents/db.ts';
import { IncidentStore } from '../../../src/fleet/incidents/store.ts';

let dir: string;
let store: IncidentStore;

const PRODUCER = { producerId: 'prod-selfcheck-alpha', producerDomainId: 'dom-selfcheck' };
const NOW = new Date('2026-07-28T12:00:05.000Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whatsoup-incident-store-'));
  store = new IncidentStore(openIncidentDb(join(dir, 'incidents.db')));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function heartbeatBody(signalId = 'hb-001'): string {
  return JSON.stringify({
    schemaVersion: 1,
    signalId,
    kind: 'heartbeat_observed',
    subject: 'host:alpha',
    observedAt: '2026-07-28T12:00:00.000Z',
  });
}

describe('IncidentStore.acceptSignal — acceptance core', () => {
  it('accepts a heartbeat with a durable receipt and sha256 digest', () => {
    const result = store.acceptSignal(heartbeatBody(), PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt.disposition).toBe('heartbeat_recorded');
    expect(result.receipt.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.receipt.incidentId).toBeNull();
    expect(result.receipt.receivedAt).toBe(NOW.toISOString());
  });

  it('returns the original receipt on exact byte replay without new events', () => {
    const body = heartbeatBody();
    const first = store.acceptSignal(body, PRODUCER, NOW);
    const replay = store.acceptSignal(body, PRODUCER, new Date('2026-07-28T12:10:00.000Z'));

    expect(replay.outcome).toBe('idempotent_replay');
    if (first.outcome !== 'accepted' || replay.outcome !== 'idempotent_replay') return;
    expect(replay.receipt).toEqual(first.receipt);
  });

  it('rejects the same signal identity with different bytes as a conflict', () => {
    store.acceptSignal(heartbeatBody(), PRODUCER, NOW);
    const conflicting = JSON.stringify({
      schemaVersion: 1,
      signalId: 'hb-001',
      kind: 'heartbeat_observed',
      subject: 'host:alpha',
      observedAt: '2026-07-28T12:00:01.000Z',
    });
    const result = store.acceptSignal(conflicting, PRODUCER, NOW);
    expect(result.outcome).toBe('identity_conflict');
  });

  it('scopes identity per producer: same signalId from another producer is accepted', () => {
    store.acceptSignal(heartbeatBody(), PRODUCER, NOW);
    const other = { producerId: 'prod-selfcheck-beta', producerDomainId: 'dom-selfcheck' };
    const result = store.acceptSignal(heartbeatBody(), other, NOW);
    expect(result.outcome).toBe('accepted');
  });

  it('returns invalid (not a throw, no stored event) for schema violations', () => {
    const result = store.acceptSignal('{"nope": true}', PRODUCER, NOW);
    expect(result.outcome).toBe('invalid');
    const replay = store.acceptSignal(heartbeatBody(), PRODUCER, NOW);
    expect(replay.outcome).toBe('accepted');
  });

  it('records notice_recorded without opening an incident', () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      signalId: 'note-001',
      kind: 'notice_recorded',
      subject: 'host:alpha',
      observedAt: '2026-07-28T12:00:00.000Z',
      attributes: { outcomeClass: 'session_terminal' },
    });
    const result = store.acceptSignal(body, PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt.disposition).toBe('notice_recorded');
    expect(result.receipt.incidentId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/fleet/incidents/store-accept.test.ts`
Expected: FAIL — cannot resolve `store.ts`.

- [ ] **Step 3: Write the store acceptance core**

```ts
// src/fleet/incidents/store.ts
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { parseSignalEnvelope, type SignalEnvelope } from './envelope.ts';

export interface ProducerContext {
  producerId: string;
  producerDomainId: string;
}

export type Disposition =
  | 'incident_opened'
  | 'incident_updated'
  | 'incident_resolved'
  | 'heartbeat_recorded'
  | 'notice_recorded'
  | 'stored_no_state_change'
  | 'stored_stale_observation'
  | 'stored_quarantined_observation';

export interface SignalReceipt {
  schemaVersion: 1;
  eventId: number;
  producerId: string;
  signalId: string;
  payloadDigest: string;
  receivedAt: string;
  disposition: Disposition;
  incidentId: number | null;
  transitionId: number | null;
}

export type AcceptResult =
  | { outcome: 'accepted'; receipt: SignalReceipt }
  | { outcome: 'idempotent_replay'; receipt: SignalReceipt }
  | { outcome: 'identity_conflict'; existingDigest: string }
  | { outcome: 'invalid'; errors: string[] };

const DEFAULT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

interface StoredEventRow {
  event_id: number;
  payload_digest: string;
  received_at: string;
  disposition: string;
  incident_id: number | null;
  transition_id: number | null;
}

interface LifecycleEffect {
  disposition: Disposition;
  incidentId: number | null;
  transitionId: number | null;
}

export class IncidentStore {
  private readonly db: DatabaseSync;
  private readonly maxFutureSkewMs: number;

  constructor(db: DatabaseSync, options?: { maxFutureSkewMs?: number }) {
    this.db = db;
    this.maxFutureSkewMs = options?.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS;
  }

  close(): void {
    this.db.close();
  }

  acceptSignal(rawBody: string, producer: ProducerContext, now: Date): AcceptResult {
    const payloadDigest = `sha256:${createHash('sha256').update(rawBody, 'utf-8').digest('hex')}`;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db
        .prepare(
          `SELECT event_id, payload_digest, received_at, disposition, incident_id, transition_id
             FROM events WHERE producer_id = ? AND signal_id IS NOT NULL AND signal_id = ?`,
        )
        .get(producer.producerId, extractSignalId(rawBody) ?? '') as StoredEventRow | undefined;

      if (existing) {
        this.db.exec('ROLLBACK');
        if (existing.payload_digest === payloadDigest) {
          return {
            outcome: 'idempotent_replay',
            receipt: this.receiptFromRow(existing, producer, rawBody),
          };
        }
        return { outcome: 'identity_conflict', existingDigest: existing.payload_digest };
      }

      const parsed = parseSignalEnvelope(rawBody);
      if (!parsed.ok) {
        this.db.exec('ROLLBACK');
        return { outcome: 'invalid', errors: parsed.errors };
      }
      const envelope = parsed.envelope;

      const receivedAt = now.toISOString();
      const quarantined =
        Date.parse(envelope.observedAt) > now.getTime() + this.maxFutureSkewMs;

      const inserted = this.db
        .prepare(
          `INSERT INTO events (
             producer_id, producer_domain_id, signal_id, payload_digest, payload_json,
             kind, subject, condition_class, occurrence_id, occurrence_seq,
             observed_at, received_at, disposition)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored_no_state_change')`,
        )
        .run(
          producer.producerId,
          producer.producerDomainId,
          envelope.signalId,
          payloadDigest,
          rawBody,
          envelope.kind,
          envelope.subject,
          envelope.conditionClass ?? null,
          envelope.occurrenceId ?? null,
          envelope.occurrenceSeq ?? null,
          envelope.observedAt,
          receivedAt,
        );
      const eventId = Number(inserted.lastInsertRowid);

      const effect: LifecycleEffect = quarantined
        ? { disposition: 'stored_quarantined_observation', incidentId: null, transitionId: null }
        : this.applyLifecycle(envelope, producer, eventId, receivedAt);

      this.db
        .prepare(
          `UPDATE events SET disposition = ?, incident_id = ?, transition_id = ?
             WHERE event_id = ?`,
        )
        .run(effect.disposition, effect.incidentId, effect.transitionId, eventId);

      this.db.exec('COMMIT');
      return {
        outcome: 'accepted',
        receipt: {
          schemaVersion: 1,
          eventId,
          producerId: producer.producerId,
          signalId: envelope.signalId,
          payloadDigest,
          receivedAt,
          disposition: effect.disposition,
          incidentId: effect.incidentId,
          transitionId: effect.transitionId,
        },
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private receiptFromRow(
    row: StoredEventRow,
    producer: ProducerContext,
    rawBody: string,
  ): SignalReceipt {
    return {
      schemaVersion: 1,
      eventId: row.event_id,
      producerId: producer.producerId,
      signalId: extractSignalId(rawBody) ?? '',
      payloadDigest: row.payload_digest,
      receivedAt: row.received_at,
      disposition: row.disposition as Disposition,
      incidentId: row.incident_id,
      transitionId: row.transition_id,
    };
  }

  private applyLifecycle(
    envelope: SignalEnvelope,
    producer: ProducerContext,
    eventId: number,
    receivedAt: string,
  ): LifecycleEffect {
    switch (envelope.kind) {
      case 'heartbeat_observed':
        return { disposition: 'heartbeat_recorded', incidentId: null, transitionId: null };
      case 'notice_recorded':
        return { disposition: 'notice_recorded', incidentId: null, transitionId: null };
      case 'condition_observed':
      case 'condition_recovered':
        // Episode lifecycle lands in Tasks 4-6.
        return { disposition: 'stored_no_state_change', incidentId: null, transitionId: null };
    }
  }
}

function extractSignalId(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const candidate = (parsed as { signalId?: unknown }).signalId;
      if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
  } catch {
    // invalid JSON has no identity; validation reports it
  }
  return null;
}
```

Note: the idempotency lookup uses `extractSignalId` on the raw bytes so replay detection precedes full validation, while non-JSON bodies fall through to the validator's `invalid` result.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/fleet/incidents/store-accept.test.ts`
Expected: PASS (6 tests). Also re-run Tasks 1–2 suites: `npm test -- tests/fleet/incidents` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/fleet/incidents/store.ts tests/fleet/incidents/store-accept.test.ts
git commit -m "feat(incidents): add byte-stable idempotent signal acceptance core"
```

---

### Task 4: condition_observed — open, update, stale sequence

**Files:**
- Modify: `src/fleet/incidents/store.ts` (replace the `condition_observed` branch of `applyLifecycle`)
- Test: `tests/fleet/incidents/store-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 3's `IncidentStore` internals.
- Produces: dispositions `incident_opened` / `incident_updated` / `stored_stale_observation` for `condition_observed`; `transitions` rows with `actor_type = 'evaluator'`, `reason_code = 'condition_observed'`; incidents rows keyed by `(producer_domain_id, subject, condition_class, occurrence_id)` with `projection_version` starting at 1.

- [ ] **Step 1: Write the failing test**

```ts
// tests/fleet/incidents/store-lifecycle.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openIncidentDb } from '../../../src/fleet/incidents/db.ts';
import { IncidentStore } from '../../../src/fleet/incidents/store.ts';

let dir: string;
let store: IncidentStore;

const PRODUCER = { producerId: 'prod-selfcheck-alpha', producerDomainId: 'dom-selfcheck' };
const NOW = new Date('2026-07-28T12:00:05.000Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whatsoup-incident-lifecycle-'));
  store = new IncidentStore(openIncidentDb(join(dir, 'incidents.db')));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function observed(signalId: string, occurrenceId: string, occurrenceSeq: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    signalId,
    kind: 'condition_observed',
    subject: 'host:alpha',
    conditionClass: 'selfcheck_drift',
    occurrenceId,
    occurrenceSeq,
    observedAt: '2026-07-28T12:00:00.000Z',
  });
}

describe('condition_observed lifecycle', () => {
  it('opens an incident with an open transition on first observation', () => {
    const result = store.acceptSignal(observed('sig-1', 'occ-1', 1), PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt.disposition).toBe('incident_opened');
    expect(result.receipt.incidentId).not.toBeNull();
    expect(result.receipt.transitionId).not.toBeNull();
  });

  it('updates the open episode on a newer observation of the same occurrence', () => {
    store.acceptSignal(observed('sig-1', 'occ-1', 1), PRODUCER, NOW);
    const result = store.acceptSignal(observed('sig-2', 'occ-1', 2), PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt.disposition).toBe('incident_updated');
  });

  it('stores an out-of-order (stale seq) observation without advancing state', () => {
    store.acceptSignal(observed('sig-1', 'occ-1', 5), PRODUCER, NOW);
    const result = store.acceptSignal(observed('sig-late', 'occ-1', 3), PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt.disposition).toBe('stored_stale_observation');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/fleet/incidents/store-lifecycle.test.ts`
Expected: FAIL — dispositions come back `stored_no_state_change`.

- [ ] **Step 3: Implement the condition_observed branch**

Replace the `condition_observed` case in `applyLifecycle` with a call to this new private method:

```ts
  private applyConditionObserved(
    envelope: SignalEnvelope,
    producer: ProducerContext,
    eventId: number,
    receivedAt: string,
  ): LifecycleEffect {
    const conditionClass = envelope.conditionClass as string;
    const occurrenceId = envelope.occurrenceId as string;
    const occurrenceSeq = envelope.occurrenceSeq as number;

    const episode = this.db
      .prepare(
        `SELECT incident_id, condition_state, last_occurrence_seq, projection_version
           FROM incidents
          WHERE producer_domain_id = ? AND subject = ? AND condition_class = ? AND occurrence_id = ?`,
      )
      .get(producer.producerDomainId, envelope.subject, conditionClass, occurrenceId) as
      | { incident_id: number; condition_state: string; last_occurrence_seq: number; projection_version: number }
      | undefined;

    if (episode) {
      if (episode.condition_state !== 'open' || occurrenceSeq <= episode.last_occurrence_seq) {
        return { disposition: 'stored_stale_observation', incidentId: episode.incident_id, transitionId: null };
      }
      this.db
        .prepare(
          `UPDATE incidents
              SET last_observed_at = ?, last_occurrence_seq = ?, projection_version = projection_version + 1
            WHERE incident_id = ?`,
        )
        .run(envelope.observedAt, occurrenceSeq, episode.incident_id);
      return { disposition: 'incident_updated', incidentId: episode.incident_id, transitionId: null };
    }

    const openedIncident = this.db
      .prepare(
        `INSERT INTO incidents (
           producer_domain_id, subject, condition_class, occurrence_id,
           condition_state, severity, opened_event_id, last_observed_at,
           last_occurrence_seq, projection_version)
         VALUES (?, ?, ?, ?, 'open', NULL, ?, ?, ?, 1)`,
      )
      .run(
        producer.producerDomainId,
        envelope.subject,
        conditionClass,
        occurrenceId,
        eventId,
        envelope.observedAt,
        occurrenceSeq,
      );
    const incidentId = Number(openedIncident.lastInsertRowid);

    const transition = this.db
      .prepare(
        `INSERT INTO transitions (
           incident_id, from_state, to_state, actor_type, cause_event_id, reason_code, created_at)
         VALUES (?, NULL, 'open', 'evaluator', ?, 'condition_observed', ?)`,
      )
      .run(incidentId, eventId, receivedAt);

    return {
      disposition: 'incident_opened',
      incidentId,
      transitionId: Number(transition.lastInsertRowid),
    };
  }
```

And in `applyLifecycle`:

```ts
      case 'condition_observed':
        return this.applyConditionObserved(envelope, producer, eventId, receivedAt);
      case 'condition_recovered':
        // Lands in Task 6.
        return { disposition: 'stored_no_state_change', incidentId: null, transitionId: null };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/fleet/incidents/store-lifecycle.test.ts tests/fleet/incidents/store-accept.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/fleet/incidents/store.ts tests/fleet/incidents/store-lifecycle.test.ts
git commit -m "feat(incidents): open and update condition episodes from observations"
```

---

### Task 5: Supersession — newer occurrence closes the prior open episode

**Files:**
- Modify: `src/fleet/incidents/store.ts` (extend `applyConditionObserved`)
- Test: append to `tests/fleet/incidents/store-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 4's `applyConditionObserved`.
- Produces: a `condition_observed` with a NEW `occurrenceId` on a condition key that already has a different open episode transitions that prior episode `open → superseded` (`actor_type = 'evaluator'`, `reason_code = 'newer_occurrence'`) and opens the new episode; receipt disposition is `incident_opened` referencing the new episode.

- [ ] **Step 1: Write the failing test** (append to the `describe` block)

```ts
  it('supersedes the prior open episode when a newer occurrence opens', () => {
    const first = store.acceptSignal(observed('sig-1', 'occ-1', 1), PRODUCER, NOW);
    const second = store.acceptSignal(observed('sig-9', 'occ-2', 1), PRODUCER, NOW);
    expect(second.outcome).toBe('accepted');
    if (first.outcome !== 'accepted' || second.outcome !== 'accepted') return;

    expect(second.receipt.disposition).toBe('incident_opened');
    expect(second.receipt.incidentId).not.toBe(first.receipt.incidentId);

    const prior = store.getIncident(first.receipt.incidentId as number);
    expect(prior?.conditionState).toBe('superseded');
    const priorTransitions = store.listTransitions(first.receipt.incidentId as number);
    expect(priorTransitions.map((t) => t.toState)).toEqual(['open', 'superseded']);
    expect(priorTransitions[1]?.reasonCode).toBe('newer_occurrence');
  });
```

This test also forces minimal read methods; declare them now with exact shapes (full query surface arrives in Task 8):

- `getIncident(incidentId: number): IncidentProjection | null` where `IncidentProjection = { incidentId: number; producerDomainId: string; subject: string; conditionClass: string; occurrenceId: string; conditionState: 'open' | 'resolved' | 'superseded' | 'orphaned' | 'closed_by_override'; severity: string | null; openedEventId: number; lastObservedAt: string; lastOccurrenceSeq: number; projectionVersion: number }`
- `listTransitions(incidentId: number): TransitionRecord[]` where `TransitionRecord = { transitionId: number; incidentId: number; fromState: string | null; toState: string; actorType: 'evaluator' | 'operator' | 'override'; causeEventId: number | null; reasonCode: string; createdAt: string }`

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/fleet/incidents/store-lifecycle.test.ts`
Expected: FAIL — `getIncident` is not a function.

- [ ] **Step 3: Implement supersession and the two read methods**

In `applyConditionObserved`, before inserting a new episode, supersede any other open episode on the same condition key:

```ts
    const openOnKey = this.db
      .prepare(
        `SELECT incident_id FROM incidents
          WHERE producer_domain_id = ? AND subject = ? AND condition_class = ?
            AND condition_state = 'open' AND occurrence_id != ?`,
      )
      .all(producer.producerDomainId, envelope.subject, conditionClass, occurrenceId) as Array<{
      incident_id: number;
    }>;

    for (const stale of openOnKey) {
      this.db
        .prepare(
          `UPDATE incidents
              SET condition_state = 'superseded', projection_version = projection_version + 1
            WHERE incident_id = ?`,
        )
        .run(stale.incident_id);
      this.db
        .prepare(
          `INSERT INTO transitions (
             incident_id, from_state, to_state, actor_type, cause_event_id, reason_code, created_at)
           VALUES (?, 'open', 'superseded', 'evaluator', ?, 'newer_occurrence', ?)`,
        )
        .run(stale.incident_id, eventId, receivedAt);
    }
```

Add the read methods to `IncidentStore`:

```ts
  getIncident(incidentId: number): IncidentProjection | null {
    const row = this.db
      .prepare(`SELECT * FROM incidents WHERE incident_id = ?`)
      .get(incidentId) as Record<string, unknown> | undefined;
    return row ? projectIncident(row) : null;
  }

  listTransitions(incidentId: number): TransitionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM transitions WHERE incident_id = ? ORDER BY transition_id`)
      .all(incidentId) as Array<Record<string, unknown>>;
    return rows.map(projectTransition);
  }
```

With module-level mappers (exact field shapes from the Interfaces block above):

```ts
export interface IncidentProjection {
  incidentId: number;
  producerDomainId: string;
  subject: string;
  conditionClass: string;
  occurrenceId: string;
  conditionState: 'open' | 'resolved' | 'superseded' | 'orphaned' | 'closed_by_override';
  severity: string | null;
  openedEventId: number;
  lastObservedAt: string;
  lastOccurrenceSeq: number;
  projectionVersion: number;
}

export interface TransitionRecord {
  transitionId: number;
  incidentId: number;
  fromState: string | null;
  toState: string;
  actorType: 'evaluator' | 'operator' | 'override';
  causeEventId: number | null;
  reasonCode: string;
  createdAt: string;
}

function projectIncident(row: Record<string, unknown>): IncidentProjection {
  return {
    incidentId: row.incident_id as number,
    producerDomainId: row.producer_domain_id as string,
    subject: row.subject as string,
    conditionClass: row.condition_class as string,
    occurrenceId: row.occurrence_id as string,
    conditionState: row.condition_state as IncidentProjection['conditionState'],
    severity: (row.severity as string | null) ?? null,
    openedEventId: row.opened_event_id as number,
    lastObservedAt: row.last_observed_at as string,
    lastOccurrenceSeq: row.last_occurrence_seq as number,
    projectionVersion: row.projection_version as number,
  };
}

function projectTransition(row: Record<string, unknown>): TransitionRecord {
  return {
    transitionId: row.transition_id as number,
    incidentId: row.incident_id as number,
    fromState: (row.from_state as string | null) ?? null,
    toState: row.to_state as string,
    actorType: row.actor_type as TransitionRecord['actorType'],
    causeEventId: (row.cause_event_id as number | null) ?? null,
    reasonCode: row.reason_code as string,
    createdAt: row.created_at as string,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/fleet/incidents`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/fleet/incidents/store.ts tests/fleet/incidents/store-lifecycle.test.ts
git commit -m "feat(incidents): supersede prior open episode on newer occurrence"
```

---

### Task 6: condition_recovered — occurrence-bound resolution

**Files:**
- Modify: `src/fleet/incidents/store.ts` (replace the `condition_recovered` branch)
- Test: append to `tests/fleet/incidents/store-lifecycle.test.ts`

**Interfaces:**
- Consumes: Tasks 4–5.
- Produces: `condition_recovered` matching an OPEN episode with the same condition key + `occurrenceId` resolves it (`open → resolved`, `reason_code = 'verified_recovery'`, disposition `incident_resolved`); a recovery with no matching open occurrence yields `stored_no_state_change` and mutates nothing (spec §2: ambiguous/stale/unauthorized recovery stays ledger-only).

- [ ] **Step 1: Write the failing test** (append)

```ts
  function recovered(signalId: string, occurrenceId: string, occurrenceSeq: number): string {
    return JSON.stringify({
      schemaVersion: 1,
      signalId,
      kind: 'condition_recovered',
      subject: 'host:alpha',
      conditionClass: 'selfcheck_drift',
      occurrenceId,
      occurrenceSeq,
      observedAt: '2026-07-28T12:01:00.000Z',
      recoveryProofClass: 'runtime_reverified',
    });
  }

  it('resolves the matching open occurrence with a verified_recovery transition', () => {
    const opened = store.acceptSignal(observed('sig-1', 'occ-1', 1), PRODUCER, NOW);
    const result = store.acceptSignal(recovered('sig-r1', 'occ-1', 2), PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (opened.outcome !== 'accepted' || result.outcome !== 'accepted') return;

    expect(result.receipt.disposition).toBe('incident_resolved');
    expect(result.receipt.incidentId).toBe(opened.receipt.incidentId);
    const projection = store.getIncident(opened.receipt.incidentId as number);
    expect(projection?.conditionState).toBe('resolved');
    const transitions = store.listTransitions(opened.receipt.incidentId as number);
    expect(transitions.at(-1)?.reasonCode).toBe('verified_recovery');
  });

  it('stores an unmatched recovery without altering any state', () => {
    const result = store.acceptSignal(recovered('sig-r2', 'occ-unknown', 1), PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt.disposition).toBe('stored_no_state_change');
    expect(result.receipt.incidentId).toBeNull();
  });

  it('does not re-resolve or reopen an already-resolved occurrence', () => {
    store.acceptSignal(observed('sig-1', 'occ-1', 1), PRODUCER, NOW);
    store.acceptSignal(recovered('sig-r1', 'occ-1', 2), PRODUCER, NOW);
    const late = store.acceptSignal(recovered('sig-r3', 'occ-1', 3), PRODUCER, NOW);
    expect(late.outcome).toBe('accepted');
    if (late.outcome !== 'accepted') return;
    expect(late.receipt.disposition).toBe('stored_no_state_change');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/fleet/incidents/store-lifecycle.test.ts`
Expected: FAIL — recovery comes back `stored_no_state_change` with a resolved expectation, and the first new test fails on disposition.

- [ ] **Step 3: Implement the condition_recovered branch**

```ts
  private applyConditionRecovered(
    envelope: SignalEnvelope,
    producer: ProducerContext,
    eventId: number,
    receivedAt: string,
  ): LifecycleEffect {
    const episode = this.db
      .prepare(
        `SELECT incident_id, condition_state FROM incidents
          WHERE producer_domain_id = ? AND subject = ? AND condition_class = ? AND occurrence_id = ?`,
      )
      .get(
        producer.producerDomainId,
        envelope.subject,
        envelope.conditionClass as string,
        envelope.occurrenceId as string,
      ) as { incident_id: number; condition_state: string } | undefined;

    if (!episode || episode.condition_state !== 'open') {
      return { disposition: 'stored_no_state_change', incidentId: null, transitionId: null };
    }

    this.db
      .prepare(
        `UPDATE incidents
            SET condition_state = 'resolved', projection_version = projection_version + 1
          WHERE incident_id = ?`,
      )
      .run(episode.incident_id);
    const transition = this.db
      .prepare(
        `INSERT INTO transitions (
           incident_id, from_state, to_state, actor_type, cause_event_id, reason_code, created_at)
         VALUES (?, 'open', 'resolved', 'evaluator', ?, 'verified_recovery', ?)`,
      )
      .run(episode.incident_id, eventId, receivedAt);

    return {
      disposition: 'incident_resolved',
      incidentId: episode.incident_id,
      transitionId: Number(transition.lastInsertRowid),
    };
  }
```

Wire it in `applyLifecycle`: `case 'condition_recovered': return this.applyConditionRecovered(envelope, producer, eventId, receivedAt);`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/fleet/incidents`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/fleet/incidents/store.ts tests/fleet/incidents/store-lifecycle.test.ts
git commit -m "feat(incidents): resolve episodes on occurrence-bound verified recovery"
```

---

### Task 7: Future-skew quarantine is state-inert across all kinds

**Files:**
- Modify: `src/fleet/incidents/store.ts` (only if the test reveals a gap — the quarantine gate landed in Task 3)
- Test: append to `tests/fleet/incidents/store-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 3's quarantine gate (`maxFutureSkewMs`, default 300000).
- Produces: verified behavior — a well-formed signal observed beyond `now + maxFutureSkewMs` is stored with `stored_quarantined_observation` and produces zero incidents/transitions, for condition and heartbeat kinds alike (spec §2 clock policy; §3 amendment 1).

- [ ] **Step 1: Write the failing/confirming test** (append)

```ts
  it('quarantines future-skewed condition observations without lifecycle effects', () => {
    const future = JSON.stringify({
      schemaVersion: 1,
      signalId: 'sig-future',
      kind: 'condition_observed',
      subject: 'host:alpha',
      conditionClass: 'selfcheck_drift',
      occurrenceId: 'occ-f',
      occurrenceSeq: 1,
      observedAt: '2026-07-28T13:00:00.000Z', // ~1h ahead of NOW
    });
    const result = store.acceptSignal(future, PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt.disposition).toBe('stored_quarantined_observation');
    expect(result.receipt.incidentId).toBeNull();
    expect(result.receipt.transitionId).toBeNull();
  });

  it('accepts observations within the permitted skew window normally', () => {
    const slightlyAhead = JSON.stringify({
      schemaVersion: 1,
      signalId: 'sig-skew-ok',
      kind: 'heartbeat_observed',
      subject: 'host:alpha',
      observedAt: '2026-07-28T12:02:00.000Z', // < 5 min ahead of NOW
    });
    const result = store.acceptSignal(slightlyAhead, PRODUCER, NOW);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.receipt.disposition).toBe('heartbeat_recorded');
  });

  it('honors a configured maxFutureSkewMs', () => {
    const strictDir = mkdtempSync(join(tmpdir(), 'whatsoup-incident-strict-'));
    const strict = new IncidentStore(openIncidentDb(join(strictDir, 'incidents.db')), {
      maxFutureSkewMs: 0,
    });
    try {
      const result = strict.acceptSignal(
        JSON.stringify({
          schemaVersion: 1,
          signalId: 'hb-strict',
          kind: 'heartbeat_observed',
          subject: 'host:alpha',
          observedAt: '2026-07-28T12:00:06.000Z', // 1s ahead of NOW
        }),
        PRODUCER,
        NOW,
      );
      expect(result.outcome).toBe('accepted');
      if (result.outcome !== 'accepted') return;
      expect(result.receipt.disposition).toBe('stored_quarantined_observation');
    } finally {
      strict.close();
      rmSync(strictDir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run test**

Run: `npm test -- tests/fleet/incidents/store-lifecycle.test.ts`
Expected: PASS if Task 3's gate is correct; if any test fails, fix the gate in `acceptSignal` (the quarantine check must run before `applyLifecycle` and apply to every kind) until all pass.

- [ ] **Step 3: Commit**

```bash
git add tests/fleet/incidents/store-lifecycle.test.ts
git commit -m "test(incidents): prove future-skew quarantine is state-inert for all kinds"
```

---

### Task 8: Read queries, whole-module verification

**Files:**
- Modify: `src/fleet/incidents/store.ts` (add `listIncidents`, `getEvent`)
- Test: `tests/fleet/incidents/store-queries.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces (Plan 4's read API consumes these):
  - `listIncidents(filter?: { subject?: string; conditionState?: IncidentProjection['conditionState']; conditionClass?: string; producerDomainId?: string; afterIncidentId?: number; limit?: number }): IncidentProjection[]` — ordered by `incident_id` ascending, default/max limit 200, exact-match filters only (spec §5 amendment 1: exact `subjectId` filtering).
  - `getEvent(eventId: number): StoredEvent | null` where `StoredEvent = { eventId: number; producerId: string; producerDomainId: string; signalId: string; payloadDigest: string; kind: SignalKind; subject: string; conditionClass: string | null; occurrenceId: string | null; occurrenceSeq: number | null; observedAt: string; receivedAt: string; disposition: Disposition; incidentId: number | null; transitionId: number | null }` (note: `payload_json` is deliberately NOT exposed here; raw payload retrieval is an ingestion-surface decision for Plan 2).

- [ ] **Step 1: Write the failing test**

```ts
// tests/fleet/incidents/store-queries.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openIncidentDb } from '../../../src/fleet/incidents/db.ts';
import { IncidentStore } from '../../../src/fleet/incidents/store.ts';

let dir: string;
let store: IncidentStore;

const PRODUCER = { producerId: 'prod-selfcheck-alpha', producerDomainId: 'dom-selfcheck' };
const NOW = new Date('2026-07-28T12:00:05.000Z');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whatsoup-incident-queries-'));
  store = new IncidentStore(openIncidentDb(join(dir, 'incidents.db')));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function observedOn(subject: string, occurrenceId: string, signalId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    signalId,
    kind: 'condition_observed',
    subject,
    conditionClass: 'selfcheck_drift',
    occurrenceId,
    occurrenceSeq: 1,
    observedAt: '2026-07-28T12:00:00.000Z',
  });
}

describe('incident store read queries', () => {
  it('filters by exact subject', () => {
    store.acceptSignal(observedOn('host:alpha', 'occ-a', 'sig-a'), PRODUCER, NOW);
    store.acceptSignal(observedOn('host:beta', 'occ-b', 'sig-b'), PRODUCER, NOW);

    const results = store.listIncidents({ subject: 'host:alpha' });
    expect(results).toHaveLength(1);
    expect(results[0]?.subject).toBe('host:alpha');
  });

  it('filters by condition state and paginates by afterIncidentId', () => {
    store.acceptSignal(observedOn('host:alpha', 'occ-a', 'sig-a'), PRODUCER, NOW);
    store.acceptSignal(observedOn('host:beta', 'occ-b', 'sig-b'), PRODUCER, NOW);

    const open = store.listIncidents({ conditionState: 'open' });
    expect(open).toHaveLength(2);

    const afterFirst = store.listIncidents({ afterIncidentId: open[0]!.incidentId });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.incidentId).toBe(open[1]!.incidentId);
  });

  it('returns stored events without exposing raw payload bytes', () => {
    const accepted = store.acceptSignal(observedOn('host:alpha', 'occ-a', 'sig-a'), PRODUCER, NOW);
    if (accepted.outcome !== 'accepted') throw new Error('setup failed');

    const event = store.getEvent(accepted.receipt.eventId);
    expect(event?.signalId).toBe('sig-a');
    expect(event?.disposition).toBe('incident_opened');
    expect(event as Record<string, unknown>).not.toHaveProperty('payloadJson');
    expect(event as Record<string, unknown>).not.toHaveProperty('payload_json');
  });

  it('returns null for unknown ids', () => {
    expect(store.getEvent(999)).toBeNull();
    expect(store.getIncident(999)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/fleet/incidents/store-queries.test.ts`
Expected: FAIL — `listIncidents` is not a function.

- [ ] **Step 3: Implement the queries**

```ts
  listIncidents(filter?: {
    subject?: string;
    conditionState?: IncidentProjection['conditionState'];
    conditionClass?: string;
    producerDomainId?: string;
    afterIncidentId?: number;
    limit?: number;
  }): IncidentProjection[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter?.subject) { clauses.push('subject = ?'); params.push(filter.subject); }
    if (filter?.conditionState) { clauses.push('condition_state = ?'); params.push(filter.conditionState); }
    if (filter?.conditionClass) { clauses.push('condition_class = ?'); params.push(filter.conditionClass); }
    if (filter?.producerDomainId) { clauses.push('producer_domain_id = ?'); params.push(filter.producerDomainId); }
    if (filter?.afterIncidentId !== undefined) { clauses.push('incident_id > ?'); params.push(filter.afterIncidentId); }

    const limit = Math.min(Math.max(filter?.limit ?? 200, 1), 200);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM incidents ${where} ORDER BY incident_id LIMIT ?`)
      .all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map(projectIncident);
  }

  getEvent(eventId: number): StoredEvent | null {
    const row = this.db
      .prepare(
        `SELECT event_id, producer_id, producer_domain_id, signal_id, payload_digest,
                kind, subject, condition_class, occurrence_id, occurrence_seq,
                observed_at, received_at, disposition, incident_id, transition_id
           FROM events WHERE event_id = ?`,
      )
      .get(eventId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      eventId: row.event_id as number,
      producerId: row.producer_id as string,
      producerDomainId: row.producer_domain_id as string,
      signalId: row.signal_id as string,
      payloadDigest: row.payload_digest as string,
      kind: row.kind as StoredEvent['kind'],
      subject: row.subject as string,
      conditionClass: (row.condition_class as string | null) ?? null,
      occurrenceId: (row.occurrence_id as string | null) ?? null,
      occurrenceSeq: (row.occurrence_seq as number | null) ?? null,
      observedAt: row.observed_at as string,
      receivedAt: row.received_at as string,
      disposition: row.disposition as Disposition,
      incidentId: (row.incident_id as number | null) ?? null,
      transitionId: (row.transition_id as number | null) ?? null,
    };
  }
```

With the exported type:

```ts
export interface StoredEvent {
  eventId: number;
  producerId: string;
  producerDomainId: string;
  signalId: string;
  payloadDigest: string;
  kind: import('./envelope.ts').SignalKind;
  subject: string;
  conditionClass: string | null;
  occurrenceId: string | null;
  occurrenceSeq: number | null;
  observedAt: string;
  receivedAt: string;
  disposition: Disposition;
  incidentId: number | null;
  transitionId: number | null;
}
```

- [ ] **Step 4: Run the whole module suite and typecheck**

Run: `npm test -- tests/fleet/incidents && npm run typecheck:all`
Expected: all incident tests PASS; typecheck clean for the new module (pre-existing unrelated failures, if any, must be reported — not absorbed).

- [ ] **Step 5: Commit**

```bash
git add src/fleet/incidents/store.ts tests/fleet/incidents/store-queries.test.ts
git commit -m "feat(incidents): add exact-subject incident queries and event reads"
```

---

## Out of scope for this plan (later plans in the series)

- HTTP endpoint, producer auth/enrollment, error taxonomy mapping (Plan 2 — the `AcceptResult` variants map to 201/200/409/422 there).
- Policy registry, severity mapping, retry guard/parking, absence timers, orphaning (Plan 3).
- Operator actions (`closed_by_override` transitions), read API routes, realtime (Plan 4).
- Notification intents/attempts/adapters (Plan 5) — the `transitions` table is their causal anchor.
- Wiring `openIncidentDb(defaultIncidentDbPath())` into the fleet server lifecycle (Plan 2, alongside the route).
