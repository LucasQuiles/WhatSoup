# Incident Control Plane — Finder Report (Plans 2–7)

**Date:** 2026-07-28
**Scanned baseline:** `origin/main` @ `0e74862f4` (contains the Plan 1 merge, PR #2605)
**Truth sources:** spec `docs/superpowers/specs/2026-07-28-incident-control-plane-design.md`; Plan 1 doc `docs/superpowers/plans/2026-07-28-incident-store-core.md` (its "Out of scope" section); codebase read exclusively via git objects at the scanned SHA.
**Purpose:** pre-implementation completeness map feeding the Plan 2 architecture. EXISTS = skip list; PARTIAL entries name the existing symbol and the remaining delta; MISSING becomes bead scope.

## Headline findings

1. **Bead zero — schema migration mechanism (2b).** `src/fleet/incidents/db.ts` `validateExisting()` is fresh-init-or-reject: any `schema_version` mismatch throws `IncidentStoreCorruptError`; there is no upgrade path. Plans 2/3/4/5 each add tables (producers, policies, notification_intents, principals, delivery_reviews, audit) and Plan 3 adds a ninth disposition (`stored_evaluation_faulted`). Every later schema change is blocked until a versioned-migration mechanism exists. Recommend building it first.
2. **The Plan 1 store is inert by design and verified so:** `IncidentStore`/`openIncidentDb` have zero call sites outside the module and its tests at the scanned SHA (consistent with `TRACKED_UNREACHABLE`; the reachability stale-check forces graduation when Plan 2 wires it).
3. **Naming-collision warnings:** `src/fleet/silence-manager.ts` + `routes/silence.ts` are *instance-level maintenance-window* silencing keyed by instance name — a different entity from spec §5 incident-scoped silences; do not conflate. `tools/agent-runtime-probes/cape_shadow_*` is an unrelated AI-provider comparison harness, not Plan 7 shadow tooling.

## Summary counts

| Plan slice | EXISTS | PARTIAL | MISSING | Total |
|---|---|---|---|---|
| Plan 2 — Ingestion | 0 | 1 | 7 | 8 |
| Plan 3 — Evaluator | 0 | 3 | 6 | 9 |
| Plan 4 — Operator/read | 0 | 3 | 6 | 9 |
| Plan 5 — Delivery | 0 | 1 | 7 | 8 |
| Plan 6 — Producer client | 0 | 3 | 3 | 6 |
| Plan 7 — Shadow/cutover | 1 | 0 | 5 | 6 |
| **Total** | **1** | **11** | **34** | **46** |

## Plan 2 — Ingestion surface (0 EXISTS / 1 PARTIAL / 7 MISSING)

| # | Requirement (spec §3) | Status | Evidence / delta | Action |
|---|---|---|---|---|
| 2a | `POST /api/signals` route + server wiring | MISSING | `ROUTES` (src/fleet/index.ts:341-402) has no entry; store fully unwired | New route + `openIncidentDb()` at startup |
| 2b | Schema migration mechanism | MISSING | db.ts fresh-init-or-reject only | **Bead zero** |
| 2c | Producer registry + enrollment (hashed single-use secret, 10m/30m expiry) | MISSING | No `producers` table. Reuse: `token-storage.ts` `generateFleetToken`/`rotateFleetTokens` hash-once/rotate/bounded-overlap mechanics (right shape, wrong cardinality) | New table + endpoint, port the rotation pattern |
| 2d | Producer credential gate (distinct from root/console/ticket/WhatsApp) | MISSING | `ProducerContext` is caller-trusted; `extractBearer` (src/lib/http.ts:40) reusable; `TicketAudience` lacks a producer audience | New gate: Bearer → validated ProducerContext incl. kind/class/subject scope |
| 2e | Receipt + `AcceptResult`→HTTP mapping | PARTIAL | `acceptSignal` 4-variant union + `SignalReceipt` already match spec's 201 body except top-level `receiptId`; quarantine-as-201 already correct at store level | Map 201/200+`Idempotent-Replay`/409/(400\|415\|422); add `receiptId`; wrap errors in `{error:{code,retryable,message}}` |
| 2f | Body constraints (32 KiB, no compression, one signal/request) | MISSING | `readBody` defaults 64 KiB; no Content-Encoding rejection anywhere | Signals-specific body guard |
| 2g | Error taxonomy 401/403/413/415/429/503/507 + unknown-4xx/5xx split | MISSING | Not represented by `AcceptResult`; 503/507 map cleanly onto existing `IncidentStoreCorruptError`/open-failure paths | Build with 2d/2f |
| 2h | `condition_class_unknown` | MISSING | Needs Plan 3's policy registry to define "known" | **Exclude from first bead** |

**First-bead cut (zero forward dependencies):** 2a, 2b (first), 2c, 2d, 2e, 2f, and the 2g subset excluding `stored_evaluation_faulted`-tied paths. Excluded: 2h.

## Plan 3 — Evaluator (0/3/6)

- 3a PARTIAL: explicit-`now` convention already held by `acceptSignal`; `applyLifecycle` is a hardcoded switch, not policy dispatch. Precedent shape: `decideAuthLossModeEvent` (pure EventInput→Decision).
- 3b MISSING: transitions lack policy/evaluator-version columns; no `notification_intents` table.
- 3c MISSING: `stored_evaluation_faulted` absent from `DISPOSITIONS` + CHECK; no retry-guard table (key: producerId+signalId+payloadDigest+policyVersion+evaluatorVersion, persisted outside the rolled-back txn).
- 3d MISSING: policy registry. Characterization sources: dispatcher.py `_load_inhibition_map`/`_load_transient_sources`/`classify_failure_mode`/`apply_transient_tiering`.
- 3e MISSING: heartbeat streams (cadence/grace/deadline/generation). Port `bot-errors-sentinel.py` `heartbeat_inventory`/`evaluate_host`/`classify_signals` — already implements the §4 six-row matrix against JSON state.
- 3f PARTIAL: `ssh_runtime_probe` reusable; rehost under a controller-owned producer identity once 2c/2d exist.
- 3g MISSING: correlation/inhibition/storms (dispatcher.py `symptom_source_matches`/`coalesce_relay_recovered` = migration inputs).
- 3h MISSING: durable timers with transactional claim+apply.
- 3i PARTIAL: fail-closed corruption posture exists at open time; extend to evaluator-cycle failures once 3h exists.

## Plan 4 — Operator/read surface (0/3/6)

- 4a PARTIAL: store-layer reads cover 3 of 6 endpoints; zero HTTP routes; `afterIncidentId` is a transparent integer (spec wants opaque cursors); missing filters need ack/silence entities.
- 4b/4c MISSING: no actorId/role anywhere (`ConsoleSessionStore.issue()` returns `{sessionId, expiresIn}`); root-token carve-out needs 4b first.
- 4d PARTIAL: `projection_version` exists and is exposed; no conditional read/write path (no CAS).
- 4e MISSING: step-up (tickets are audience-scoped, not target-bound).
- 4f MISSING with schema headroom: `actor_type` CHECK already permits operator/override, `closed_by_override` already in state CHECK — zero writers. **Do not conflate with instance-level `silence-manager.ts`.**
- 4g MISSING: delivery reviews — blocked on Plan 5 tables.
- 4h MISSING: audit table; fold into 4d's mutation helper.
- 4i PARTIAL: `WsInvalidationEvent` union is 7 instance-scoped kinds; publisher/poller plumbing directly reusable; add 3 incident kinds carrying `{objectId, projectionVersion, cursor}`.

## Plan 5 — Delivery execution (0/1/7)

- 5a-5d MISSING: intents/attempts tables (transitions = causal anchor per Plan 1 doc), claim-loop worker, relevance fencing, retry/dead-letter/adapter-health.
- 5e PARTIAL: `handleSend` (routes/ops.ts:85) is the named existing WhatsApp send path; adapter should call the underlying capability, not the HTTP route.
- 5f MISSING: no email transport anywhere in src/ or deploy/scripts/.
- 5g MISSING: rendering boundary; discipline precedents `redactBotErrorsText`, `BotErrorsCriticalAssetDiagnostic` field shape.
- 5h MISSING: silence-at-claim — after 4f.

## Plan 6 — Producer client + spool (0/3/3)

- 6a PARTIAL: `publish_heartbeat` (selfcheck.py) POSTs but fire-and-forget — no spool/idempotency/retry (the #2470 sender).
- 6b MISSING: byte-exact spool; primitives ready in `private-fs.ts` (`writeAtomicPrivateFileSync`/`appendPrivateJsonLineSync`); quarantine precedent `quarantine_untrusted_entry`.
- 6c PARTIAL: `central_ack_inventory`/`publish_central_down_alert` = receipts-not-reachability precedent; generalize to spec's field set.
- 6d PARTIAL: `deploy/bot-errors-deadman.{service,timer}` exists for the legacy model; retarget or parallel-build.
- 6e MISSING: transport policy (TLS pinning, no-redirect, bounded reads — #2470).
- 6f MISSING: causal-order reconnection replay.

## Plan 7 — Shadow/cutover (1/0/5)

- 7a MISSING deliverable; rich raw material (`classify_failure_mode` et al.) ready for the §4 characterization pass → feeds 3d.
- 7b MISSING: shadow harness (cape_shadow_* is unrelated).
- 7c MISSING: divergence-waiver register (issue-linked).
- 7d EXISTS (correct pre-cutover state): legacy JSON incident state remains the live authority until per-class cutover — sequencing constraint, no action.
- 7e MISSING correctly: collector/outbox decommission is the terminal action.
- 7f: real-data acceptance is a definition-of-done template on every cutover bead, not a bead.

## Carried-forward review notes (from the post-merge quality passes)

- `events.payload_json` has no retention/compaction story; `quick_check`-on-every-open is O(db size) — both "revisit when wired" (Plan 2/3).
- `parseSignalEnvelope` string wrapper risks permanent test-only status — Plan 2 adopts it at the ingestion surface or folds it into tests.
- Guard backlog: SELF_PROVISIONED discovery coverage is name-keyed; the incident tables introduced the first generic names (`meta`, `events`) — keying by (table, module) would close the piggyback window.
- Repo-wide consolidation candidate (outside this lane): ~6–8 inline bare-hex sha256 digest sites would serve from one `sha256Hex()` helper in src/lib.
