# Incident Ingestion Surface Implementation Plan (Plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Plan 1 incident store into the fleet API: schema migrations (bead zero), producer registry/enrollment/auth, and `POST /api/signals` with the locked §3 error taxonomy.

**Architecture:** `schema.ts` becomes numbered migrations applied transactionally by `openIncidentDb`; a new `ProducerStore` (`src/fleet/incidents/producers.ts`) owns the v2 `producers` table and the credential lifecycle; a new `src/fleet/routes/signals.ts` exports a handler factory consumed by `src/fleet/index.ts`, which constructs the stores once at startup (degraded 503 when the incident DB is unavailable).

**Tech Stack:** as Plan 1 (TypeScript strip-types, `node:sqlite`, zod where validation is needed, vitest). No new dependencies.

**Specs:** `docs/superpowers/specs/2026-07-28-incident-ingestion-surface-design.md` (this plan's contract) under `...2026-07-28-incident-control-plane-design.md` §3 (locked parent).

## Global Constraints

Carried verbatim from Plan 1 (all still binding): pinned node 24.15.0 (`npm ci` under pinned node BEFORE any test run); `npm test -- <paths>` (add `--pool=forks` if flaky); `.ts` import extensions; no new deps; private modes 0o700/0o600; fail-closed recovery never re-initializes non-empty state; explicit `now: Date` parameters — no wall-clock inside store/producer logic (route handlers construct `new Date()` at the boundary only); commits `feat(incidents)`/`test(incidents)` style with an `Evidence:` section, NO attribution trailers; `git add` explicit paths only; NO push (named hold point). New for this plan: secrets/credentials come from `randomBytes` (never derived or seeded); credential plaintext appears only in the single HTTP response that mints it — never in logs, errors, or storage; error-body `message` strings are static.

---

### Task 1: Numbered migrations (bead zero)

**Files:**
- Modify: `src/fleet/incidents/schema.ts` (restructure to `MIGRATIONS`; v1 = existing DDL verbatim)
- Modify: `src/fleet/incidents/db.ts` (apply-missing-migrations path; version-ahead refusal)
- Test: `tests/fleet/incidents/incident-db.test.ts` (extend)

**Interfaces:**
- Consumes: Plan 1's `openIncidentDb`, `IncidentStoreCorruptError`.
- Produces: `export interface IncidentMigration { version: number; statements: readonly string[] }`; `export const MIGRATIONS: readonly IncidentMigration[]` (v1 only in this task; Task 2 appends v2); `INCIDENT_SCHEMA_VERSION` derived as `MIGRATIONS[MIGRATIONS.length - 1].version`. `SCHEMA_STATEMENTS` is deleted (its only consumer is `db.ts`); `DISPOSITIONS`/`Disposition` unchanged.

- [ ] **Step 1: Write failing tests** (append to `incident-db.test.ts`; keep every existing test green):

```ts
  it('upgrades a v1-shaped database in place, preserving rows', () => {
    const db1 = openIncidentDb(dbPath());
    db1.prepare(`INSERT INTO events (
        producer_id, producer_domain_id, signal_id, payload_digest, payload_json,
        kind, subject, observed_at, received_at, disposition)
      VALUES ('p', 'd', 's1', 'sha256:x', '{}', 'heartbeat_observed', 'host:alpha',
              '2026-07-28T12:00:00.000Z', '2026-07-28T12:00:01.000Z', 'heartbeat_recorded')`).run();
    // Simulate a v1 database: drop v2 artifacts and rewind the version marker.
    db1.exec('DROP TABLE IF EXISTS producers');
    db1.prepare(`UPDATE meta SET value = '1' WHERE key = 'schema_version'`).run();
    db1.close();

    const db2 = openIncidentDb(dbPath());
    const version = db2.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
    expect(version.value).toBe(String(INCIDENT_SCHEMA_VERSION));
    const kept = db2.prepare(`SELECT signal_id FROM events`).all() as Array<{ signal_id: string }>;
    expect(kept.map((r) => r.signal_id)).toEqual(['s1']);
    db2.close();
  });

  it('fails closed on a database whose version is ahead of the code', () => {
    const db = openIncidentDb(dbPath());
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(INCIDENT_SCHEMA_VERSION + 1));
    db.close();
    expect(() => openIncidentDb(dbPath())).toThrow(IncidentStoreCorruptError);
  });
```

(The first test is written against Task 2's v2 state — until v2 exists it exercises the degenerate "no missing migrations" path and must still pass; the `DROP TABLE IF EXISTS` makes it version-agnostic.)

- [ ] **Step 2: Run** `npm test -- tests/fleet/incidents/incident-db.test.ts` — the ahead-version test FAILS (current code only rejects `!==`, message differs but behavior matches; verify it fails for the right reason: current code DOES reject ahead versions — so both may pass. If both pass, that is the recorded red-step outcome; the restructure below must keep them passing).
- [ ] **Step 3: Restructure** `schema.ts`:

```ts
export interface IncidentMigration { version: number; statements: readonly string[] }

export const MIGRATIONS: readonly IncidentMigration[] = [
  { version: 1, statements: [ /* the existing five DDL strings, verbatim */ ] },
];

export const INCIDENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
```

- [ ] **Step 4: Rework** `db.ts`: `initializeSchema` becomes `applyMigrations(db, fromVersion: number)` — for each migration with `version > fromVersion`: `BEGIN IMMEDIATE`; run its statements; `INSERT INTO meta ... ON CONFLICT(key) DO UPDATE` `schema_version = version`; `COMMIT` (rollback + rethrow on error). `openIncidentDb`: fresh → `applyMigrations(db, 0)`; existing → quick_check, read version; non-numeric → corrupt; `> INCIDENT_SCHEMA_VERSION` → `IncidentStoreCorruptError('unsupported schema_version ...')`; `< max` → `applyMigrations(db, version)`.
- [ ] **Step 5: Run** the full incidents suite → all green. **Step 6: Commit** (`feat(incidents): apply incident schema as numbered migrations` + Evidence).

---

### Task 2: Producers table (migration v2) + ProducerStore

**Files:**
- Modify: `src/fleet/incidents/schema.ts` (append v2 migration)
- Create: `src/fleet/incidents/producers.ts`
- Test: `tests/fleet/incidents/producers.test.ts`

**Interfaces:**
- Consumes: `MIGRATIONS` (Task 1), `openIncidentDb`.
- Produces (Task 4/5 consume these exact shapes):

```ts
export interface ProducerRegistration {
  producerId: string; producerDomainId: string;
  allowedKinds: readonly SignalKind[];
  allowedConditionClasses: readonly string[];
  allowedSubjects: readonly string[];
  enrollmentTtlMs?: number;          // default 10 * 60_000, clamped to max 30 * 60_000
  credentialTtlMs?: number;          // default 90 days
}
export type RegisterResult = { ok: true; enrollmentSecret: string } | { ok: false; reason: 'producer_exists' | 'invalid_input' };
export type ExchangeResult = { ok: true; credential: string } | { ok: false };  // uniform failure
export type RotateResult = { ok: true; credential: string } | { ok: false };
export interface AuthenticatedProducer {
  producerId: string; producerDomainId: string;
  allowedKinds: readonly string[]; allowedConditionClasses: readonly string[]; allowedSubjects: readonly string[];
}
export type ScopeDenial = 'kind_not_allowed' | 'condition_class_not_allowed' | 'subject_not_allowed';
export class ProducerStore {
  constructor(db: DatabaseSync, options?: { rotationOverlapMs?: number });  // default 24h
  register(input: ProducerRegistration, now: Date): RegisterResult;
  exchangeEnrollmentSecret(producerId: string, secret: string, now: Date): ExchangeResult;
  rotateCredential(producerId: string, currentCredential: string, now: Date): RotateResult;
  revoke(producerId: string): boolean;
  authenticate(bearer: string, now: Date): AuthenticatedProducer | null;   // uniform null on ALL failures
  authorize(p: AuthenticatedProducer, sig: { kind: string; conditionClass?: string; subject: string }): ScopeDenial | null;
}
```

v2 migration statements: the `producers` DDL from the design doc §B, plus `CREATE INDEX idx_producers_credential ON producers (credential_hash)`.

Implementation notes (constraints, not prose): secrets = `randomBytes(32).toString('base64url')`; stored as `sha256:<hex>` via a module-local digest of the plaintext; `exchangeEnrollmentSecret` clears `enrollment_secret_hash` on BOTH success and failed-attempt-with-correct-id? — NO: single-use means it is cleared exactly when a well-formed exchange attempt matches the hash (success) or when expired (lazily on any attempt); a wrong secret does not burn it (an attacker must not be able to deny enrollment), but three consecutive mismatches for the same producer clear it fail-closed (bounded guessing). `authenticate` checks: status enabled, hash match on live (unexpired) or prev (within `prev_expires_at`); every failure → `null`.

- [ ] Steps: failing tests first (registration/exchange/single-use/expiry-clamp/rotation-overlap/revocation/uniform-null/authorize matrix — one `it` per behavior, ~12 tests, real assertions on returned credentials authenticating successfully), run red, implement, run green (`producers.test.ts` + full incidents dir), commit (`feat(incidents): add producer registry with enrollment and credential lifecycle`).

---

### Task 3: Store `invalid` split (400 vs 422 without string matching)

**Files:** Modify `src/fleet/incidents/store.ts`; test additions in `tests/fleet/incidents/store-accept.test.ts`.
**Interfaces:** `AcceptResult` invalid variant becomes `{ outcome: 'invalid'; malformedJson: boolean; errors: string[] }`. `malformedJson` is `true` exactly when `JSON.parse(rawBody)` threw in `acceptSignal`.
- [ ] Failing tests: `store.acceptSignal('{not json', ...)` → `invalid` with `malformedJson: true`; a JSON body violating the envelope → `invalid` with `malformedJson: false`. Run red (property absent), implement (thread a boolean from the catch; `parseSignalEnvelopeValue(undefined)` already reports schema errors for the malformed case — set `errors: ['body is not valid JSON']` there), run green, commit (`feat(incidents): distinguish malformed JSON from schema violations in AcceptResult`).

---

### Task 4: Signals route module — body guards, outcome mapping, limiter

**Files:**
- Create: `src/fleet/routes/signals.ts`
- Test: `tests/fleet/routes/signals.test.ts`

**Interfaces:**
- Consumes: `IncidentStore`/`AcceptResult` (Plan 1 + Task 3), `ProducerStore` (Task 2), `jsonResponse`/`readBody`/`extractBearer` from `src/lib/http.ts`.
- Produces (Task 6 wires these):

```ts
export interface SignalsDeps {
  getIncidentStore: () => IncidentStore | null;   // null => 503 (degraded per spec §1)
  getProducerStore: () => ProducerStore | null;
  now?: () => Date;                                // default () => new Date(); injectable for tests
  rateLimit?: { windowMs: number; maxPerWindow: number };  // default 60_000 / 60
}
export function createSignalsHandlers(deps: SignalsDeps): {
  postSignal(req: IncomingMessage, res: ServerResponse): Promise<void>;
}
export const SIGNALS_BODY_LIMIT_BYTES = 32 * 1024;
```

Handler order (each step returns a response and stops): stores null → 503 `{error:{code:'incident_store_unavailable',retryable:true,...}}` · `content-encoding` header present → 415 `unsupported_content_encoding` · content-type not `application/json` (parameters allowed) → 415 `unsupported_media_type` · read body with `SIGNALS_BODY_LIMIT_BYTES` (readBody over-limit → 413 `body_too_large`) · `extractBearer` absent → 401 `credential_required` · `producerStore.authenticate` null → 401 `credential_invalid` · rate limiter over budget for this producerId → 429 `rate_limited` + `Retry-After` seconds · pre-authorization: cheap JSON sniff of `kind`/`conditionClass`/`subject` from the raw body is NOT done — instead call `acceptSignal` only after `authorize` runs on the parsed envelope; to avoid double-parsing, `authorize` runs AFTER `acceptSignal` returns?? — NO: authorization must precede storage (a signal outside scope must not enter the ledger). Resolution: the route parses the body once with `parseSignalEnvelope` (the string wrapper — this is its Plan-2 adoption, resolving the reviewer's classification) for the authorization fields; `invalid` short-circuits to 400/422 using `malformedJson`; `authorize` denial → 403 with the scope reason code; only then `acceptSignal(rawBody, ctx, now())` (byte-stable digest unaffected; the store re-parses internally, accepted cost ~µs per accept, consistent with the parse-once rule holding WITHIN the store). Outcome mapping per design §C incl. `receiptId: 'rcpt-' + receipt.eventId`; `IncidentStoreCorruptError` catch → 503; error with SQLite code `SQLITE_FULL` → 507; any other throw → 503, static message.

Rate limiter: module-level `Map<producerId, {windowStart: number, count: number}>` fixed window, pruned lazily; injectable via deps for tests.

- [ ] Failing tests (~14, handler-level with `node:http` req/res mocks or a local `createServer` harness — follow whichever pattern `tests/fleet/routes/ops.test.ts` uses; real temp-dir stores, never mocks of the stores): 503-when-null, 415 x2, 413, 401 x2, 403 per denial reason, 400 vs 422, 201 receipt shape + `receiptId`, 200 replay + header, 409, 429 + Retry-After, 507 on injected SQLITE_FULL. Run red, implement, run green, commit (`feat(incidents): add POST /api/signals with the §3 outcome taxonomy`).

---

### Task 5: Producer admin routes (root-gated)

**Files:** extend `src/fleet/routes/signals.ts` (same deps object; admin handlers) + `tests/fleet/routes/signals-admin.test.ts`.
**Interfaces:** `createSignalsHandlers` additionally returns `postProducer`, `postProducerCredential`, `deleteProducerCredential`; deps gains `verifyRootToken: (req: IncomingMessage) => boolean` (Task 6 wires it to the index-layer fleet-token verification; tests inject a fake).
Behavior: `postProducer` — root only (else 401); zod-validate registration input (bounded ids per Plan 1 conventions; kinds ⊆ SIGNAL_KINDS); conflict → 409 `producer_exists`; success → 201 `{ producerId, enrollmentSecret, enrollmentSecretExpiresAt }` (the ONLY response ever containing the secret). `postProducerCredential` — body `{ enrollmentSecret }` → exchange path; or `Authorization: Bearer <current credential>` with empty body → rotation; uniform 401 on any failure of either path; success → 201 `{ producerId, credential, credentialExpiresAt }` (the ONLY response ever containing the credential). `deleteProducerCredential` — root only; 204; idempotent.
- [ ] Failing tests (~8: root gate both directions, register+conflict, secret-single-use over HTTP, exchange→authenticate round trip against `postSignal`, rotation keeps old credential working within overlap, revoke kills both), red → implement → green → commit (`feat(incidents): add root-gated producer enrollment and credential routes`).

---

### Task 6: Server wiring + guard graduation

**Files:**
- Modify: `src/fleet/index.ts` (ROUTES entries + startup store construction + handler dispatch; READ the local `RouteKey`/handler-registration pattern first and follow it exactly)
- Modify: `tests/scripts/orphan-reachability-guard.test.ts` (REMOVE the four `src/fleet/incidents/*` `TRACKED_UNREACHABLE` entries — the stale-check forces this once wiring lands)
- Modify: `scripts/lib/durability-status-registry.ts` (add `producers` to `SELF_PROVISIONED` with justification: `status` is an admin enable/revoke flag whose transitions are operator actions recorded by Plan 4's audit surface, not a #1789 lifecycle-with-terminal-failure column; module `src/fleet/incidents/schema.ts`)
- Modify: `tests/scripts/durability-writer-guard.test.ts` (pinned inventory 10 → 11, title update)

ROUTES additions (regex idiom of the existing table):

```ts
  { method: 'POST',   path: /^\/api\/signals$/, handler: 'postSignal' },
  { method: 'POST',   path: /^\/api\/producers$/, handler: 'postProducer' },
  { method: 'POST',   path: /^\/api\/producers\/(?<id>[^/]+)\/credential$/, handler: 'postProducerCredential' },
  { method: 'DELETE', path: /^\/api\/producers\/(?<id>[^/]+)\/credential$/, handler: 'deleteProducerCredential' },
```

Startup: construct once, fail-open to degraded — `try { const db = openIncidentDb(defaultIncidentDbPath()); incidentStore = new IncidentStore(db); producerStore = new ProducerStore(db); } catch (err) { log corrupt/unavailable; both remain null; }` — the fleet server continues serving non-incident routes (spec §1 degraded mode). Producer-credential routes authenticate via `ProducerStore`; `verifyRootToken` wires to the same fleet-token check the existing mutating routes use (read `src/fleet/index.ts:790-910` region for the exact helper).

- [ ] Steps: red = run `tests/scripts/orphan-reachability-guard.test.ts` AFTER wiring but BEFORE graduating entries (stale-check must fail, proving enforcement) → graduate entries → guard suites + full incidents+routes suites + `typecheck:all` green → commit (`feat(incidents): wire the ingestion surface into the fleet server` + Evidence naming the stale-check red run).

---

### Task 7: Whole-branch verification

- [ ] `npm test -- tests/fleet/incidents tests/fleet/routes/signals.test.ts tests/fleet/routes/signals-admin.test.ts tests/scripts/orphan-reachability-guard.test.ts tests/scripts/orphan-export-guard.test.ts tests/scripts/durability-writer-guard.test.ts` → all green; `npm run typecheck:all` exit 0 (pipefail).
- [ ] Full suite `npm test -- --pool=forks` (background OK): failing set must be ⊆ the two known environment-dependent files (console design-lints, shadow-baseline).
- [ ] Docs bookkeeping already committed with the spec; verify `guard:work-index` + `guard:publication:staged` on the final tree.
- [ ] STOP: push is a named hold point — report and await authorization.

## Out of scope (unchanged)

`condition_class_unknown` + `stored_evaluation_faulted` (Plan 3); opaque cursors, principals, operator actions (Plan 4); intents/delivery (Plan 5); real producer clients + spool + #2470 transport (Plan 6); shadow/cutover (Plan 7).
