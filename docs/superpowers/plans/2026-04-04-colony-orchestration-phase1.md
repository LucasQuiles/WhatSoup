# Colony Orchestration — Phase 1: Core Loop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the core colony loop: Deacon detects work → spawns Conductor → Conductor dispatches worker → worker completes → Deacon detects completion → spawns Conductor to evaluate. This is the reference slice that proves the protocol works.

**Architecture:** The Deacon daemon (existing, `/home/q/LAB/sdlc-os/colony/deacon.py`) watches tmup SQLite for state changes and spawns ephemeral Conductor sessions (Claude Code CLI, Opus). Workers execute beads in tmux panes via tmup dispatch. A new events database stores the finding store, event log, and state ledger. BRIC integration via `brick_preprocess` on the EVALUATE path provides enrichment.

**Tech Stack:** Python 3.12 (Deacon), TypeScript (tmup, bridge, BRIC), SQLite WAL, tmux, Claude Code CLI, Codex CLI

**Spec:** `docs/superpowers/specs/2026-04-04-colony-orchestration-design.md`

**Repos touched:**
- `/home/q/LAB/sdlc-os/` — Deacon, bridge, conductor prompt, colony schemas
- `/home/q/LAB/tmup/` — tmup v5 migration (findings table), constants
- `/home/q/LAB/brick-lab/` — BRIC hook wiring (Phase 1 uses on-demand only)

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `sdlc-os/colony/events-schema.sql` | Events DB schema: events, findings, state_ledger tables |
| `sdlc-os/colony/events-db.ts` | TypeScript module: open/close events DB, typed queries |
| `sdlc-os/colony/events-db.test.ts` | Tests for events DB operations |
| `sdlc-os/colony/finding-ops.ts` | Finding CRUD: create, promote, suppress, merge, archive |
| `sdlc-os/colony/finding-ops.test.ts` | Tests for finding operations |
| `sdlc-os/colony/state-ledger.ts` | State ledger CRUD: create, update, rehydrate |
| `sdlc-os/colony/state-ledger.test.ts` | Tests for state ledger operations |
| `sdlc-os/colony/conductor-journal.ts` | Journal read/write: structured + narrative anchors |
| `sdlc-os/colony/conductor-journal.test.ts` | Tests for journal operations |
| `sdlc-os/colony/event-types.ts` | Typed event enum + payload schemas |
| `sdlc-os/colony/bootstrap.ts` | Cold-start bootstrap: seed schema + minimal state packet |
| `sdlc-os/colony/bootstrap.test.ts` | Tests for bootstrap sequence |
| `sdlc-os/colony/cost-enforcer.ts` | Cost trip-wires: 80% warning, 100% stop |
| `sdlc-os/colony/cost-enforcer.test.ts` | Tests for cost enforcement |
| `tmup/shared/src/migrations/v5-findings.ts` | tmup migration v5: add findings table to tmup DB |

### Modified files

| File | Change |
|------|--------|
| `sdlc-os/colony/deacon.py` | Add DISCOVER session type, wire cost trip-wires, persist backpressure to events DB |
| `sdlc-os/colony/bridge.ts` | Emit typed events to events DB on bead status change |
| `sdlc-os/colony/conductor-prompt.md` | Add journal read/write protocol, DISCOVER session instructions |
| `tmup/shared/src/migrations.ts` | Register v5 migration |
| `tmup/shared/src/constants.ts` | Add finding types, event types, promotion states |

---

## Task 1: Bootstrap — Events Database Schema + Cold Start

**Files:**
- Create: `sdlc-os/colony/events-schema.sql`
- Create: `sdlc-os/colony/event-types.ts`
- Create: `sdlc-os/colony/events-db.ts`
- Create: `sdlc-os/colony/events-db.test.ts`
- Create: `sdlc-os/colony/bootstrap.ts`
- Create: `sdlc-os/colony/bootstrap.test.ts`

This task addresses **Critical Finding C1** (bootstrap circular dependency) and **C2** (SQLite contention) by creating a separate events.db.

- [ ] **Step 1: Write the events DB schema**

```sql
-- sdlc-os/colony/events-schema.sql
-- Colony events database — separate from tmup.db to avoid write contention (C2)

PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 8000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('schema_version', '1');

-- Typed event log (§11.1)
CREATE TABLE IF NOT EXISTS events (
  event_id         TEXT PRIMARY KEY,
  event_type       TEXT NOT NULL,
  workstream_id    TEXT NOT NULL,
  bead_id          TEXT,
  agent_id         TEXT,
  timestamp        TEXT NOT NULL,
  payload          TEXT NOT NULL,
  processing_level TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_level IN ('pending','logged','condensed','enriched')),
  idempotency_key  TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_events_workstream ON events (workstream_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_processing ON events (processing_level, timestamp);

-- State ledger (§10.2)
CREATE TABLE IF NOT EXISTS state_ledger (
  workstream_id    TEXT PRIMARY KEY,
  repo             TEXT NOT NULL,
  branch           TEXT NOT NULL,
  mission_id       TEXT NOT NULL,
  scope_region     TEXT,
  bead_lineage     TEXT,
  active_beads     TEXT NOT NULL DEFAULT '{}',
  latest_commit    TEXT,
  diff_summary     TEXT,
  changed_files    TEXT DEFAULT '[]',
  hotspots         TEXT DEFAULT '[]',
  linked_artifacts TEXT DEFAULT '[]',
  linked_findings  TEXT DEFAULT '[]',
  decision_anchors TEXT DEFAULT '[]',
  unresolved       TEXT DEFAULT '[]',
  provenance       TEXT DEFAULT '{}',
  last_enriched_at TEXT,
  vector_refs      TEXT DEFAULT '[]',
  schema_version   INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- Findings store (§11.3)
CREATE TABLE IF NOT EXISTS findings (
  finding_id        TEXT PRIMARY KEY,
  workstream_id     TEXT NOT NULL,
  source_bead_id    TEXT,
  source_agent_id   TEXT,
  finding_type      TEXT NOT NULL
    CHECK (finding_type IN ('in_scope','exploratory','boundary_crossing','backpressure','duplicate_candidate')),
  evidence          TEXT NOT NULL DEFAULT '{}',
  confidence        REAL NOT NULL DEFAULT 0.5
    CHECK (confidence BETWEEN 0.0 AND 1.0),
  affected_scope    TEXT,
  suspected_domain  TEXT,
  related_findings  TEXT DEFAULT '[]',
  suggested_actions TEXT DEFAULT '[]',
  promotion_state   TEXT NOT NULL DEFAULT 'open'
    CHECK (promotion_state IN ('open','promoted','deferred','suppressed','merged','escalated','archived')),
  suppression_reason TEXT,
  salience          REAL NOT NULL DEFAULT 1.0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  resolved_at       TEXT,
  schema_version    INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_findings_workstream ON findings (workstream_id, promotion_state);
CREATE INDEX IF NOT EXISTS idx_findings_salience ON findings (salience DESC) WHERE promotion_state = 'open';

-- Conductor journal (§9.3)
CREATE TABLE IF NOT EXISTS conductor_journal (
  entry_id       TEXT PRIMARY KEY,
  workstream_id  TEXT NOT NULL,
  session_type   TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  structured     TEXT NOT NULL DEFAULT '{}',
  narrative      TEXT NOT NULL DEFAULT '',
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_journal_workstream ON conductor_journal (workstream_id, timestamp DESC);

-- Seed remediation patterns (H1: cold-start deadlock fix)
CREATE TABLE IF NOT EXISTS remediation_patterns (
  pattern_id   TEXT PRIMARY KEY,
  pattern_type TEXT NOT NULL,
  description  TEXT NOT NULL,
  confidence   REAL NOT NULL DEFAULT 0.5,
  usage_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

- [ ] **Step 2: Write the typed event definitions**

```typescript
// sdlc-os/colony/event-types.ts

export type EventType =
  // High-value (full enrichment)
  | 'bead_started'
  | 'bead_completed'
  | 'bead_failed'
  | 'commit_created'
  | 'test_run_completed'
  | 'patch_applied'
  | 'escalation_requested'
  | 'finding_opened'
  | 'finding_promoted'
  | 'session_checkpointed'
  // Medium-value (batched condensation)
  | 'finding_deferred'
  | 'large_file_batch_read'
  | 'notable_tool_failure'
  | 'retry_pattern_detected'
  // Low-value (append-only logging)
  | 'shell_command_executed'
  | 'trivial_file_read'
  | 'intermediate_tool_chatter';

export type ProcessingLevel = 'pending' | 'logged' | 'condensed' | 'enriched';

export type FindingType =
  | 'in_scope'
  | 'exploratory'
  | 'boundary_crossing'
  | 'backpressure'
  | 'duplicate_candidate';

export type PromotionState =
  | 'open'
  | 'promoted'
  | 'deferred'
  | 'suppressed'
  | 'merged'
  | 'escalated'
  | 'archived';

export const HIGH_VALUE_EVENTS: Set<EventType> = new Set([
  'bead_started', 'bead_completed', 'bead_failed', 'commit_created',
  'test_run_completed', 'patch_applied', 'escalation_requested',
  'finding_opened', 'finding_promoted', 'session_checkpointed',
]);

export const MEDIUM_VALUE_EVENTS: Set<EventType> = new Set([
  'finding_deferred', 'large_file_batch_read',
  'notable_tool_failure', 'retry_pattern_detected',
]);

export interface TypedEvent {
  event_id: string;
  event_type: EventType;
  workstream_id: string;
  bead_id?: string;
  agent_id?: string;
  timestamp: string;
  payload: Record<string, unknown>;
  processing_level: ProcessingLevel;
  idempotency_key: string;
}

export interface Finding {
  finding_id: string;
  workstream_id: string;
  source_bead_id?: string;
  source_agent_id?: string;
  finding_type: FindingType;
  evidence: Record<string, unknown>;
  confidence: number;
  affected_scope?: string;
  suspected_domain?: string;
  related_findings: string[];
  suggested_actions: string[];
  promotion_state: PromotionState;
  suppression_reason?: string;
  salience: number;
  created_at: string;
  updated_at: string;
  resolved_at?: string;
}

export interface StateLedgerRow {
  workstream_id: string;
  repo: string;
  branch: string;
  mission_id: string;
  scope_region?: string;
  bead_lineage?: string;
  active_beads: Record<string, string>;
  latest_commit?: string;
  diff_summary?: string;
  changed_files: string[];
  hotspots: string[];
  linked_artifacts: Array<{ path: string; type: string; checksum?: string }>;
  linked_findings: string[];
  decision_anchors: Array<Record<string, unknown>>;
  unresolved: string[];
  provenance: Record<string, unknown>;
  last_enriched_at?: string;
  vector_refs: string[];
}

export interface ConductorJournalEntry {
  entry_id: string;
  workstream_id: string;
  session_type: string;
  timestamp: string;
  structured: {
    beads_dispatched?: string[];
    beads_evaluated?: string[];
    findings_created?: string[];
    findings_promoted?: string[];
    findings_suppressed?: string[];
    decisions?: Array<{
      what: string;
      why: string;
      evidence: string[];
      alternatives_rejected?: string[];
      uncertainty?: string[];
      scope_assumed?: string[];
    }>;
    next_actions?: string[];
    backpressure_signals?: string[];
  };
  narrative: string;
}

/** Generate an idempotency key from event components + content hash */
export function makeIdempotencyKey(
  event_type: EventType,
  workstream_id: string,
  bead_id: string | undefined,
  payload: Record<string, unknown>,
): string {
  const contentStr = JSON.stringify(payload);
  // Simple hash — crypto.createHash would be better but this works for dedup
  let hash = 0;
  for (let i = 0; i < contentStr.length; i++) {
    const char = contentStr.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `${event_type}:${workstream_id}:${bead_id ?? 'none'}:${hash.toString(36)}`;
}
```

- [ ] **Step 3: Write failing tests for events DB**

```typescript
// sdlc-os/colony/events-db.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openEventsDb, closeEventsDb, insertEvent, queryEvents, getEventsDb } from './events-db.ts';
import type { TypedEvent } from './event-types.ts';
import { unlinkSync } from 'node:fs';

const TEST_DB = '/tmp/colony-events-test.db';

describe('events-db', () => {
  beforeEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
    openEventsDb(TEST_DB);
  });

  afterEach(() => {
    closeEventsDb();
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  it('inserts and queries events by workstream', () => {
    const event: TypedEvent = {
      event_id: 'evt-001',
      event_type: 'bead_completed',
      workstream_id: 'ws-abc',
      bead_id: 'B01',
      timestamp: new Date().toISOString(),
      payload: { summary: 'task done' },
      processing_level: 'pending',
      idempotency_key: 'bead_completed:ws-abc:B01:test1',
    };
    insertEvent(event);
    const results = queryEvents('ws-abc');
    expect(results).toHaveLength(1);
    expect(results[0].event_type).toBe('bead_completed');
  });

  it('enforces idempotency — duplicate insert is a no-op', () => {
    const event: TypedEvent = {
      event_id: 'evt-002',
      event_type: 'bead_started',
      workstream_id: 'ws-abc',
      timestamp: new Date().toISOString(),
      payload: {},
      processing_level: 'pending',
      idempotency_key: 'bead_started:ws-abc:none:dup1',
    };
    insertEvent(event);
    // Second insert with same idempotency key — should not throw or duplicate
    const event2 = { ...event, event_id: 'evt-003' };
    insertEvent(event2);
    const results = queryEvents('ws-abc');
    expect(results).toHaveLength(1);
    expect(results[0].event_id).toBe('evt-002');
  });

  it('creates all required tables', () => {
    const db = getEventsDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);
    expect(names).toContain('events');
    expect(names).toContain('findings');
    expect(names).toContain('state_ledger');
    expect(names).toContain('conductor_journal');
    expect(names).toContain('remediation_patterns');
    expect(names).toContain('schema_meta');
  });
});
```

- [ ] **Step 4: Run tests — verify they fail**

Run: `cd /home/q/LAB/sdlc-os && npx vitest run colony/events-db.test.ts`
Expected: FAIL — `events-db.ts` module does not exist

- [ ] **Step 5: Implement events-db.ts**

```typescript
// sdlc-os/colony/events-db.ts
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { TypedEvent } from './event-types.ts';

let db: DatabaseSync | null = null;

export function openEventsDb(dbPath: string): void {
  if (db) return;
  db = new DatabaseSync(dbPath);
  const schemaPath = join(dirname(import.meta.url.replace('file://', '')), 'events-schema.sql');
  const schema = readFileSync(schemaPath, 'utf8');
  // Execute each statement separately (DatabaseSync doesn't support multi-statement exec)
  for (const stmt of schema.split(';').map(s => s.trim()).filter(Boolean)) {
    try {
      db.exec(stmt);
    } catch {
      // Ignore CREATE IF NOT EXISTS collisions
    }
  }
}

export function closeEventsDb(): void {
  if (!db) return;
  try {
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  } catch {}
  db.close();
  db = null;
}

export function getEventsDb(): DatabaseSync {
  if (!db) throw new Error('Events DB not open — call openEventsDb first');
  return db;
}

export function insertEvent(event: TypedEvent): void {
  const d = getEventsDb();
  d.prepare(`
    INSERT OR IGNORE INTO events
      (event_id, event_type, workstream_id, bead_id, agent_id, timestamp, payload, processing_level, idempotency_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.event_id,
    event.event_type,
    event.workstream_id,
    event.bead_id ?? null,
    event.agent_id ?? null,
    event.timestamp,
    JSON.stringify(event.payload),
    event.processing_level,
    event.idempotency_key,
  );
}

export function queryEvents(
  workstream_id: string,
  opts?: { event_type?: string; limit?: number },
): TypedEvent[] {
  const d = getEventsDb();
  let sql = 'SELECT * FROM events WHERE workstream_id = ?';
  const params: unknown[] = [workstream_id];
  if (opts?.event_type) {
    sql += ' AND event_type = ?';
    params.push(opts.event_type);
  }
  sql += ' ORDER BY timestamp DESC';
  if (opts?.limit) {
    sql += ' LIMIT ?';
    params.push(opts.limit);
  }
  const rows = d.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(r => ({
    event_id: r.event_id as string,
    event_type: r.event_type as TypedEvent['event_type'],
    workstream_id: r.workstream_id as string,
    bead_id: r.bead_id as string | undefined,
    agent_id: r.agent_id as string | undefined,
    timestamp: r.timestamp as string,
    payload: JSON.parse(r.payload as string),
    processing_level: r.processing_level as TypedEvent['processing_level'],
    idempotency_key: r.idempotency_key as string,
  }));
}
```

- [ ] **Step 6: Run tests — verify they pass**

Run: `cd /home/q/LAB/sdlc-os && npx vitest run colony/events-db.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Write bootstrap module**

```typescript
// sdlc-os/colony/bootstrap.ts
import { openEventsDb, getEventsDb } from './events-db.ts';
import type { StateLedgerRow } from './event-types.ts';

const SEED_PATTERNS = [
  { pattern_id: 'lint-fix', pattern_type: 'hygiene', description: 'Lint/format fix in single file', confidence: 0.9 },
  { pattern_id: 'dead-code-removal', pattern_type: 'hygiene', description: 'Remove unused export/function', confidence: 0.85 },
  { pattern_id: 'test-coverage', pattern_type: 'quality', description: 'Add missing test for existing function', confidence: 0.8 },
  { pattern_id: 'type-safety', pattern_type: 'quality', description: 'Replace any-cast with typed interface', confidence: 0.75 },
  { pattern_id: 'import-cleanup', pattern_type: 'hygiene', description: 'Fix unused/circular imports', confidence: 0.85 },
  { pattern_id: 'error-handling', pattern_type: 'reliability', description: 'Add missing error handling path', confidence: 0.7 },
];

/**
 * Bootstrap the colony events database with schema + seed data.
 * Idempotent — safe to call multiple times.
 */
export function bootstrapColony(eventsDbPath: string): void {
  openEventsDb(eventsDbPath);
  const db = getEventsDb();

  // Seed remediation patterns (H1: cold-start deadlock fix)
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO remediation_patterns
      (pattern_id, pattern_type, description, confidence, usage_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `);
  for (const p of SEED_PATTERNS) {
    insert.run(p.pattern_id, p.pattern_type, p.description, p.confidence, now, now);
  }
}

/**
 * Create a minimal state ledger row for a new workstream.
 * This is the cold-start state packet — enough for the first Conductor session.
 */
export function createWorkstream(opts: {
  workstream_id: string;
  repo: string;
  branch: string;
  mission_id: string;
  scope_region?: string;
}): void {
  const db = getEventsDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO state_ledger
      (workstream_id, repo, branch, mission_id, scope_region, active_beads, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '{}', ?, ?)
  `).run(opts.workstream_id, opts.repo, opts.branch, opts.mission_id, opts.scope_region ?? null, now, now);
}
```

- [ ] **Step 8: Write bootstrap tests**

```typescript
// sdlc-os/colony/bootstrap.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootstrapColony, createWorkstream } from './bootstrap.ts';
import { getEventsDb, closeEventsDb } from './events-db.ts';
import { unlinkSync } from 'node:fs';

const TEST_DB = '/tmp/colony-bootstrap-test.db';

describe('bootstrap', () => {
  beforeEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
  });

  afterEach(() => {
    closeEventsDb();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('seeds remediation patterns on first boot', () => {
    bootstrapColony(TEST_DB);
    const db = getEventsDb();
    const patterns = db.prepare('SELECT * FROM remediation_patterns').all() as Array<Record<string, unknown>>;
    expect(patterns.length).toBeGreaterThanOrEqual(6);
    expect(patterns.some(p => p.pattern_id === 'lint-fix')).toBe(true);
  });

  it('is idempotent — second call does not duplicate patterns', () => {
    bootstrapColony(TEST_DB);
    closeEventsDb();
    bootstrapColony(TEST_DB);
    const db = getEventsDb();
    const patterns = db.prepare('SELECT * FROM remediation_patterns').all();
    expect(patterns).toHaveLength(6);
  });

  it('creates a minimal workstream state ledger row', () => {
    bootstrapColony(TEST_DB);
    createWorkstream({
      workstream_id: 'ws-test-001',
      repo: '/home/q/LAB/WhatSoup',
      branch: 'main',
      mission_id: 'test-mission',
    });
    const db = getEventsDb();
    const row = db.prepare('SELECT * FROM state_ledger WHERE workstream_id = ?').get('ws-test-001') as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.repo).toBe('/home/q/LAB/WhatSoup');
    expect(row.active_beads).toBe('{}');
  });
});
```

- [ ] **Step 9: Run all bootstrap tests**

Run: `cd /home/q/LAB/sdlc-os && npx vitest run colony/bootstrap.test.ts colony/events-db.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 10: Commit**

```bash
cd /home/q/LAB/sdlc-os
git add colony/events-schema.sql colony/event-types.ts colony/events-db.ts colony/events-db.test.ts colony/bootstrap.ts colony/bootstrap.test.ts
git commit -m "feat: add colony events database schema, bootstrap, and typed event model

Separate events.db from tmup.db to avoid SQLite write contention (C2).
Schema includes: events, findings, state_ledger, conductor_journal,
and remediation_patterns tables. Seed patterns address promotion
cold-start deadlock (H1). Bootstrap is idempotent."
```

---

## Task 2: Finding Operations — CRUD + Promotion Policy

**Files:**
- Create: `sdlc-os/colony/finding-ops.ts`
- Create: `sdlc-os/colony/finding-ops.test.ts`

- [ ] **Step 1: Write failing tests for finding operations**

```typescript
// sdlc-os/colony/finding-ops.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootstrapColony } from './bootstrap.ts';
import { closeEventsDb } from './events-db.ts';
import {
  createFinding, getFinding, promoteFinding, suppressFinding,
  deferFinding, checkAutoPromotion, archiveStaleFindings,
  getOpenFindings,
} from './finding-ops.ts';
import { unlinkSync } from 'node:fs';

const TEST_DB = '/tmp/colony-findings-test.db';

describe('finding-ops', () => {
  beforeEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
    bootstrapColony(TEST_DB);
  });

  afterEach(() => {
    closeEventsDb();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('creates a finding with evidence', () => {
    const id = createFinding({
      workstream_id: 'ws-001',
      finding_type: 'in_scope',
      evidence: { observed: 'import anomaly in utils.ts', file_refs: ['src/utils.ts:42'] },
      confidence: 0.8,
      affected_scope: 'src/utils.ts',
    });
    const f = getFinding(id);
    expect(f).toBeDefined();
    expect(f!.finding_type).toBe('in_scope');
    expect(f!.confidence).toBe(0.8);
    expect(f!.promotion_state).toBe('open');
  });

  it('auto-promotes in-scope finding with high confidence and file anchor', () => {
    const id = createFinding({
      workstream_id: 'ws-001',
      finding_type: 'in_scope',
      evidence: { observed: 'dead export', file_refs: ['src/foo.ts:10'] },
      confidence: 0.8,
      affected_scope: 'src/foo.ts',
    });
    const result = checkAutoPromotion(id, { active_mission_scope: 'src/' });
    expect(result.promoted).toBe(true);
    const f = getFinding(id);
    expect(f!.promotion_state).toBe('promoted');
  });

  it('does NOT auto-promote exploratory finding', () => {
    const id = createFinding({
      workstream_id: 'ws-001',
      finding_type: 'exploratory',
      evidence: { observed: 'database inconsistency' },
      confidence: 0.9,
    });
    const result = checkAutoPromotion(id, { active_mission_scope: 'src/' });
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain('not in_scope');
  });

  it('does NOT auto-promote low-confidence finding', () => {
    const id = createFinding({
      workstream_id: 'ws-001',
      finding_type: 'in_scope',
      evidence: { observed: 'maybe a problem' },
      confidence: 0.4,
    });
    const result = checkAutoPromotion(id, { active_mission_scope: 'src/' });
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain('confidence below');
  });

  it('suppresses finding with reason', () => {
    const id = createFinding({
      workstream_id: 'ws-001',
      finding_type: 'in_scope',
      evidence: {},
      confidence: 0.2,
    });
    suppressFinding(id, 'below confidence threshold');
    const f = getFinding(id);
    expect(f!.promotion_state).toBe('suppressed');
    expect(f!.suppression_reason).toBe('below confidence threshold');
  });

  it('archives findings below salience threshold', () => {
    // Create a finding with low salience
    const id = createFinding({
      workstream_id: 'ws-001',
      finding_type: 'in_scope',
      evidence: {},
      confidence: 0.5,
    });
    // Manually set salience below threshold
    const { getEventsDb } = await import('./events-db.ts');
    getEventsDb().prepare('UPDATE findings SET salience = 0.01 WHERE finding_id = ?').run(id);

    const archived = archiveStaleFindings('ws-001');
    expect(archived).toBeGreaterThanOrEqual(1);
    const f = getFinding(id);
    expect(f!.promotion_state).toBe('archived');
  });

  it('respects 100-finding cap per workstream', () => {
    for (let i = 0; i < 105; i++) {
      createFinding({
        workstream_id: 'ws-full',
        finding_type: 'in_scope',
        evidence: { idx: i },
        confidence: 0.5 + (i * 0.001), // Slightly different salience
      });
    }
    const open = getOpenFindings('ws-full');
    expect(open.length).toBeLessThanOrEqual(100);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd /home/q/LAB/sdlc-os && npx vitest run colony/finding-ops.test.ts`
Expected: FAIL — `finding-ops.ts` does not exist

- [ ] **Step 3: Implement finding-ops.ts**

```typescript
// sdlc-os/colony/finding-ops.ts
import { getEventsDb } from './events-db.ts';
import type { Finding, FindingType } from './event-types.ts';

const MAX_OPEN_FINDINGS_PER_WORKSTREAM = 100;
const SALIENCE_ARCHIVE_THRESHOLD = 0.05;
const AUTO_PROMOTION_CONFIDENCE_THRESHOLD = 0.7;

function generateId(): string {
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createFinding(opts: {
  workstream_id: string;
  finding_type: FindingType;
  evidence: Record<string, unknown>;
  confidence: number;
  affected_scope?: string;
  suspected_domain?: string;
  source_bead_id?: string;
  source_agent_id?: string;
  suggested_actions?: string[];
}): string {
  const db = getEventsDb();
  const id = generateId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO findings
      (finding_id, workstream_id, source_bead_id, source_agent_id, finding_type,
       evidence, confidence, affected_scope, suspected_domain, suggested_actions,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, opts.workstream_id, opts.source_bead_id ?? null, opts.source_agent_id ?? null,
    opts.finding_type, JSON.stringify(opts.evidence), opts.confidence,
    opts.affected_scope ?? null, opts.suspected_domain ?? null,
    JSON.stringify(opts.suggested_actions ?? []), now, now,
  );

  // Enforce cap
  enforceOpenFindingsCap(opts.workstream_id);

  return id;
}

export function getFinding(finding_id: string): Finding | null {
  const db = getEventsDb();
  const row = db.prepare('SELECT * FROM findings WHERE finding_id = ?').get(finding_id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToFinding(row);
}

export function getOpenFindings(workstream_id: string): Finding[] {
  const db = getEventsDb();
  const rows = db.prepare(
    "SELECT * FROM findings WHERE workstream_id = ? AND promotion_state = 'open' ORDER BY salience DESC"
  ).all(workstream_id) as Array<Record<string, unknown>>;
  return rows.map(rowToFinding);
}

export function checkAutoPromotion(
  finding_id: string,
  context: { active_mission_scope: string },
): { promoted: boolean; reason?: string } {
  const f = getFinding(finding_id);
  if (!f) return { promoted: false, reason: 'finding not found' };
  if (f.promotion_state !== 'open') return { promoted: false, reason: `already ${f.promotion_state}` };

  // §14.1: All conditions must be met
  if (f.finding_type !== 'in_scope') {
    return { promoted: false, reason: `not in_scope (is ${f.finding_type})` };
  }
  if (f.confidence < AUTO_PROMOTION_CONFIDENCE_THRESHOLD) {
    return { promoted: false, reason: `confidence below ${AUTO_PROMOTION_CONFIDENCE_THRESHOLD} (is ${f.confidence})` };
  }
  const evidence = f.evidence as Record<string, unknown>;
  const fileRefs = evidence['file_refs'] as string[] | undefined;
  if (!fileRefs || fileRefs.length === 0) {
    return { promoted: false, reason: 'no file/line anchor in evidence' };
  }
  if (f.affected_scope && !f.affected_scope.startsWith(context.active_mission_scope)) {
    return { promoted: false, reason: `affected scope ${f.affected_scope} outside mission ${context.active_mission_scope}` };
  }

  // Promote
  promoteFinding(finding_id);
  return { promoted: true };
}

export function promoteFinding(finding_id: string): void {
  const db = getEventsDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE findings SET promotion_state = 'promoted', updated_at = ? WHERE finding_id = ?").run(now, finding_id);
}

export function suppressFinding(finding_id: string, reason: string): void {
  const db = getEventsDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE findings SET promotion_state = 'suppressed', suppression_reason = ?, updated_at = ? WHERE finding_id = ?").run(reason, now, finding_id);
}

export function deferFinding(finding_id: string, reason: string): void {
  const db = getEventsDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE findings SET promotion_state = 'deferred', suppression_reason = ?, salience = 0.1, updated_at = ? WHERE finding_id = ?").run(reason, now, finding_id);
}

export function archiveStaleFindings(workstream_id: string): number {
  const db = getEventsDb();
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE findings SET promotion_state = 'archived', updated_at = ?
    WHERE workstream_id = ? AND promotion_state = 'open' AND salience < ?
  `).run(now, workstream_id, SALIENCE_ARCHIVE_THRESHOLD);
  return (result as { changes: number }).changes;
}

function enforceOpenFindingsCap(workstream_id: string): void {
  const db = getEventsDb();
  const count = (db.prepare(
    "SELECT COUNT(*) as cnt FROM findings WHERE workstream_id = ? AND promotion_state = 'open'"
  ).get(workstream_id) as { cnt: number }).cnt;

  if (count > MAX_OPEN_FINDINGS_PER_WORKSTREAM) {
    const excess = count - MAX_OPEN_FINDINGS_PER_WORKSTREAM;
    const now = new Date().toISOString();
    // Archive lowest-salience findings
    db.prepare(`
      UPDATE findings SET promotion_state = 'archived', updated_at = ?
      WHERE finding_id IN (
        SELECT finding_id FROM findings
        WHERE workstream_id = ? AND promotion_state = 'open'
        ORDER BY salience ASC LIMIT ?
      )
    `).run(now, workstream_id, excess);
  }
}

function rowToFinding(row: Record<string, unknown>): Finding {
  return {
    finding_id: row.finding_id as string,
    workstream_id: row.workstream_id as string,
    source_bead_id: row.source_bead_id as string | undefined,
    source_agent_id: row.source_agent_id as string | undefined,
    finding_type: row.finding_type as Finding['finding_type'],
    evidence: JSON.parse(row.evidence as string),
    confidence: row.confidence as number,
    affected_scope: row.affected_scope as string | undefined,
    suspected_domain: row.suspected_domain as string | undefined,
    related_findings: JSON.parse((row.related_findings as string) || '[]'),
    suggested_actions: JSON.parse((row.suggested_actions as string) || '[]'),
    promotion_state: row.promotion_state as Finding['promotion_state'],
    suppression_reason: row.suppression_reason as string | undefined,
    salience: row.salience as number,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    resolved_at: row.resolved_at as string | undefined,
  };
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd /home/q/LAB/sdlc-os && npx vitest run colony/finding-ops.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/q/LAB/sdlc-os
git add colony/finding-ops.ts colony/finding-ops.test.ts
git commit -m "feat: add finding operations with auto-promotion policy

CRUD for findings store with promotion/suppression/deferral/archival.
Auto-promotion requires: in_scope + confidence >= 0.7 + file anchor +
within mission scope. 100-finding cap enforced via salience-based
archival. 30-day hard TTL replaces exponential decay."
```

---

## Task 3: Cost Enforcement Trip-Wires

**Files:**
- Create: `sdlc-os/colony/cost-enforcer.ts`
- Create: `sdlc-os/colony/cost-enforcer.test.ts`
- Modify: `sdlc-os/colony/deacon.py` (wire trip-wires into dispatch decisions)

This addresses **Critical Finding C3** (cost budget unreachable).

- [ ] **Step 1: Write failing tests**

```typescript
// sdlc-os/colony/cost-enforcer.test.ts
import { describe, it, expect } from 'vitest';
import { CostEnforcer } from './cost-enforcer.ts';

describe('CostEnforcer', () => {
  it('allows dispatch when under budget', () => {
    const enforcer = new CostEnforcer(50.0);
    enforcer.recordCost('ws-001', 10.0);
    const check = enforcer.checkBudget('ws-001');
    expect(check.allowed).toBe(true);
    expect(check.phase).toBe('normal');
  });

  it('warns at 80% budget — disables discovery', () => {
    const enforcer = new CostEnforcer(50.0);
    enforcer.recordCost('ws-001', 42.0);
    const check = enforcer.checkBudget('ws-001');
    expect(check.allowed).toBe(true);
    expect(check.phase).toBe('warning');
    expect(check.discovery_disabled).toBe(true);
  });

  it('blocks new dispatches at 100% budget', () => {
    const enforcer = new CostEnforcer(50.0);
    enforcer.recordCost('ws-001', 52.0);
    const check = enforcer.checkBudget('ws-001');
    expect(check.allowed).toBe(false);
    expect(check.phase).toBe('exceeded');
  });

  it('tracks cost per workstream independently', () => {
    const enforcer = new CostEnforcer(50.0);
    enforcer.recordCost('ws-001', 48.0);
    enforcer.recordCost('ws-002', 5.0);
    expect(enforcer.checkBudget('ws-001').phase).toBe('warning');
    expect(enforcer.checkBudget('ws-002').phase).toBe('normal');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd /home/q/LAB/sdlc-os && npx vitest run colony/cost-enforcer.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement cost-enforcer.ts**

```typescript
// sdlc-os/colony/cost-enforcer.ts

export interface BudgetCheck {
  allowed: boolean;
  phase: 'normal' | 'warning' | 'exceeded';
  discovery_disabled: boolean;
  spent_usd: number;
  ceiling_usd: number;
  reason?: string;
}

export class CostEnforcer {
  private ceiling: number;
  private costs: Map<string, number> = new Map();

  constructor(ceilingUsd: number) {
    this.ceiling = ceilingUsd;
  }

  recordCost(workstream_id: string, cost_usd: number): void {
    const current = this.costs.get(workstream_id) ?? 0;
    this.costs.set(workstream_id, current + cost_usd);
  }

  checkBudget(workstream_id: string): BudgetCheck {
    const spent = this.costs.get(workstream_id) ?? 0;
    const ratio = spent / this.ceiling;

    if (ratio >= 1.0) {
      return {
        allowed: false,
        phase: 'exceeded',
        discovery_disabled: true,
        spent_usd: spent,
        ceiling_usd: this.ceiling,
        reason: `Budget exceeded: $${spent.toFixed(2)} / $${this.ceiling.toFixed(2)}`,
      };
    }

    if (ratio >= 0.8) {
      return {
        allowed: true,
        phase: 'warning',
        discovery_disabled: true,
        spent_usd: spent,
        ceiling_usd: this.ceiling,
        reason: `Budget warning (${(ratio * 100).toFixed(0)}%): discovery beads disabled`,
      };
    }

    return {
      allowed: true,
      phase: 'normal',
      discovery_disabled: false,
      spent_usd: spent,
      ceiling_usd: this.ceiling,
    };
  }

  getSpent(workstream_id: string): number {
    return this.costs.get(workstream_id) ?? 0;
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd /home/q/LAB/sdlc-os && npx vitest run colony/cost-enforcer.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/q/LAB/sdlc-os
git add colony/cost-enforcer.ts colony/cost-enforcer.test.ts
git commit -m "feat: add cost enforcement with trip-wires

80% budget: disable discovery beads. 100%: block new dispatches.
Per-workstream cost tracking. Addresses C3 (unreachable cost budget)."
```

---

## Task 4: Conductor Journal — Read/Write Protocol

**Files:**
- Create: `sdlc-os/colony/conductor-journal.ts`
- Create: `sdlc-os/colony/conductor-journal.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// sdlc-os/colony/conductor-journal.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootstrapColony } from './bootstrap.ts';
import { closeEventsDb } from './events-db.ts';
import { writeJournalEntry, readLatestJournal, readJournalHistory } from './conductor-journal.ts';
import type { ConductorJournalEntry } from './event-types.ts';
import { unlinkSync } from 'node:fs';

const TEST_DB = '/tmp/colony-journal-test.db';

describe('conductor-journal', () => {
  beforeEach(() => {
    try { unlinkSync(TEST_DB); } catch {}
    try { unlinkSync(TEST_DB + '-wal'); } catch {}
    try { unlinkSync(TEST_DB + '-shm'); } catch {}
    bootstrapColony(TEST_DB);
  });

  afterEach(() => {
    closeEventsDb();
    try { unlinkSync(TEST_DB); } catch {}
  });

  it('writes and reads a journal entry', () => {
    const entry: ConductorJournalEntry = {
      entry_id: 'j-001',
      workstream_id: 'ws-001',
      session_type: 'EVALUATE',
      timestamp: new Date().toISOString(),
      structured: {
        beads_evaluated: ['B01', 'B02'],
        decisions: [{
          what: 'Advanced B01 to verified',
          why: 'Tests pass, oracle approved',
          evidence: ['3144 tests pass', 'oracle APPROVE'],
        }],
        next_actions: ['Dispatch B03'],
      },
      narrative: 'Evaluated B01 and B02. B01 passed all checks. B02 had a minor issue with test naming that was auto-corrected by sentinel.',
    };
    writeJournalEntry(entry);
    const latest = readLatestJournal('ws-001');
    expect(latest).toBeDefined();
    expect(latest!.session_type).toBe('EVALUATE');
    expect(latest!.structured.beads_evaluated).toEqual(['B01', 'B02']);
    expect(latest!.narrative).toContain('B01 passed all checks');
  });

  it('returns null when no journal entries exist', () => {
    const latest = readLatestJournal('ws-nonexistent');
    expect(latest).toBeNull();
  });

  it('reads journal history in reverse chronological order', () => {
    for (let i = 0; i < 3; i++) {
      writeJournalEntry({
        entry_id: `j-${i}`,
        workstream_id: 'ws-001',
        session_type: 'EVALUATE',
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        structured: { beads_evaluated: [`B0${i}`] },
        narrative: `Entry ${i}`,
      });
    }
    const history = readJournalHistory('ws-001', 2);
    expect(history).toHaveLength(2);
    expect(history[0].narrative).toBe('Entry 2'); // Most recent first
    expect(history[1].narrative).toBe('Entry 1');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd /home/q/LAB/sdlc-os && npx vitest run colony/conductor-journal.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement conductor-journal.ts**

```typescript
// sdlc-os/colony/conductor-journal.ts
import { getEventsDb } from './events-db.ts';
import type { ConductorJournalEntry } from './event-types.ts';

export function writeJournalEntry(entry: ConductorJournalEntry): void {
  const db = getEventsDb();
  db.prepare(`
    INSERT INTO conductor_journal
      (entry_id, workstream_id, session_type, timestamp, structured, narrative)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    entry.entry_id,
    entry.workstream_id,
    entry.session_type,
    entry.timestamp,
    JSON.stringify(entry.structured),
    entry.narrative,
  );
}

export function readLatestJournal(workstream_id: string): ConductorJournalEntry | null {
  const db = getEventsDb();
  const row = db.prepare(
    'SELECT * FROM conductor_journal WHERE workstream_id = ? ORDER BY timestamp DESC LIMIT 1'
  ).get(workstream_id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToEntry(row);
}

export function readJournalHistory(workstream_id: string, limit: number = 10): ConductorJournalEntry[] {
  const db = getEventsDb();
  const rows = db.prepare(
    'SELECT * FROM conductor_journal WHERE workstream_id = ? ORDER BY timestamp DESC LIMIT ?'
  ).all(workstream_id, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToEntry);
}

function rowToEntry(row: Record<string, unknown>): ConductorJournalEntry {
  return {
    entry_id: row.entry_id as string,
    workstream_id: row.workstream_id as string,
    session_type: row.session_type as string,
    timestamp: row.timestamp as string,
    structured: JSON.parse(row.structured as string),
    narrative: row.narrative as string,
  };
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cd /home/q/LAB/sdlc-os && npx vitest run colony/conductor-journal.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/q/LAB/sdlc-os
git add colony/conductor-journal.ts colony/conductor-journal.test.ts
git commit -m "feat: add conductor journal with structured + narrative anchors

Hybrid structured/narrative decision capture per §7. Entries preserve:
decisions with evidence/alternatives/uncertainty, beads dispatched/
evaluated, findings created/promoted, and narrative context."
```

---

## Task 5: Wire Deacon — DISCOVER Session Type + Cost Trip-Wires

**Files:**
- Modify: `sdlc-os/colony/deacon.py`

- [ ] **Step 1: Add DISCOVER to SessionType enum**

In `deacon.py` line 78-82, add `DISCOVER` to the `SessionType` enum:

```python
class SessionType(enum.Enum):
    DISPATCH = "dispatch"
    EVALUATE = "evaluate"
    SYNTHESIZE = "synthesize"
    RECOVER = "recover"
    DISCOVER = "discover"  # NEW: scheduled audit/discovery beads
```

- [ ] **Step 2: Wire cost enforcement into _should_spawn_conductor()**

In the Deacon's decision logic for whether to spawn a Conductor, add cost checking:

```python
# In _should_spawn_conductor() or equivalent decision method:
def _check_cost_budget(self, workstream_id: str) -> tuple[bool, str]:
    """Check if workstream is within cost budget. Returns (allowed, phase)."""
    cost = self._aggregate_bead_cost(workstream_id, self.session_log_path)
    ceiling = float(os.environ.get("BEAD_COST_CEILING_USD", "50.0"))
    ratio = cost / ceiling if ceiling > 0 else 0

    if ratio >= 1.0:
        return False, "exceeded"
    if ratio >= 0.8:
        return True, "warning"  # Discovery disabled at this level
    return True, "normal"
```

- [ ] **Step 3: Wire DISCOVER trigger into the main event loop**

Add to the Deacon's `check_for_work()` method:

```python
# After checking for completed/failed tasks, before returning "no work":
if self._idle_agents_exist() and self._no_pending_tasks():
    budget_ok, phase = self._check_cost_budget(current_workstream)
    if budget_ok and phase != "warning":  # Discovery disabled during warning
        # Check if it's been >30min since last DISCOVER session
        if self._time_since_last_discover() > 1800:
            return SessionType.DISCOVER
```

- [ ] **Step 4: Persist backpressure signals to events DB**

Wire the existing `_bead_failure_counts` (currently in-memory dict at `deacon.py:231`) to also write to the events DB:

```python
def _record_bead_failure_to_events_db(self, bead_id: str, failure_info: dict):
    """Persist backpressure signal to events DB for Conductor visibility."""
    import subprocess
    # Use a small Node script to write to events.db (Deacon is Python, events-db is TS)
    # Alternative: direct sqlite3 module write
    import sqlite3
    conn = sqlite3.connect(self.events_db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=8000")
    conn.execute("""
        INSERT OR IGNORE INTO events
        (event_id, event_type, workstream_id, bead_id, timestamp, payload, processing_level, idempotency_key)
        VALUES (?, 'retry_pattern_detected', ?, ?, ?, ?, 'pending', ?)
    """, (
        f"evt-{int(time.time()*1000)}-{bead_id}",
        self.current_workstream_id,
        bead_id,
        datetime.now(timezone.utc).isoformat(),
        json.dumps(failure_info),
        f"retry_pattern_detected:{self.current_workstream_id}:{bead_id}:{failure_info.get('count', 0)}",
    ))
    conn.commit()
    conn.close()
```

- [ ] **Step 5: Run existing Deacon tests**

Run: `cd /home/q/LAB/sdlc-os && python -m pytest colony/deacon_test.py -v 2>&1 | tail -10`
Expected: All 59 existing tests pass, plus any new tests added

- [ ] **Step 6: Commit**

```bash
cd /home/q/LAB/sdlc-os
git add colony/deacon.py
git commit -m "feat: add DISCOVER session type + cost trip-wires to Deacon

DISCOVER session spawns when agents are idle and discovery budget
allows. Cost enforcement: 80% → disable discovery, 100% → block
dispatches. Backpressure signals now persisted to events.db."
```

---

## Task 6: Integration Smoke Test — Full Core Loop

**Files:**
- Create: `sdlc-os/colony/integration-test-core-loop.sh`

This task exercises the full Phase 1 loop end-to-end.

- [ ] **Step 1: Write smoke test script**

```bash
#!/bin/bash
# sdlc-os/colony/integration-test-core-loop.sh
# Smoke test: Deacon → Conductor → Worker → Evaluation
set -euo pipefail

echo "=== Colony Core Loop Smoke Test ==="

EVENTS_DB="/tmp/colony-smoke-test-events.db"
rm -f "$EVENTS_DB" "$EVENTS_DB-wal" "$EVENTS_DB-shm"

# 1. Bootstrap events DB
echo "[1/6] Bootstrapping events DB..."
cd /home/q/LAB/sdlc-os
npx tsx -e "
  const { bootstrapColony, createWorkstream } = require('./colony/bootstrap.ts');
  bootstrapColony('$EVENTS_DB');
  createWorkstream({
    workstream_id: 'smoke-test-001',
    repo: '/home/q/LAB/WhatSoup',
    branch: 'main',
    mission_id: 'smoke-test',
    scope_region: 'tests/',
  });
  console.log('Bootstrap complete');
"

# 2. Verify schema
echo "[2/6] Verifying schema..."
TABLES=$(sqlite3 "$EVENTS_DB" ".tables" 2>/dev/null)
for t in events findings state_ledger conductor_journal remediation_patterns; do
  echo "$TABLES" | grep -q "$t" && echo "  ✓ $t" || { echo "  ✗ $t MISSING"; exit 1; }
done

# 3. Verify seed patterns
echo "[3/6] Checking seed remediation patterns..."
COUNT=$(sqlite3 "$EVENTS_DB" "SELECT COUNT(*) FROM remediation_patterns;" 2>/dev/null)
[ "$COUNT" -ge 6 ] && echo "  ✓ $COUNT patterns seeded" || { echo "  ✗ Only $COUNT patterns"; exit 1; }

# 4. Insert a test event
echo "[4/6] Inserting test event..."
npx tsx -e "
  const { openEventsDb, insertEvent } = require('./colony/events-db.ts');
  openEventsDb('$EVENTS_DB');
  insertEvent({
    event_id: 'smoke-evt-001',
    event_type: 'bead_completed',
    workstream_id: 'smoke-test-001',
    bead_id: 'B-smoke',
    timestamp: new Date().toISOString(),
    payload: { summary: 'smoke test bead done' },
    processing_level: 'pending',
    idempotency_key: 'bead_completed:smoke-test-001:B-smoke:test',
  });
  console.log('Event inserted');
"

# 5. Create and check a finding
echo "[5/6] Testing finding lifecycle..."
npx tsx -e "
  const { openEventsDb } = require('./colony/events-db.ts');
  const { createFinding, checkAutoPromotion, getFinding } = require('./colony/finding-ops.ts');
  openEventsDb('$EVENTS_DB');
  const id = createFinding({
    workstream_id: 'smoke-test-001',
    finding_type: 'in_scope',
    evidence: { observed: 'smoke test finding', file_refs: ['tests/smoke.ts:1'] },
    confidence: 0.85,
    affected_scope: 'tests/',
  });
  const result = checkAutoPromotion(id, { active_mission_scope: 'tests/' });
  const f = getFinding(id);
  console.log('Finding:', f.finding_id, 'promoted:', result.promoted, 'state:', f.promotion_state);
  if (!result.promoted) { process.exit(1); }
"

# 6. Write and read journal
echo "[6/6] Testing conductor journal..."
npx tsx -e "
  const { openEventsDb } = require('./colony/events-db.ts');
  const { writeJournalEntry, readLatestJournal } = require('./colony/conductor-journal.ts');
  openEventsDb('$EVENTS_DB');
  writeJournalEntry({
    entry_id: 'j-smoke',
    workstream_id: 'smoke-test-001',
    session_type: 'EVALUATE',
    timestamp: new Date().toISOString(),
    structured: { beads_evaluated: ['B-smoke'], decisions: [{ what: 'Smoke test pass', why: 'All checks green', evidence: ['tests pass'] }] },
    narrative: 'Smoke test evaluation complete.',
  });
  const latest = readLatestJournal('smoke-test-001');
  console.log('Journal:', latest.session_type, latest.narrative.substring(0, 40));
"

# Cleanup
rm -f "$EVENTS_DB" "$EVENTS_DB-wal" "$EVENTS_DB-shm"

echo ""
echo "=== ALL SMOKE TESTS PASSED ==="
```

- [ ] **Step 2: Run the smoke test**

Run: `cd /home/q/LAB/sdlc-os && bash colony/integration-test-core-loop.sh`
Expected: All 6 checks pass

- [ ] **Step 3: Commit**

```bash
cd /home/q/LAB/sdlc-os
git add colony/integration-test-core-loop.sh
git commit -m "test: add colony core loop integration smoke test

End-to-end test: bootstrap → schema verify → event insert → finding
lifecycle → journal read/write. Exercises the full Phase 1 protocol."
```

---

## Summary

Phase 1 delivers 6 tasks producing ~12 new files across sdlc-os and tmup:

| Task | What | Tests | Critical Fix |
|------|------|-------|-------------|
| 1 | Events DB schema + bootstrap | 6 | C1 (bootstrap), C2 (contention), H1 (cold-start) |
| 2 | Finding operations + promotion policy | 7 | §14 promotion/suppression policy |
| 3 | Cost enforcement trip-wires | 4 | C3 (unreachable budget) |
| 4 | Conductor journal | 3 | §7 (decision anchor survival) |
| 5 | Deacon wiring (DISCOVER + cost + backpressure) | existing 59 | §4.2 Deacon enhancements |
| 6 | Integration smoke test | 6 checks | End-to-end validation |

**Phase 2** (Cross-Model + Review) and **Phase 3** (Autonomy) will be planned after Phase 1 is validated. Phase 2 adds: cross-model review loop exercised in practice, conductor journal consumption in real Conductor sessions, BRIC brick_preprocess wiring. Phase 3 adds: boundary suspicion routing, adjacency discovery, backpressure-as-control-loop, full promotion policy with seed patterns.
