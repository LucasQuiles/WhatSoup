# DESIGN — Durable-latch production writers + the status-writer invariant (#1786 / #1789) — 2026-07-20

**Status:** DESIGN for owner review. No build authorization is claimed here;
§6 lists the explicit decision points the owner nod covers.
**Grounding:** all seams verified against `main` (057ee8715) on this date;
file:line anchors below are that snapshot.

## 1. The gap, precisely

Two fleet instances went dark unnoticed (per #1786: roughly 19 and 32 days
respectively) because the durable alert built for exactly this case has
**zero production writers**.

Verified on main:

- The table exists — `auth_loss_signal` (`src/core/database.ts:864`, with
  two indexes) — a durable, dedup-aware latch for terminal auth loss.
- The store exists — `AuthLossSignalStore.record()` /`.resolve()`
  (`src/fleet/auth-loss-signal-store.ts:66,106`): validated inputs,
  dedup via `duplicate_active_signal`, resolution via `no_open_signal`.
- The controller exists — `AuthLossSignalTransitionController.recordAuthLoss()`
  + `observeHealthSample()` (`src/fleet/auth-loss-signal-transition-controller.ts:52,64`),
  the latter auto-resolving on `evaluateStableAuthenticatedOpen`.
- **But the controller is imported by no production file** — only by its
  own module and five test files (`grep -rln` on main: the sole non-test
  importer of `auth-loss-signal-store` is the controller; the sole
  importer of the controller is itself). Nothing in the live disconnect
  or health path constructs it or calls `recordAuthLoss()`.

Meanwhile the terminal-logout decision is made and thrown away durably:
`decideDisconnectAction` returns `{type:'exit', reason:'logged-out'}` on
three terminal branches (`src/transport/auth-disconnect-policy.ts:50,53,56`),
and the health surface already *detects* the missing latch —
`src/fleet/health-poller.ts:471` and `src/fleet/routes/lines.ts:246` carry
the reason strings `…_without_auth_loss_signal`. The system knows the row
should exist; nothing writes it. So the alert lives once in memory, dies on
restart, and `metrics_hourly` reports the dark instance green.

This is one instance of a wider pattern (#1789): a status-bearing durability
table that is **structurally incapable of reporting bad news** because its
terminal value has no production writer — found only by mining rows, since
no test asserts the surface can fail.

## 2. Existing machinery (the reuse seams — all verified 2026-07-20)

| Seam | Where | Reuse |
|---|---|---|
| `auth_loss_signal` table + indexes | `core/database.ts:864` | The durable latch — already migrated; no schema work. |
| `AuthLossSignalStore.record()/.resolve()` | `fleet/auth-loss-signal-store.ts:66,106` | Dedup-aware write + resolve; **already tested** (`tests/fleet/auth-loss-signal-store.test.ts`). Do not reimplement. |
| `AuthLossSignalTransitionController` | `fleet/auth-loss-signal-transition-controller.ts:39` | The write/resolve orchestrator (`recordAuthLoss`, `observeHealthSample`). The wiring target — construct it and call it. |
| Terminal-logout decision | `transport/auth-disconnect-policy.ts:50-56` | The exact production event that must produce a durable write. |
| Missing-latch detectors | `fleet/health-poller.ts:471`, `routes/lines.ts:246` | Already emit `…_without_auth_loss_signal`; flip these from "detect absence" to "the row is now present". |

## 3. Proposed design

### 3.1 #1786 — wire the writer (and the resolver)

The machinery is complete; the fix is **wiring, not building**:

- **Write on terminal loss.** At the terminal-logout site that consumes
  `decideDisconnectAction` (`type:'exit', reason:'logged-out'`), call
  `controller.recordAuthLoss({instance, host, classifier, reason,
  confidence})`. `record()` is idempotent per open signal
  (`duplicate_active_signal`), so a repeated exit does not spam rows.
- **Resolve on recovery.** Feed the health sample loop into
  `controller.observeHealthSample(...)`; a stable authenticated open
  auto-resolves the open signal (already implemented). No dark-forever
  latch.
- **Read the durable latch for metrics.** `metrics_hourly`'s auth-health
  field must derive from an open `auth_loss_signal` row, not an in-memory
  boolean — so a restarted collector still reports the instance red.
  (The detectors at `health-poller.ts:471`/`lines.ts:246` become the
  cross-check: an `exit/logged-out` with no open row is now the bug, and
  a test asserts it cannot happen.)

### 3.2 #1789 — the status-writer invariant, enforced

Make the class of defect impossible to reship: a guard/test that, for every
registered status-bearing durability table, asserts **(a)** a declared
terminal-failure value exists in its enum/schema, and **(b)** a production
(non-test) code path writes that value. This is the orphan-export guard's
sibling (#1871) narrowed to durability semantics: #1871 catches "source
module with no production import"; this catches "terminal status value with
no production writer". The `auth_loss_signal` controller would have tripped
both.

## 4. Decision points for the owner (§6 nod)

1. **D1 — Writer site.** Wire `recordAuthLoss` at the transport
   terminal-logout consumer (closest to the decision), at the fleet
   health-poller (closest to the metric), or both (defense-in-depth,
   dedup makes it safe)? Recommendation: **both** — transport is the
   truth source, poller is the backstop; `duplicate_active_signal` makes
   double-write harmless.
2. **D2 — Metric source.** Change `metrics_hourly` to read the durable
   latch now (recommended — it is the whole point), or keep the in-memory
   value and only add the durable row in v1?
3. **D3 — Invariant scope (#1789).** Enforce the writer-invariant guard
   across all four audited surfaces at once, or land `auth_loss_signal`
   wiring first and add the guard as a fast-follow?
4. **D4 — Guard home.** New dedicated `durability-writer` guard, or extend
   the existing orphan-export guard (#1871) with a durability-writer rule?

## 5. Non-goals

Rebuilding the store/controller (they exist and are tested); a new alerting
channel (this restores the *durable record*; downstream alerting consumes
the row); changing the disconnect classification logic; the other three
#1789 surfaces beyond enumerating them for the invariant guard.
