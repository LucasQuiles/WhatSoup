# DESIGN — Console approval queue (D-4 / PDR-2) — 2026-07-19

**Status:** DESIGN for owner review — the review's gate is "design first,
owner nod" (operator-local status note `whatsoup-ui-ux-review-20260719.md` §D-4). No
build authorization is claimed here; §6 lists the explicit decision points
the nod covers.
**Grounding:** PDR-2 (design/implementation lineage: PR #1943); the
exec-approval seam verified against current source (this date).

## 1. The gap, precisely

An agent that needs a user decision today has exactly one lane: WhatsApp
(`AskUserQuestion` → poll widget → vote → answer injected into the next
turn; `docs/runbooks/agent-decision-polls.md`). The console — where the
operator actually watches the fleet — cannot see or answer a pending
decision. `exec-approval`/`approval-queue` = 0 in `console/src` (PDR-2,
verified). Peer precedent: OpenClaw's exec-approvals page (GUI lane for
agent-proposed exec/tool calls, with security modes and ask policies).

## 2. Existing machinery (the reuse seams — all verified 2026-07-19)

| Seam | Where | Reuse |
|---|---|---|
| `pending_polls` table + `PendingPollPersistence` (upsert/remove/rehydrate; error counter surfaced in health) | `src/runtimes/agent/pending-poll-persistence.ts:31-53` | The durable queue — survives restarts, rehydrates into the runtime's store. The console reads this, it does not invent a second queue. |
| Poll-resolution path (vote → option match → answer injection into next turn; first resolution wins) | `pending-poll-store.ts`, `poll-resolution.ts` | Console approve/deny resolves through THE SAME path a WhatsApp vote takes — UX-20 parity (poll-vote, 👍/👎 reaction, console button are three renderings of one decision). |
| AccessTab approval idiom (pendingAction → ConfirmDialog → api → toast + invalidate) | `console/src/components/line-detail/AccessTab.tsx` | The console's existing approval-UX vocabulary; the queue mirrors it. |
| Fleet per-instance read pattern (narrow route + db-reader, off the re2 chain) | `routes/checkpoints.ts`, `routes/rate-limits.ts` | `GET /api/lines/:name/approvals` follows this exact discipline. |
| Realtime publisher (status/feed events) | `src/fleet/realtime-publisher.ts` | Queue invalidation on poll create/resolve. |

## 3. Proposed design

### 3.1 Server (fleet routes, narrow-import discipline)

- `GET /api/lines/:name/approvals` → reads `pending_polls` rows via a new
  `FleetDbReader.getPendingPolls(name, dbPath)` (payload JSON deserialized
  server-side; fail-closed `readError` idiom — never a fake-empty queue).
  Response: `{observedAt, approvals: [{mapKey, chatJid, question, options[],
  askedAt, hardClosesAt, scope}], readError?}`.
- `POST /api/lines/:name/approvals/:mapKey/decision {decision: optionLabel
  | 'deny'}` → resolves through the runtime's poll-resolution path. **The
  hard constraint (handoff §6, same class as checkpoint-restore): the
  resolution must reach the OWNING runtime, never write the row behind its
  back.** Two options — DECISION NEEDED (§6 D2):
  - **(a) Instance API call** — the instance's health/API port gains a
    resolve endpoint; the fleet proxies. Live-runtime delivery, no DB
    race; needs a new instance-side route (small, mirrors the health
    server's existing shape).
  - **(b) Durable decision row** — fleet writes `pending_poll_decisions`
    the runtime consumes on its next beat (restart-safe, mirrors the
    runtime's own rehydration pattern). Simpler; adds one polling beat of
    latency.
  Recommendation: **(a)** when the instance is live, **(b)** as the
  offline fallback — the same decision record either way.

### 3.2 Console surface

- **Where:** a per-line **Approvals** queue inside LineDetail (badge count
  on the tab row when pending > 0 — the line is the decision's scope), NOT
  a global page in v1. Fleet-global rollup = v2 (named non-goal).
- **Card anatomy:** the pending question, originating chat (truncated
  JID, title-full), the options as buttons (recommended first — matches
  runbook guidance), timeout countdown from `hardClosesAt` (amber in the
  last minute), auth/scope note. Deny/destructive options route through
  ConfirmDialog (the console's modal law).
- **States:** fail-closed error panel on readError (PDR-3); empty state is
  a calm "no pending decisions" (not a skeleton); **stale-freshness marker
  per the #1934 contract**; a row resolved elsewhere (WhatsApp vote first)
  disappears on the next poll — first-resolution-wins is already the
  store's semantics, the console never double-resolves (server 409s a
  stale decision and the UI toasts it honestly).

### 3.3 Resume-on-decline semantics (review §D-4 requirement)

"Declined draft = held checkpoint." With this machinery that falls out
naturally: a decline IS the decision — the poll row resolves as declined,
the agent's NEXT turn receives the decline as its answer (same injection
path as a vote), and the session checkpoint records the post-decision
state through the existing checkpoint writes (#1930 surface shows it;
#1935's restore path applies unchanged). **No special checkpoint state is
invented** — a declined session is resumable/restorable like any other,
and the decline itself is visible in the turn transcript. The design
doc's only add: the decline resolution payload records
`declinedVia: 'console' | 'poll' | 'reaction'` so the transcript shows
WHERE the decision came from (operator auditability).

## 4. Policy dimensions (what generates queue items)

v1: **AskUserQuestion blocking polls only** (the existing, sole decision
mechanism). The wider policy — exec/tool-call pre-approval (OpenClaw's
`deny`/`allowlist`/`full` security modes, `off`/`on-miss`/`always` ask) —
is a SEPARATE, larger program (it gates tool execution, not just
questions). v1 names it out of scope and keeps the queue's data model
generic enough to carry tool-approval rows later (`kind: 'question' |
'exec'` forward-field).

## 5. v1 non-goals

Fleet-global queue page; exec/tool-call pre-approval modes; draft-model
generation (the review's "which model drafts" question — no drafting is
introduced here, only decision surfacing); poll creation from the console
(the console answers, it does not ask).

## 6. DECISION POINTS for the owner nod

1. **D1 — Scope confirmation:** v1 = console visibility + resolution of
   AskUserQuestion blocking polls only (exec/tool pre-approval deferred).
   OK?
2. **D2 — Resolution path:** (a) live instance API proxy (recommended when
   live) + (b) durable decision row fallback — or (b) only (simpler, one
   beat of latency)?
3. **D3 — Surface:** per-line Approvals tab in LineDetail (recommended;
   scope-honest) vs fleet-global queue page now?
4. **D4 — Decline provenance:** record `declinedVia` in the resolution
   payload (recommended — cheap, auditable) or skip?

## 7. Build sketch (post-nod, per lane protocol)

MAP re-verification → SPEC → TDD: `getPendingPolls` (real sqlite) +
route tests (404/readError/empty) + instance resolve path tests + console
ApprovalQueue suite (AccessTab-idiom: pending/confirm/toast/invalidate,
409-stale honesty) + DS inventories. Estimated 2 files server + 3 console
+ tests — one PR, stacked on nothing (main-resident surfaces only).
