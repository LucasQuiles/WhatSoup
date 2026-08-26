# Fleet Lifecycle Observability Standard — design v5 (DRAFT for final approval)

Status: draft. The v4 revision PASSED the independent contradiction/privacy/cardinality review
(no blockers; privacy: no findings). v5 folds in the review's seven residual MINOR/NOTE
findings (N1–N7, changes below). Pending owner final approval. Implementation is NOT
authorized by this document; an implementation plan follows approval.

Scope: all WhatSoup fleet runtimes and hosts. The local agent-harness estate is a separate
operational domain and is not governed by this standard; every contract is domain-portable
(versioned schemas, no WhatsApp-specific field names in core contracts) so other domains may
adopt it later by their own decision.

Normative words: MUST / MUST NOT / SHOULD / MAY.

## v3 → v4 changes (adversarial-review resolutions; F-numbers = review findings)

1. F1: conditions and violations are no longer conflated. §3 defines a **closed condition-class
   registry** — violation classes `V1–V8` plus non-violation classes `P1` (solitary stall),
   `U1` (unclassified work), `D1` (ambiguous delivery), `S1` (SLO breach). Every mandated
   condition now has a legal class; metrics, fingerprints, and promotion phases reference the
   full registry.
2. F2: the deadman chain's terminal tier is now an **active absence-detected heartbeat** with a
   registered human consumer, and the two alert channels supervise **each other**, never
   themselves. C6 walks the full chain including tier 5.
3. F10: exported digests MUST be **keyed** (HMAC, per-fleet secret, versioned key id);
   unkeyed hashes of identifiers are nonconformant. New conformance fixture C8 tests it.
4. F11: the per-host **freshness surface is an exported surface** under §7; `last_result` is a
   closed enum; the text/name/credential ban is global to every surface.
5. F3/F14: metric label dimensions form a **closed registry** with enumerated value sets,
   including `kind`.
6. F4: delivery is a closed **five**-state axis (`proved | suppressed | failed | ambiguous |
   not_applicable`); `proved` means echo-evidenced only.
7. F5: release semantics are defined **per lane**; non-queue lanes declare `queue: none` at
   admission and the release term is then satisfied by their `finalized` event — nothing
   silently skips settlement.
8. F6: protected roots are exempt from time-based expiry while OPEN; the 90-day rule applies to
   closed records only.
9. F7: recovery predicates are defined **per condition class**, including the meta classes.
10. F8: the paging table covers every condition class.
11. F9: `attrs` admits enum / int / registered keyed-digest fields; manager identity =
    `manager_generation` (int) + keyed `manager_digest`.
12. F12: fixture derivation scripts MUST contain no production identifiers or timestamps
    (private uncommitted selector config; committed fixtures use a shifted synthetic timebase).
13. F13/F15: **condition identity is fixed normatively** to a bounded scope; per-work-unit or
    per-chat condition identity is nonconformant.
14. F16: a hard storage ceiling stops evidence writes before disk exhaustion; the runtime never
    dies from evidence growth.

## v4 → v5 changes (residual-finding resolutions)

15. N1: the paging table covers V3's non-interactive subcase explicitly.
16. N2: `condition.v1` gains an optional `slo_id` field; `slo_id` is a legal scope for `S1`.
17. N3: the error-code registry is defined with its initial closed member set.
18. N4/N7: a normative aggregation rule bounds scopes in per-chat-queue cohorts and for
    user-created triggers — scope counts are bounded by operator configuration, never by user
    behavior.
19. N5: `suppressed` added to `D1`'s recovery resolutions.
20. N6: runtime admission behavior past the disk-safety margin is defined (availability wins;
    the degradation is itself declared).

## 1. Domain model — work lanes

Every unit of runtime work belongs to exactly one lane:

| Lane | Meaning | Queue-mediated |
|---|---|---|
| `L-INT` | interactive turns | yes |
| `L-SCH` | scheduled jobs | yes |
| `L-CTL` | control/system work (incidents, config, maintenance) | no (declares `queue: none`) |
| `L-REC` | recovery activity (always carries `origin_lane`) | yes |
| `L-PRB` | provider probes | no (declares `queue: none`) |
| `L-OUT` | outbound-only operations | no (declares `queue: none`) |

Lane is a required dimension on every event, metric, and condition. A runtime MUST classify all
work; unclassifiable work is tagged `lane=unclassified` and raises a **`U1` condition** — it
never silently disappears from observability.

`L-REC` events and conditions MUST carry `origin_lane` (the lane of the obligation being
recovered) so fleet analysis never loses which class of work an obligation came from.

Queue mediation is declared at admission (`queue: <queue-scope> | none`). The declaration is
mandatory; omitting it is nonconformant. It determines which settlement form applies (§3).

## 2. Contract E — lifecycle events and correlation (`event.v1`)

Canonical envelope (versioned; additive-only within a major):

```json
{
  "schema": "whatsoup.lifecycle.event.v1",
  "instance": "…", "host": "…",
  "lane": "L-SCH", "origin_lane": "L-INT|null",
  "work_id": "…",
  "correlation": {
    "trigger_occurrence_id": "…", "inbound_seq": 0, "logical_turn_id": "…",
    "session_id": "…", "outbound_op_id": "…", "generation": 0
  },
  "phase": "released",
  "at_utc": "…",
  "attrs": { "closed": "enum, int, or registered keyed-digest fields only" }
}
```

Phases (closed set): `admitted`, `dispatched`, `acknowledged`, `progress`, `tool_effect`,
`terminal_result`, `finalized`, `delivered`, `suppressed`, `released`, `recovery_claimed`,
`recovery_completed`, `reclaimed`, `abandoned`.

Rules:

- Every phase event MUST carry the correlation keys that exist at that point.
- **`released` is a durable, generation-fenced event** for queue-mediated lanes: written by the
  queue owner with `correlation.generation` plus `attrs.manager_generation` (int) and
  `attrs.manager_digest` (keyed digest, §7), persisted in the event store; it is the only
  admissible evidence of queue release. Transient runtime state (an empty queue observed over
  health) MUST NOT substitute for it. A `released` event whose generation does not match the
  current owner generation is a `V2` condition.
- For `queue: none` lanes, the settlement release term is carried by that lane's `finalized`
  event, written by the owning executor with the same generation fields. The lane MUST still
  emit `finalized`; nothing settles without a durable event.
- Lifecycle completion is decided only by JOINED evidence under §3 — no single field (HTTP
  status, occurrence state, session status, terminal row) is completion proof.

Privacy: `event.v1` records are **private retained events** (on-host store, §10) — the only
surface that may carry raw correlation identifiers. The global content ban (§7) applies to
them too: no message text, contact names, or credentials anywhere.

## 3. Contract S — five axes, settlement, and the condition-class registry

For every work unit, five independent axes MUST be derivable:

1. **Liveness** — the owning process/queue accepts work.
2. **Progress** — monotonic age since the unit's last phase event.
3. **Terminalization** — the durable work row reaches a terminal status with a reason.
4. **Delivery** — closed five-state axis: `proved | suppressed | failed | ambiguous |
   not_applicable`. `proved` requires echoed outbound evidence; `suppressed` requires an
   explicit policy-suppression proof. **`ambiguous` never satisfies a completion predicate**;
   past its bound it raises a **`D1` condition**.
5. **Recovery/ownership** — for any unit that failed or was interrupted: a recovery obligation
   exists, is claimed under a fenced generation, and reaches `recovery_completed` with proof,
   OR the obligation is explicitly assigned to an operator (durable operator-ownership
   record). Obligations without an owner are **`V7` conditions**, not history.

**Safe settlement predicate (all lanes):** a unit is settled only when

```
durable release evidence
  (queue-mediated lane: generation-fenced `released` event;
   queue:none lane:     generation-fenced `finalized` event)
AND ( successful completion for its lane
      OR explicit recovery ownership (L-REC chain or operator-ownership record) )
```

A terminal row alone — including `failed` — is NOT settlement. Per-lane successful completion:

- `L-INT`: terminalized AND delivery ∈ {`proved`, `suppressed`}.
- `L-SCH`: occurrence terminal AND linked inbound terminal AND `released` within the job's
  deadline bound (§4).
- `L-REC`: `recovery_completed` with completion proof, no echo conflict, `origin_lane` intact.
- `L-CTL` / `L-PRB`: terminalized with reason.
- `L-OUT`: terminalized AND delivery ∈ {`proved`, `not_applicable`}.

**Condition-class registry (closed; the only legal values of `class` anywhere):**

| Class | Kind | Meaning |
|---|---|---|
| `V1` | violation | shallow success — outer unit terminal while a joined unit is unsettled past bound |
| `V2` | violation | release/fencing fault — reclaim without durable release, or generation mismatch |
| `V3` | violation | shared fate — other-lane work queued behind a held unit past bound |
| `V4` | violation | false green — liveness green, progress age past bound, work queued behind |
| `V5` | violation | self-echo amplification — own outbound re-admitted as response-worthy inbound |
| `V6` | violation | observer fault — freshness breach, emitter failure, stale-wrong reporting |
| `V7` | violation | unowned obligation — failed/interrupted work with no recovery or operator owner |
| `V8` | violation | storage pressure — evidence budget exceeded with protected roots at risk |
| `P1` | condition | solitary stall — a unit unsettled past bound with nothing queued behind it |
| `U1` | condition | unclassified work admitted |
| `D1` | condition | delivery `ambiguous` past bound |
| `S1` | condition | SLO breach; carries `slo_id` (`condition.v1` field, §4 registry) |

Adding a class is a minor version bump of `condition.v1` and of the `class` label registry —
the set is closed at any given version; implementers MUST NOT invent classes.

## 4. Contract M — bounded metrics and SLOs

Metric names are versioned (`whatsoup_m1_*`).

**Label registry (closed).** Global dimensions available to every metric: `instance` (fleet
roster), `lane` (§1 enum + `unclassified`), `class` (§3 registry). Per-metric dimensions, each
with a closed value set defined here: `state` (delivery five-state enum), `origin_lane` (lane
enum), `observer` (registered `observer_id`s, bounded by the §6 registration set),
`kind` ∈ {`event`, `rollup`, `condition_closed`, `witness_expired`}. No other label dimension
or value is conformant. Raw identifiers never appear in labels.

Core set: `m1_lifecycle_state{lane}` · `m1_settlement_seconds{lane}` (histogram) ·
`m1_progress_age_seconds{lane}` · `m1_unsettled_count{lane}` /
`m1_unsettled_oldest_seconds{lane}` · `m1_queue_depth_behind_held` ·
`m1_conditions_total{class}` · `m1_delivery_state_total{state}` ·
`m1_recovery_open{origin_lane}` · `m1_observer_age_seconds{observer}` ·
`m1_release_ancestry_ok` · `m1_evidence_dropped_total{kind}` · `m1_storage_bytes`.

**SLO registry (closed; `slo_id` values):**

- `slo.sch.settlement` — per-trigger: the job's configured deadline plus reconciliation grace
  (default grace 5 min). No universal wall-clock number.
- `slo.int.terminalization` — p99 < 10 min.
- `slo.mttd` — condition MTTD < 10 min.
- `slo.observer.freshness` — < 2× declared cadence.

An SLO breach raises an `S1` condition carrying its `slo_id`. Adding an SLO is a minor bump of
this registry.

## 5. Contract C — conditions, incidents, recovery, and paging

A condition is durable and deduplicated:

```
{schema:"whatsoup.condition.v1", instance, lane, origin_lane?, class, slo_id?,
 scope_digest, first_seen, last_seen, count, evidence_digests[bounded]}
```

`slo_id` is present exactly when `class = S1` (N2), drawn from the §4 SLO registry.

**Condition identity (normative, F13/F15):** `(instance, lane, class, scope_digest)`.
`scope_digest` is the keyed digest (§7) of the narrowest **stable configuration scope** — a
queue scope, an operator-registered trigger id, an observer id, a store name, or (for `S1`)
the `slo_id` itself. Work ids, session ids, chat/user identifiers, and timestamps are NOT
scopes; a condition keyed on any of them is nonconformant.

**Scope aggregation rule (N4/N7):** where a cohort derives queues from chats or users
(sandbox-per-chat workspaces, per-chat queues) the conformant scope is the **queue class**
(one scope per `instance × lane × queue-class`, e.g. `workspace-queues`), never the individual
per-chat queue. Likewise, user-created triggers aggregate into the single `user-triggers`
scope; only operator-registered triggers may be individual scopes. Scope counts are therefore
bounded by operator configuration (registered queue classes + registered triggers + observers
+ stores + SLO ids) and MUST NOT grow with user behavior. A mass failure produces ONE
condition per scope with a rising `count`, never a per-unit flood, and dedup state is bounded
by that same configuration set.

Incident rules: a condition sustained past its bound opens exactly one incident; stale-wrong
reporting (green/red contradicted by live evidence) is itself `V6`.

**Recovery predicates (per class, F7):** evidence-based, never timer-based.

- Work-unit classes (`V1 V2 V3 V4 V5 V7 P1 D1`): the referenced scope has no unit violating
  the class predicate — for `V7`, every obligation in scope is owned or completed; for `D1`,
  delivery resolved to `proved`/`suppressed`/`failed`/`not_applicable` (a `failed` resolution
  then falls under `V7` rules until owned; `suppressed` is normally decided pre-send, so an
  ambiguous→suppressed resolution is expected to be rare but is legal, N5).
- `U1`: the work is reclassified into a lane.
- `V6`: the observer publishes a fresh success within its declared cadence.
- `V8`: storage back under budget with all protected roots intact.
- `S1`: the SLO metric back within target for one full evaluation window.

**Paging table (complete, F8):**

| Condition | Tier |
|---|---|
| `V3` with `L-INT` queued behind (blocking users) | page ≤ 2 min |
| `V1`, `V2`, `V3` (only non-interactive lanes queued behind), `V4`, `V5` | page ≤ 10 min |
| `P1` (solitary background stall) | warn 5 min, page 10 min |
| `V6`, `V7`, `V8` | page ≤ 15 min (meta-failures of the safety net) |
| `U1`, `D1` | warn ≤ 15 min, page ≤ 30 min |
| `S1` | warn on open; page only if sustained one full window |

## 6. Contract F — registered observers, freshness, and the deadman chain

Only **registered observers** carry freshness obligations. Registration is a fleet-config
record: `{observer_id, host, declared_cadence, owner, escalation}`. Ad-hoc or manual
supervision passes are NOT freshness obligations and MUST NOT appear in the mandatory observer
set; a manual practice that matters is promoted to a **registered** observer with a declared
cadence and owner — including the human tier below.

Every registered observer (stuck-inbound sweep, reply-guarantee, drift/currency checks,
watchdogs, incident reporters, this standard's derivation job) publishes
`{observer_id, last_success_utc, last_result, error_code?}` to one freshness surface per host.
The freshness surface is an **exported surface** under §7: `observer_id` from the registration
set, timestamps, `last_result` ∈ {`ok`, `fail`, `inconclusive`}, `error_code` from the
error-code registry. Free text is nonconformant (F11).

**Error-code registry (closed; initial members, N3):** `none`, `timeout`, `io_error`,
`auth_error`, `schema_error`, `dependency_unavailable`, `resource_exhausted`, `internal`.
Additions are a minor bump of this registry (§13); codes MUST describe failure mechanics,
never subjects — a code naming a chat, user, host path, or work unit is nonconformant.

**The deadman chain, named end to end (F2):**

1. **Runtime emitters** (per instance) — emit `event.v1`; covered by
2. **On-host meta-observer** (registered, per host) — alerts on any registered observer age >
   2× cadence; covered by
3. **Off-host fleet poller** (registered, fleet host) — polls every host's freshness surface
   and health; a silent host is `V6`; covered by
4. **Cross-host poller supervisor** (registered, on a different host than the poller) — checks
   the poller's published freshness and raises the alert path directly if stale; covered by
5. **Terminal heartbeat tier (absence-detected):** tier 4 emits a **positive heartbeat** (an
   "all-clear or N conditions open" email to the owner mailbox) every declared cadence
   (default: daily). Detection at this tier is by ABSENCE: a missing heartbeat — which a total
   collapse of tiers 1–4 produces — is itself the alarm. The heartbeat's consumer is the
   **fleet owner as a registered observer**: `{observer_id: "owner-heartbeat-check",
   declared_cadence: daily, owner: fleet-owner}` — a registered obligation with a declared
   cadence, not ad-hoc supervision. This is the standard's only human tier and it is
   registered precisely so §6's own rule is satisfied.

**Cross-channel supervision (no tier or channel supervises itself):** BOT ERRORS transport
emission failures escalate over EMAIL; email delivery failures (bounces) escalate over BOT
ERRORS. Each channel's failure signal travels on the other channel. The tier-5 heartbeat rides
email; its absence is detected by the registered human check, not by either channel's own
machinery. §12 C6 walks tiers 2–5, including a withheld-heartbeat fixture.

## 7. Contract H — exported surfaces, redaction, and keyed digests

**Exported surfaces (closed enumeration):** metrics (§4), public health (below), dashboards
(§9), alerts (§8), and the per-host freshness surface (§6). The redaction rule binds all five:
aggregates, closed enums, and **keyed opaque digests** only.

**Global content ban (all surfaces, including the private event store):** no message text, no
contact or display names, no credentials, no file paths. Raw correlation identifiers exist
ONLY in the private retained event store (§2, §10).

**Keyed digests (F10):** every exported digest (`scope_digest`, `condition_fingerprint`,
`evidence_digests`, `manager_digest`) MUST be an HMAC over a domain-separation prefix plus the
value, keyed with a per-fleet secret (stored with fleet credentials, never in the repo or on
any exported surface), carrying a versioned key id (`k1:…`) for rotation. Unkeyed or
publicly-derivable hashes of identifiers are nonconformant: fleet identifiers are
phone-number-derived and enumerable, so an unkeyed hash is reversible by dictionary. Operators
with host access re-derive digests via the key to join against the private store; nobody else
can. Conformance fixture C8 tests this property.

Public `/health` adds `{schema:"health.progress.v1", per-lane {unsettled_count, oldest_age_s,
progress_age_s, last_condition:{class, at_utc}?}}` — **current state only**: counts, ages,
enum classes. No history, no identifiers, no digests.

Liveness-only health (HTTP 200 alone) is declared meaningless; consumers treating 200 as
health are nonconformant. The fleet watchdog template MUST consume the progress block once
shipped.

## 8. Contract R — BOT ERRORS routing and deduplication

All alerts route through the existing BOT ERRORS reporting lane; the email channel is the
cross-supervision and terminal-heartbeat path (§6) — no new transport. Every alert line
carries `{instance, lane, class, condition_fingerprint}` where `condition_fingerprint` is the
keyed digest (§7) of the §5 condition identity — bounded by configuration, never per-unit.
Dedup: one line on OPEN, one on tier escalation, one on evidence-based recovery — never
per-tick repeats. Emission failure on either channel is a `V6` condition escalated over the
other channel (§6).

## 9. Contract D — dashboards

- **Console, per instance — current state**: one "Lifecycle" panel consuming
  `health.progress.v1` only: per-lane settlement state, open condition classes, observer
  worst-age. No history is derived from health — health has none.
- **History**: condition/incident/settlement history panels consume bounded metrics (`m1_*`)
  and condition/incident records through the **authenticated fleet API** (the existing
  root-token-authed surface) — never public health, never the private event store directly.
  Records arrive already redacted per §7 (enums, counts, keyed digests).
- **Fleet digest**: one line per instance `{worst lane state, open conditions, observer
  worst-age}` in the existing daily digest (which is also the tier-5 heartbeat carrier, §6).
- Panels are lane- and class-shaped. Instance-specific panels, metrics, or alert policies are
  nonconformant.

## 10. Contract B — retention, protected roots, and budgets

Private event store (per instance, SQLite): default 14 days or 100k rows; **closed**
conditions and incidents: 90 days; metrics: current + 24 h of 5-minute rollups; freshness:
current row only.

**Protected retention roots** — exempt from BOTH drop-oldest AND time-based expiry while OPEN
(F6):

- open incidents and their evidence chains;
- open recovery obligations and operator-ownership records;
- terminal witnesses (the minimal event set proving each unit's settlement) for units inside
  the retention window;
- current-generation evidence (the newest `released`/`finalized`/ownership events per scope).

The 90-day rule starts at CLOSE for conditions and incidents. An obligation can only leave
retention by being owned/completed (recovery predicate, §5) — never by aging out.

Budgets: 64 MiB per instance initial. At ≥80% the writer compacts non-root evidence
(drop-oldest, counted in `m1_evidence_dropped_total{kind}`). If protected roots alone exceed
the budget, the writer MUST NOT delete them — it raises `V8` (paged per §5) and continues.
**Hard ceiling (F16):** at a configured multiple of the budget (default 8× = 512 MiB) the
store stops accepting new NON-ROOT evidence entirely (counted drops, `V8` escalation) and
root writes continue only up to a final disk-safety margin; the evidence store MUST NOT be
the reason a runtime exhausts its disk or dies. Silent truncation of any kind is
nonconformant.

**Past the disk-safety margin (N6):** availability wins by declaration. The runtime keeps
admitting and serving work; all event-store evidence writes stop (counted in memory, flushed
when space returns), while condition/incident records — bounded by configuration — continue;
settlement derivation for the affected window is marked degraded and every
condition raised from it carries `evidence_digests: []`. This state is reachable only after a
`V8` page (≤ 15 min, §5) plus the earlier soft-budget escalation went unanswered — the
degradation is itself the declared, alarmed outcome, never a silent one.

## 11. Contract P — shadow-to-default promotion and rollback

- **Phase S (shadow)**: derivation + private events + freshness ON; alerts computed and
  logged, not routed. Rollout: **mini3 first, alone**; then representative configuration
  cohorts (per-chat non-sandbox, shared, single, sandbox-per-chat; macOS and Linux hosts) for
  **7 days** with the conformance suite passing against live captures.
- **Phase A (alerting)**: BOT ERRORS/email routing ON for `V1–V8`, `P1`, `U1`, `D1`; `S1`
  still shadow.
- **Phase D (default)**: full registry routed; watchdog template consumes the progress block;
  tier-5 heartbeat live.

Each promotion is one owner-approved fleet-config change with single-step rollback (flag back
one phase). Rollback MUST NOT lose collected evidence or protected roots. Code ships dark
behind `observability.fleetLifecycle = off | shadow | alerting | default` (default `off`).

## 12. Conformance suite (mandatory fixtures; real runtime + real SQLite per repo convention)

- **C1 clean** — every lane settles (queue-mediated via `released`, `queue:none` via
  `finalized`); zero conditions.
- **C2 stalled** — withheld `terminal_result` ⇒ `V1` (joined case) and `P1` (solitary case)
  within bounds (reuses the withheld-terminal case of
  `tests/runtimes/agent/scheduled-turn-lifecycle.test.ts`).
- **C3 crash** — SIGTERM mid-turn ⇒ unfinalized units yield `V1`/`V7` evidence; restart yields
  `reclaimed`/`abandoned` events with reasons and recovery obligations — obligations never
  disappear silently.
- **C4 recovery** — `L-REC` with `origin_lane` completes with proof; `replay_safe` honored; no
  duplicate effect.
- **C5 self-echo** — synthetic own-outbound re-ingest ⇒ `V5`; no amplification loop.
- **C6 deadman walk** — a frozen registered observer ⇒ `V6` from the meta-observer; a frozen
  meta-observer ⇒ poller `V6`; a frozen poller ⇒ cross-host supervisor fires; a **withheld
  tier-4 heartbeat** ⇒ the absence condition surfaces on the registered owner-heartbeat check
  (tiers 2–5).
- **C7 wedge regression** — a **minimized, anonymized fixture derived from** the 2026-08
  production wedge evidence: schema-faithful synthetic rows reproducing the RELATIVE timing
  and joins of the 08-20 and 08-26 incidents on a **shifted synthetic timebase**. The
  committed fixture AND its derivation script MUST contain zero production identifiers and
  zero production timestamps; production selectors live in a private, uncommitted config; the
  committed review note covers **both** fixture and script (F12). Production snapshots are NOT
  repository assets and MUST NOT enter version control. MUST raise `V1`+`V3` for the wedge
  intervals and `V4` for the watchdog-green window.
- **C8 digest resistance (F10)** — with a test key: exported digests differ from unkeyed
  hashes of the same values; no exported surface contains any digest reproducible without the
  key; key rotation (new key id) changes digests without breaking open-condition identity
  (rotation closes and reopens conditions across a declared boundary or dual-digests for one
  wave — fixture asserts the chosen behavior).

## 13. Adoption, versioning, portability

Contracts are semver'd independently (`event.v1`, `condition.v1`, `health.progress.v1`,
metrics `m1`, the class/label/SLO/error-code registries). Additive changes bump minor;
breaking changes bump major and dual-emit for one fleet wave. The core envelope contains no
WhatsApp-specific names; bounded `attrs` carry domain specifics under §7 redaction. This is
the portability seam for any later adoption by other estates — by their decision, not this
standard's reach.

## 14. Approval state

- Review history: v3 FAILED the independent contradiction/privacy/cardinality review (4
  BLOCKERs). v4 resolved all 16 findings and PASSED all three dimensions (privacy: no
  findings). v5 folds in the v4 pass's seven residual MINOR/NOTE findings (N1–N7).
- Pending: owner final approval. Only after approval: an implementation plan (separately
  reviewed) — this document authorizes no code.
