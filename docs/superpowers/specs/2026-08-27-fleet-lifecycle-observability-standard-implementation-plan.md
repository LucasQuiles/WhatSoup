# Fleet Lifecycle Observability Standard — implementation plan v1 (DRAFT for review)

Plans the implementation of the approved design
(`2026-08-26-fleet-lifecycle-observability-standard-design.md`, v7, APPROVED 2026-08-27,
merged at `20e814cc`). Contract/section references below (Contract E/S/M/C/F/H/R/D/B/P,
lanes L-INT/L-SCH/L-CTL/L-REC/L-PRB/L-OUT, conformance C1–C8) refer to that document.

## 0. Authority state

- Authorized now: DRAFTING this plan and passing it through independent review, per the
  owner's 2026-08-27 approval ("merging the design and drafting a separately reviewed
  implementation plan").
- NOT authorized: any implementation, fleet rollout, alert activation, or control
  automation. No stage in this document may start until the owner approves this plan.
- Each stage below also names its own gate; owner plan-approval authorizes starting
  Stage 0 only unless the approval says otherwise. Later stages each return a short
  completion report and wait for a named go-ahead.

## 1. Design constraints carried into implementation

1. TDD throughout: every behavior lands red-first; conformance fixtures (C1–C8) use the
   repo convention of real runtime coordinator + real SQLite, no mocks of either.
2. No instance-specific code, metrics, alert policy, or panels (design §0); production
   incident data appears only as the anonymized C7 fixture.
3. Raw ids only in private retained events; exported surfaces follow Contract H
   redaction with keyed HMAC digests.
4. Fail-closed defaults everywhere the design names them: unknown age (V6), absent
   observer freshness, retirement gate, bounded disk pressure with saturating counters.
5. Rollout is shadow-first (Contract P): emit + record, no paging, no control actions,
   canary instance first then cohorts, 7-day shadow soak per cohort.
6. All fleet mutations remain inside owner-granted envelopes; this plan creates no new
   mutation authority.

## 2. Stage 0 — interim stopgaps (independent of the standard's machinery)

Cheap, host-local instruments that do not wait for Contracts E–P and directly close the
blindness classes observed live in the scheduled-session wedge incidents. Each is
reversible and read-only toward the product runtime.

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

Gate: owner approval of this plan starts S0.1–S0.5. Alert wiring in Stage 0 uses the
EXISTING channels only (no new paging tiers — those are Stage 4).

## 3. Stage 1 — event spine (Contract E)

- `event.v1` emission from the runtime for L-INT and L-SCH first (the two lanes with
  confirmed incidents), then L-CTL/L-REC/L-PRB/L-OUT. Code surfaces:
  `src/runtimes/agent/runtime-turn-coordinator.ts`, `runtime-turn-finalization.ts`,
  scheduled dispatch/occurrence paths, and the inbound lifecycle store.
- Generation-fenced `released`/`finalized` events; correlation keys per design §2;
  boot-id + monotonic clock fields from day one (design clock model).
- Private bounded event/condition store (SQLite) per instance with the design's storage
  budgets (reserved condition store; saturating counters; hard ceiling).
- Tests: red-first unit + integration; the C1/C2 conformance fixtures land here.

Gate: stage report with conformance evidence; owner go-ahead before Stage 2.

## 4. Stage 2 — settlement and conditions (Contracts S, M)

- Five-axis settlement predicates and the closed condition-class registry
  (V1–V8, plus the probe/update/delivery/storage classes) evaluated from the Stage-1
  store.
- `health.progress.v1` exposure: per-lane open condition classes plus observer
  worst-age/breached counts on the existing health endpoint, additive to
  `health.public.v1`.
- Bounded metrics per Contract M with the approved histogram boundaries
  (1,5,15,60,300,600,900,3600,14400,86400); queue-class scope aggregation.
- Tests: settlement truth-table fixtures including the fail-closed unknown-age rows and
  the wedge fixtures now asserting V1 via the real predicate (C3/C4).

## 5. Stage 3 — observers, freshness, deadman chain (Contract F)

- Registered-observers-only freshness; the five-tier deadman chain including the
  absence-detected owner-heartbeat observer and cross-channel supervision.
- The Stage-0 stopgap probes (S0.1/S0.2/S0.5) re-register here as standard observers and
  their bespoke alerting retires (replaced, never dual-armed).
- Tests: C5 deadman fixtures; observer absence is not-green.

## 6. Stage 4 — outbound proof, paging, dashboards (Contracts C, R, D; lane L-OUT)

- Delivery proof states (`proved|failed|ambiguous|not_applicable`) on the outbound lane;
  error-channel routing/dedup per Contract R (this also addresses live renotify
  fatigue: age-based collapse of long-open incidents is part of R's dedup semantics).
- Paging per the approved policy (per-trigger deadlines plus grace; 2-minute blocking
  page and the solitary-operator warn/page ladder). ALERT ACTIVATION IS OWNER-GATED:
  Stage 4 lands dark (shadow), and turning paging on is an explicit owner act per
  cohort.
- Dashboards: current state via the health surface, history via the authenticated fleet
  API (design §9).

## 7. Stage 5 — digests, rotation, retention (Contracts H, B)

- Keyed HMAC digests with dual-digest rotation and the retirement gate (key-alias sweep,
  verified zero-unmigrated-identities). Retention protected roots and the storage budget
  with the storage-pressure condition that never drops protected evidence.
- Tests: rotation round-trip including the dormant-open-condition migration fixture;
  retirement blocked while any unmigrated identity exists.

## 8. Stage 6 — conformance completion and promotion (Contract P; C1–C8)

- Full C1–C8 green in CI, including the anonymized C7 production-shaped fixture
  ("production snapshots must not become public repository test assets").
- Rollout per Contract P: canary instance shadow first, 7-day soak, then cohorts in the
  approved wave order; promotion (shadow to default) and any control automation are
  separate owner acts.

## 9. Explicitly out of scope (separate lanes, owner-gated)

- The product-durability items from the wedge postmortem (joined scheduled-job receipt,
  fenced reaper, preflight block on processing inbounds, trigger auto-pause, inbound
  replay): a product lane, not observability; filings remain owner-gated.
- Design v8 candidates recorded for the standard, not this plan: common-cause/correlated
  failure roll-up; credential expiry probes as first-class observers.
- Adoption by other estates (design §13 portability seam stays a seam).

## 10. Open decisions for the owner (proposed defaults; plan proceeds once decided)

- **D1 Eradication acceptance count:** propose 7 consecutive clean scheduled fires
  (matching the shadow-soak convention) with a defined `inconclusive` outcome when a
  fire lacks a subsequent interactive inbound to exercise the path.
- **D2 Wave stall policy:** propose skip-and-return — the coordination-gated host is
  deferred and the wave continues through the remaining targets in the approved order,
  with a weekly owner ping while that coordination stays open.
- **D3 Unreachable-operator auto-containment:** propose NONE through Stage 3 (observe
  only); revisit at Stage 4 with evidence.

## 11. Verification and review

- This plan passes an independent adversarial review (contradiction with the approved
  design, sequencing soundness, coverage of the design's ten contracts, authority-
  boundary correctness) BEFORE returning to the owner for approval.
- Every stage's acceptance is a falsifiable fixture or receipt, never a narrative claim;
  stage reports carry command-level evidence per the repo's verification discipline.
