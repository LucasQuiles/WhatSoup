# Fleet Lifecycle Observability Standard — implementation plan v2 (DRAFT for review)

Plans the implementation of the approved design
(`2026-08-26-fleet-lifecycle-observability-standard-design.md`, v7, APPROVED 2026-08-27,
merged at `20e814cc`). Contract/section references below (Contract E/S/M/C/F/H/R/D/B/P,
lanes L-INT/L-SCH/L-CTL/L-REC/L-PRB/L-OUT, conformance C1–C8) refer to that document.
v2 resolves the v1 independent review's findings (2 BLOCKER, 8 MAJOR, 5 MINOR): digest
infrastructure moved to Stage 1; stopgap retirement moved to activation; five-state
delivery restored; fixture map corrected to design §12; per-stage gates and dark-flag
constraint made explicit; authority for Stage 0 execution separated from plan approval.

## 0. Authority state

- Authorized now: DRAFTING this plan and passing it through independent review, per the
  owner's 2026-08-27 approval ("merging the design and drafting a separately reviewed
  implementation plan").
- NOT authorized: any implementation, fleet rollout, alert activation, or control
  automation.
- Plan approval approves the ROADMAP only. No stage — including Stage 0 — starts on plan
  approval alone: each stage starts only on a subsequent owner go-ahead that names that
  stage (Stage 0's go-ahead must name S0.1–S0.5 execution, because Stage 0 touches
  hosts and alert wiring). Every stage ends with a completion report to the owner;
  the owner is the approver of every gate in this document.

## 1. Design constraints carried into implementation

1. TDD throughout: every behavior lands red-first; conformance fixtures (C1–C8) use the
   repo convention of real runtime coordinator + real SQLite, no mocks of either.
2. No instance-specific code, metrics, alert policy, or panels (design §9, last bullet:
   instance-specific panels, metrics, or alert policies are nonconformant); production
   incident data appears only as the anonymized C7 fixture.
3. ALL stage code from Stage 1 onward ships dark behind
   `observability.fleetLifecycle = off | shadow | alerting | default` (default `off`,
   design §11). Merging stage code MUST NOT change fleet behavior on a routine deploy;
   every flag transition is a separate owner act per cohort.
4. Raw ids only in private retained events; exported surfaces follow Contract H
   redaction with keyed HMAC digests.
5. Delivery is the design's closed five-state axis
   `proved | suppressed | failed | ambiguous | not_applicable` (F4) and applies to every
   work unit in every lane — not only L-OUT.
6. Fail-closed defaults everywhere the design names them: unknown age (V6), absent
   observer freshness, retirement gate, bounded disk pressure with saturating counters.
7. Rollout is shadow-first (Contract P): canary instance first then cohorts, 7-day
   shadow soak per cohort; Phase S computes and logs alerts without routing them;
   routing begins only at owner-gated Phase A.
8. All fleet mutations remain inside owner-granted envelopes; this plan creates no new
   mutation authority.

## 2. Stage 0 — interim stopgaps (independent of the standard's machinery)

Cheap, host-local instruments that do not wait for Contracts E–P and directly close the
blindness classes observed live in the scheduled-session wedge incidents. Each is
reversible and read-only toward the product runtime (S0.4 writes only its own snapshot
files).

- **S0.1 Watchdog wedge-signature check.** Extend each host's existing watchdog with one
  read-only SQLite probe: nonterminal inbound events older than a threshold with
  younger rows queued behind them, and scheduled trigger occurrences stuck nonterminal
  past deadline. Alert via the watchdog's existing channel. Acceptance: fixture replay
  of the two confirmed wedge states raises the alert; healthy-state fixture stays quiet.
- **S0.2 Supervision-loop deadman.** Independent probe on a second host: alert when the
  supervision checkpoint pointer has not advanced a generation within 2 hours.
  Acceptance: staged stale pointer fires; live pointer does not.
- **S0.3 Fleet clock audit + skew probe.** One-time inventory of NTP discipline on all
  wave targets; recurring probe comparing host wall clock to a common reference with a
  recorded allowance. Acceptance: audit receipt per host; injected skew beyond allowance
  raises the probe's alert.
- **S0.4 Instance-database snapshot discipline.** Scheduled per-instance snapshot
  (database plus write-ahead files as one coherent copy) with retention and a restore
  rehearsal receipt. Acceptance: restore rehearsal on a fixture host round-trips row
  counts.
- **S0.5 Expected-pin reconciliation.** Standing probe: per host, compare the release
  manifest of the running process's working directory against the recorded expected pin
  (exporter manifests make this deterministic; no process-table inference). Acceptance:
  deliberate mismatch fixture alerts; matching host stays quiet.

Alert wiring in Stage 0 uses the EXISTING channels only (no new paging tiers — those
are Stage 4). Stopgap end-states are defined in Stage 3 and Stage 6.

Gate: owner go-ahead naming S0.1–S0.5 execution (plan approval alone does not start
Stage 0); completion report → owner go-ahead before Stage 1.

## 3. Stage 1 — event spine and digest base (Contract E; Contract H base)

- Base keyed-digest infrastructure FIRST (consumed by every later stage): per-fleet
  secret provisioning, domain-separation prefixes, key id `k1`, and the digest helper
  used for `manager_digest`, `scope_digest`, `condition_fingerprint`, and
  `evidence_digests` (design §7/F10). Rotation and retirement stay in Stage 5.
- `event.v1` emission from the runtime for L-INT and L-SCH first (the two lanes with
  confirmed incidents), then L-CTL/L-REC/L-PRB/L-OUT. Code surfaces:
  `src/runtimes/agent/runtime-turn-coordinator.ts`, `runtime-turn-finalization.ts`,
  scheduled dispatch/occurrence paths, and the inbound lifecycle store.
- Generation-fenced `released`/`finalized` events carrying `manager_generation` and
  keyed `manager_digest`; correlation keys per design §2; boot-id + monotonic clock
  fields from day one (design clock model).
- Private bounded event/condition store (SQLite) per instance with the design's storage
  budgets (reserved condition store; saturating counters; hard ceiling).
- Tests: red-first unit + integration for emission, fencing, storage bounds, digest
  keying. Conformance fixtures C1 and C2 are AUTHORED here red-first; they gate GREEN in
  Stage 2 (they need settlement predicates and delivery evidence that Stage 2 builds).
- All code behind `observability.fleetLifecycle` (off).

Gate: completion report (emission + digest evidence; C1/C2 authored-red receipts) →
owner go-ahead before Stage 2.

## 4. Stage 2 — settlement, conditions, delivery evidence (Contracts S, M)

- Five-axis settlement predicates over the Stage-1 store, including per-unit delivery
  evidence for the closed five-state axis (L-INT settlement requires delivery ∈
  {`proved`, `suppressed`}: echo proof and suppression proof are produced here).
- The closed condition-class registry: violation classes V1–V8 plus the non-violation
  classes `P1` (solitary stall — a unit unsettled past bound with nothing queued behind
  it), `U1` (unclassified work admitted), `D1` (ambiguous delivery), `S1` (SLO breach);
  per-class recovery predicates (F7).
- `health.progress.v1` exposure: per-lane open condition classes plus the observer
  worst-age/breached aggregate on the existing health endpoint, additive to
  `health.public.v1`. Interim value before Stage 3: the registration set is EMPTY and
  the aggregate reports fail-closed absence semantics (never a green default).
- Bounded metrics per Contract M with the approved histogram boundaries
  (1,5,15,60,300,600,900,3600,14400,86400); queue-class scope aggregation; label
  registry closed (no free-form labels).
- Tests/acceptance: settlement truth-table fixtures including the fail-closed
  unknown-age rows; per-class recovery-predicate fixtures (F7); Contract M
  label-registry closure and fixed-bucket assertions; conformance GREEN for
  **C1** (clean: every lane settles, zero conditions), **C2** (stalled: withheld
  terminal result ⇒ V1 joined / P1 solitary within bounds, reusing the withheld-terminal
  case of `tests/runtimes/agent/scheduled-turn-lifecycle.test.ts`), **C3** (crash:
  SIGTERM mid-turn ⇒ V1/V7 evidence; restart yields `reclaimed`/`abandoned` events with
  reasons and recovery obligations that never disappear silently), **C4** (recovery:
  L-REC with `origin_lane` completes with proof, `replay_safe` honored, no duplicate
  effect), and **C5** (self-echo: synthetic own-outbound re-ingest ⇒ V5, no
  amplification loop).

Gate: completion report → owner go-ahead before Stage 3.

## 5. Stage 3 — observers, freshness, deadman chain (Contract F)

- Registered-observers-only freshness; the five-tier deadman chain including the
  absence-detected owner-heartbeat observer and cross-channel supervision.
- Stopgap probes S0.1, S0.2, and S0.5 RE-REGISTER here as standard observers. Their
  bespoke alerting does NOT retire here: it retires only at owner-gated Phase A
  activation for the cohort each probe covers (Stage 6) — until routed standard
  alerting is live for a cohort, the stopgap remains the armed detector (never a
  blindness window, never dual-armed after activation).
- Stopgap end-states: S0.3's skew probe is PROMOTED to a registered observer here (its
  clock-anomaly role overlaps the Stage 1–2 O5 machinery; the registered observer
  supersedes the bespoke probe at the same Phase-A boundary). S0.4 snapshots are NOT
  observability: they remain a permanent host-operations practice outside this
  standard.
- Tests/acceptance: **C6** (deadman walk: frozen registered observer ⇒ V6 from the
  meta-observer; frozen meta-observer ⇒ poller V6; frozen poller ⇒ cross-host
  supervisor fires; withheld tier-4 heartbeat ⇒ absence condition on the registered
  owner-heartbeat check); observer absence is not-green.

Gate: completion report → owner go-ahead before Stage 4.

## 6. Stage 4 — outbound routing, paging, dashboards (Contracts C, R, D; lane L-OUT)

- Delivery-axis routing for the outbound lane and error-channel routing/dedup per
  Contract R: alert lines carry `{instance, lane, class, condition_fingerprint}`;
  dedup is transition-based — one line on OPEN, one on tier escalation, one on
  evidence-based recovery, never per-tick repeats (this ends the current per-tick
  renotify noise); emission failure on either channel is a V6 escalated over the other
  channel.
- Paging per the approved Contract C policy (per-trigger deadlines plus grace; V3 with
  L-INT queued behind pages ≤ 2 min; P1 solitary background stall warns at 5 min and
  pages at 10 min). ALERT ACTIVATION IS OWNER-GATED: Stage 4 lands dark/shadow, and
  turning routing or paging on is an explicit owner act per cohort (Phase A).
- Dashboards: current state via the health surface, history via the authenticated fleet
  API (design §9).
- Tests/acceptance: Contract R dedup fixtures (exactly one OPEN line, one escalation
  line, one recovery line across a multi-tick open condition); Contract C
  exactly-one-incident fixture (a condition sustained past its bound opens exactly one
  incident) and paging-tier fixtures for the table's rows; Contract D panel conformance
  (panels render exactly `health.progress.v1`'s fields — nothing instance-specific);
  cross-channel V6 escalation fixture.

Gate: completion report → owner go-ahead before Stage 5.

## 7. Stage 5 — digest rotation and retention (Contracts H, B)

- Dual-digest rotation and the retirement gate on the Stage-1 digest base: key-alias
  sweep over every open condition and protected retention root, retirement blocked
  until a verified zero-unmigrated-identities count. Retention protected roots and the
  storage budget with the storage-pressure condition that never drops protected
  evidence.
- Tests/acceptance: **C8** (digest resistance and rotation: with a test key, exported
  digests differ from unkeyed hashes and no exported surface contains a digest
  reproducible without the key; rotation fixture asserts the §7 dual-digest migration
  including the dormant-open-condition migration; retirement blocked while any
  unmigrated identity exists).

Gate: completion report → owner go-ahead before Stage 6.

## 8. Stage 6 — conformance completion and promotion (Contract P; C1–C8)

- Full C1–C8 green in CI, including **C7** (wedge regression: a minimized, anonymized
  fixture derived from the 2026-08 production wedge evidence — schema-faithful
  synthetic rows on a shifted synthetic timebase; per the design, production snapshots
  are NOT repository assets and MUST NOT enter version control).
- Rollout per Contract P: canary instance shadow first (Phase S: alerts computed and
  logged, not routed), 7-day soak, then cohorts in the approved wave order. Phase A
  activation per cohort is a separate owner act; at each cohort's activation the
  covering stopgap alerting (S0.1/S0.2/S0.5, and S0.3's bespoke probe) retires.
  Promotion (shadow to default) and any control automation are further separate owner
  acts.

Gate: per-cohort owner activation acts; final completion report closes the plan.

## 9. Conformance fixture → stage map (design §12)

| Fixture | Content (design §12) | Authored | Gates green |
|---|---|---|---|
| C1 clean | every lane settles; zero conditions | Stage 1 | Stage 2 |
| C2 stalled | withheld terminal ⇒ V1 / P1 in bounds | Stage 1 | Stage 2 |
| C3 crash | SIGTERM ⇒ V1/V7; reclaimed/abandoned + obligations | Stage 2 | Stage 2 |
| C4 recovery | L-REC origin_lane, replay_safe, no duplicate effect | Stage 2 | Stage 2 |
| C5 self-echo | own-outbound re-ingest ⇒ V5, no loop | Stage 2 | Stage 2 |
| C6 deadman walk | full five-tier chain incl. withheld heartbeat | Stage 3 | Stage 3 |
| C8 digest/rotation | keyed-digest resistance; dual-digest migration | Stage 5 | Stage 5 |
| C7 wedge regression | anonymized production-shaped wedge replay | Stage 6 | Stage 6 |

## 10. Explicitly out of scope (separate lanes, owner-gated)

- The product-durability items from the wedge postmortem (joined scheduled-job receipt,
  fenced reaper, preflight block on processing inbounds, trigger auto-pause, inbound
  replay): a product lane, not observability; filings remain owner-gated.
- Design v8 candidates recorded for the standard, not this plan: common-cause/correlated
  failure roll-up; credential expiry probes as first-class observers.
- Adoption by other estates (design §13 portability seam stays a seam).

## 11. Open decisions for the owner (proposed defaults; plan proceeds once decided)

- **D1 Eradication acceptance count** (decision for the wedge-incident lane; it gates
  no stage of THIS plan): propose 7 consecutive clean scheduled fires — the trigger is
  daily, so 7 fires spans 7 calendar days, aligning with the shadow-soak duration by
  construction — with a defined `inconclusive` outcome when a fire lacks a subsequent
  interactive inbound to exercise the path. Until accepted, the incident stays open and
  its regression sentinels stay red-flip.
- **D2 Wave stall policy:** propose skip-and-return — the coordination-gated host is
  deferred and the wave continues through the remaining targets in the approved order,
  with a weekly owner ping while that coordination stays open.
- **D3 Unreachable-operator auto-containment:** propose NONE through Stage 3 (observe
  only); revisit at Stage 4 with evidence.

## 12. Verification and review

- This plan passes an independent adversarial review (contradiction with the approved
  design, sequencing soundness, coverage of the design's ten contracts, authority-
  boundary correctness) BEFORE returning to the owner for approval. v1 FAILED that
  review (2 BLOCKER, 8 MAJOR); v2 resolves every finding and awaits delta re-review.
- Every stage's acceptance is a falsifiable fixture or receipt, never a narrative claim;
  stage reports carry command-level evidence per the repo's verification discipline.
