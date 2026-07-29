# Incident Control Plane — Plan 2 Design: Ingestion Surface

**Date:** 2026-07-28
**Status:** Approved interactively by the owner (admin surface = root-gated HTTP endpoints).
**Parent contract:** `docs/superpowers/specs/2026-07-28-incident-control-plane-design.md` §3 (locked) — this document designs only the deltas §3 leaves open, plus the cross-cutting bead zero surfaced by the Finder map (`docs/superpowers/handoffs/2026-07-28-incident-control-plane-finder-report.md`).
**Baseline:** `origin/main` @ `b7a4906a7` (contains PRs #2605, #2607).
**Scope:** Finder items 2a–2g (first-bead cut). Excluded: 2h `condition_class_unknown` and `stored_evaluation_faulted` paths (Plan 3), rate-limit tuning beyond a minimal limiter.

## A. Bead zero — schema migrations

`src/fleet/incidents/schema.ts` moves from a single DDL list to numbered migrations, mirroring the `src/core/database.ts` convention:

```ts
export interface IncidentMigration { version: number; statements: readonly string[] }
export const MIGRATIONS: readonly IncidentMigration[]  // v1 = Plan 1 DDL verbatim; v2 = producers table
export const INCIDENT_SCHEMA_VERSION  // = max migration version
```

`openIncidentDb` behavior:

- Fresh/empty file → apply all migrations, each in its own `BEGIN IMMEDIATE` transaction that also sets `meta.schema_version` to that migration's version (DDL + version bump are atomic; a crash mid-sequence resumes at the next open).
- Existing file at version `< max` → `PRAGMA quick_check` first, then apply the missing migrations the same way.
- Existing file at version `> max` → `IncidentStoreCorruptError` (`state_recovery_required`). Never downgrade, never re-init — unchanged fail-closed posture.

No deployed database predates this mechanism (the store shipped unwired), so v1→v2 is exercised by tests, not by production data.

## B. Producer registry and enrollment

**Table (migration v2), self-provisioned** (gets a `SELF_PROVISIONED` registry entry + anti-dodge justification — `status` is status-shaped):

```sql
CREATE TABLE producers (
  producer_id TEXT PRIMARY KEY,
  producer_domain_id TEXT NOT NULL,
  allowed_kinds TEXT NOT NULL,              -- JSON array of SignalKind
  allowed_condition_classes TEXT NOT NULL,  -- JSON array; exact match
  allowed_subjects TEXT NOT NULL,           -- JSON array; exact match
  status TEXT NOT NULL CHECK (status IN ('enabled', 'revoked')),
  credential_hash TEXT,                     -- sha256:<hex> of the live credential
  credential_expires_at TEXT,
  prev_credential_hash TEXT,                -- bounded rotation overlap (spec §3)
  prev_expires_at TEXT,
  enrollment_secret_hash TEXT,              -- single-use, hashed at rest
  enrollment_secret_expires_at TEXT,        -- default now+10min, hard max 30min
  created_at TEXT NOT NULL
) STRICT
```

**Module `src/fleet/incidents/producers.ts`** — `ProducerStore` over the same `DatabaseSync` handle, every method taking explicit `now: Date` (house rule from Plan 1):

- `register(input, now)` → creates the row (status `enabled`) + returns the one-time plaintext enrollment secret (32 random bytes, base64url). Re-registering an existing `producer_id` is a conflict.
- `exchangeEnrollmentSecret(producerId, secret, now)` → verifies hash + expiry + unused; mints the producer credential (plaintext returned once, sha256 stored), clears the enrollment secret. Single-use: any outcome consumes it.
- `rotateCredential(producerId, currentCredential, now)` → new credential; the old hash moves to `prev_credential_hash` with `prev_expires_at = now + overlap` (default 24 h).
- `revoke(producerId)` → status `revoked`, credential hashes cleared.
- `authenticate(bearer, now)` → sha256(bearer) matched against live hash (or prev within overlap) of an `enabled`, unexpired producer → `AuthenticatedProducer { producerId, producerDomainId, allowedKinds, allowedConditionClasses, allowedSubjects }`; every failure mode returns the same `null` (the HTTP layer answers 401 without disclosing which check failed).
- `authorize(producer, envelope-ish)` → scope check: kind ∈ allowedKinds; for condition kinds, conditionClass ∈ allowedConditionClasses; subject ∈ allowedSubjects. Returns a bounded reason code for 403.

Credential/secret hashing reuses the module-local `sha256:<hex>` digest form already used for payloads. Randomness via `node:crypto` `randomBytes` (not seeded/derived — these are secrets, not test fixtures).

## C. Ingestion and admin routes

**Module `src/fleet/routes/signals.ts`**, registered in the `ROUTES` regex table:

| Route | Auth | Behavior |
|---|---|---|
| `POST /api/signals` | producer credential | body guards → authenticate → authorize → `acceptSignal` → outcome mapping |
| `POST /api/producers` | fleet root token | register + return one-time enrollment secret |
| `POST /api/producers/{id}/credential` | enrollment secret (first issue) or current credential (rotation) | returns plaintext credential once |
| `DELETE /api/producers/{id}/credential` | fleet root token | revoke |

**Body guards (before auth):** `Content-Encoding` present → 415; `Content-Type` not `application/json` → 415; body > 32 KiB → 413 (exact-byte read; the digest is computed over exactly what was read).

**Outcome mapping (locked §3 taxonomy):**

- `accepted` → 201, receipt + `receiptId` derived deterministically from the event id (`rcpt-<eventId>`) — durable and replay-stable by construction, no schema change.
- `idempotent_replay` → 200 + `Idempotent-Replay: true`, original receipt (same derived `receiptId`).
- `identity_conflict` → 409 `{ error: { code: 'signal_identity_conflict', retryable: false, message } }`.
- `invalid` → 400 when the body was not parseable JSON, 422 for schema violations. Additive store change: the `invalid` variant gains `malformedJson: boolean` (set in `acceptSignal` where the parse fails) — no string matching at the HTTP layer.
- `IncidentStoreCorruptError` or store-open failure → 503 `{ retryable: true }`; SQLite `SQLITE_FULL` → 507. Unknown internal errors → 503 (retryable) — never leak exception prose (locked §3).
- Minimal per-producer fixed-window rate limiter (in-memory, default 60 accepts/min, configurable) → 429 with `Retry-After`.

All error bodies use the bounded `{ error: { code, retryable, message } }` shape; messages are static strings, never interpolated internals.

**Server wiring:** the fleet server opens `openIncidentDb(defaultIncidentDbPath())` at startup and constructs `IncidentStore` + `ProducerStore` once; open failure leaves the incident routes answering 503 while the rest of the fleet API serves normally (spec §1 degraded mode). Wiring makes all four `src/fleet/incidents/*` modules production-reachable — the four `TRACKED_UNREACHABLE` entries graduate (the guard's stale-check enforces removal).

## D. Testing and guard obligations

- Migration tests: fresh-create at v2; v1-shaped DB upgrades to v2 preserving rows; version-ahead refuses fail-closed; crash-resume semantics (v1 applied, v2 missing → next open applies v2 only).
- Producer lifecycle tests: register → exchange → authenticate; secret expiry (10 min default, 30 min cap enforced at register); single-use secret; rotation overlap window honors `prev_expires_at`; revocation kills both hashes; uniform `null` on every auth-failure mode.
- Route tests (real store on temp dirs, handler-level per repo idiom): full outcome mapping incl. replay-after-lost-response; body-guard matrix (413/415); auth matrix (401 vs 403 causes); 429 window; root-gated admin routes reject producer credentials and vice versa.
- Guard bookkeeping in the same change: remove the four `TRACKED_UNREACHABLE` entries; add `producers` to `SELF_PROVISIONED` with justification; publication-audit + work-index rows for this spec and its plan (work-index regen runs **after** `git add`, per the tracked-files-only scanner).
- Deferred (unchanged from parent spec/Finder): `condition_class_unknown` (Plan 3), `stored_evaluation_faulted` (Plan 3), opaque list cursors and operator surfaces (Plan 4), delivery (Plan 5), real producer clients (Plan 6) — real-data acceptance rides #1876 at rollout.

## E. Audit remediation amendments (2026-07-29)

An independent implementation audit against the PR #2610 head produced verified findings; the following contract deltas are binding and implemented on the same branch:

- **Exact-byte idempotency.** The idempotency digest is SHA-256 over the exact request bytes, never over decoded text. `readBodyBytes` (shared `src/lib/http.ts`) accumulates Buffer chunks and concatenates once; `readBody` delegates to it, fixing per-chunk decode corruption of split multibyte characters for every consumer. The signal route and `IncidentStore.acceptSignal(string | Uint8Array)` decode with `TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`: invalid UTF-8 and BOM-prefixed bodies are 400 `malformed_request` and are never stored. The store persists the decoded text it parsed; digests always cover the original bytes.
- **Causal lifecycle guards.** A recovery with `occurrenceSeq <= last_occurrence_seq` is state-inert, disposition `stored_stale_observation` with the episode's incident id (no new disposition value — the wire taxonomy and the SQLite CHECK stay closed). A new occurrence supersedes open episodes only when its `observedAt` is strictly greater than every open episode's `last_observed_at`; equal-or-older cross-occurrence observations are state-inert and open no episode. Same-occurrence updates advance `last_occurrence_seq` unconditionally but `last_observed_at` is advance-only (`MAX`), so projected freshness never regresses.
- **Producer lifecycle hardening.** `enrollmentTtlMs` must be a finite positive integer (still clamped at 30 minutes); the ignored `credentialTtlMs` registration field is removed. Rotation overlap ends at `min(old credential expiry, now + overlap)` — rotation never extends a retired credential's lifetime. Producer security actions (register, revoke, failed enrollment with closed internal reason vocabulary `no_active_enrollment | enrollment_expired | secret_mismatch | enrollment_burned`) emit bounded audit events through the mandatory `SignalsDeps.securityAudit` sink (wired to the fleet logger); external HTTP failures stay uniform and the events never carry secrets.
- **Database ownership.** The fleet server owns the incident DB handle: `start()` probes it exactly once (open failure logs and degrades the incident routes to 503 without affecting the rest of the fleet), `stop()` closes it exactly once, and the closed state is terminal — a stopped server cannot reopen it. `ProducerStore` has no `close()`; the owning aggregate is the only closer.
- **Response-schema exception (#2517/#2612).** The incident surface keeps this spec's locked §3 error envelope (`{ error: { code, retryable, message } }`, closed codes, static messages). The fleet-wide `response-error` projection landed after this spec was locked and is not yet adopted by any route; converging the incident surface onto it is a named follow-up under #2517 and no equivalence is claimed.
- **Production constraint.** Per-condition metadata allowlists, raw-event retention, and recovery-proof acceptance policy remain Plan 3 scope. Until Plan 3 closes them, this surface is alpha: **no production producer enrollment or rollout is authorized.**
