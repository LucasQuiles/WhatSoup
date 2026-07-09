# EVIDENCE-G — outbound-flood detector + alert (PR-G)

Branch `feat/outbound-flood-detector`, based on `origin/main` `63ee7c1c`.
Node `24.15.0`. Test command: `npx vitest run --pool=forks <files>`.
Pure observability; lands independently of PR-E/PR-F.

## What shipped (per PLAN-G, strict TDD)

| Task | Behaviour | Where |
|------|-----------|-------|
| 1 (T1.1) | Sliding-window per-dest counter (window+count+threshold, ages out); defaults `OUTBOUND_FLOOD_WINDOW_MS=300_000`, `OUTBOUND_FLOOD_THRESHOLD=20` | `src/transport/outbound-flood-detector.ts` |
| 1 (T1.3) | Lid-resolved dest keying (G2/H3): `@lid` + phone-JID fold to one key | detector `resolveKey` + `ContactsDirectory.resolveConversationKey` |
| 2 (T2.1) | Count at the send seam — text/MCP-raw/poll/media all counted (not text-only) | `connection.ts` `countOutboundSend` at the 4 send methods |
| 3 (T3.1) | Edge-triggered dedup: one alert per flood, re-arm after drain | detector `record().tripped` |
| 3 (T3.2) | On trip: WARN `outbound flood detected` (redacted), one alert via fleet plane, `outboundFlood` in connection-state | `connection.ts` `handleOutboundFlood` |
| 3 (T3.3) | `/health` payload reflects `outbound_flood`; active flood → `degraded` | `src/core/health.ts` |
| 4 | Recognise PR-E/PR-F prevention WARN logs as `outbound_flood_signal` (best-effort cross-bot) | `src/fleet/routes/feed.ts` |
| 5 | Parse `Sending media` outbound line (feed was text-only, blind to media floods) | `src/fleet/routes/feed.ts` |

## Commits (oldest→newest)

```
be4a074e feat(transport): add outbound-flood sliding-window detector          (T1.1)
0f5494ac test(transport): lid-resolved dest keying for flood detector          (T1.3)
5da65f70 feat(transport): edge-triggered trip dedup in flood detector          (T3.1)
7dcf2afe feat(transport): read-only outbound-flood counter at the socket seam  (superseded)
82048c81 feat(transport): detect outbound floods at the send seam + surface in /health (T2.1+T3.2+T3.3)
5fe7e64a feat(fleet): parse media + E/F prevention logs for cross-bot flood visibility (T4+T5)
```

## Files changed (`git diff --stat origin/main..HEAD`)

```
 src/core/health.ts                                |  16 ++
 src/core/mentions.ts                              |  16 +-
 src/fleet/routes/feed.ts                          |  46 ++++++
 src/transport/connection.ts                       |  89 +++++++++++
 src/transport/outbound-flood-detector.ts          | 166 ++++++++++++++++++++
 tests/core/health.test.ts                         |  55 +++++++
 tests/core/mentions.test.ts                       |  44 ++++++
 tests/fleet/feed-outbound-flood.test.ts           |  61 ++++++++
 tests/transport/outbound-flood-connection.test.ts | 159 ++++++++++++++++++++
 tests/transport/outbound-flood-detector.test.ts   | 175 ++++++++++++++++++++++
 10 files changed, 826 insertions(+), 1 deletion(-)
```

## TDD failing → passing transcripts

### T1.1 — sliding window (window trip + aging)
RED (impl absent):
```
Error: Cannot find module '../../src/transport/outbound-flood-detector.ts'
 Test Files  1 failed (1)   Tests  no tests
```
GREEN after minimal impl:
```
 Test Files  1 passed (1)   Tests  6 passed (6)
```

### T1.3 — resolved-keying dodge-prevention (G2/H3)
Two-case discriminating test proves the fold is **load-bearing**:
- With the resolver: 2 sends under `…@lid` + 2 under its phone JID → `isFlooding` true for **either** address (folded count = threshold).
- Without the resolver (identity keying): the *same* flip splits across two raw keys, **neither** reaches threshold → the dodge the resolver closes.
GREEN: `Tests  8 passed (8)`.

### T3.1 — edge-triggered alert dedup
RED (no `tripped` on `record()`):
```
TypeError: Cannot read properties of undefined (reading 'tripped')
 Tests  3 failed | 8 passed (11)
```
GREEN after adding the rising-edge latch: `Tests  11 passed (11)`.
Asserts: a flood **sustained across many window-durations** emits exactly **one**
trip (count never drops below threshold → latched); a fresh burst after the
window drains re-arms (two trips). This is the constraint the design pins — a
sustained flood must not self-flood the alert plane (07-08 lesson).

### T2.1 + T3.2/T3.3 — all tiers counted, surfaced, alerted once (integration)
`tests/transport/outbound-flood-connection.test.ts` drives the **real**
ConnectionManager over a mocked Baileys socket:
- 8 `sendMessage` + 6 `sendRaw` + 6 `sendPollMessage` to one dest = **20** →
  `getConnectionState().outboundFlood.flooding === true`, `worstCount === 20`.
  (If any tier were uncounted the total would fall short and never trip.)
- 2 `sendMedia` (url-based) to a second dest → `destCount === 2` (media counted).
- `worstDestHash` is a short hash — asserted **not** to contain the raw number or `@`.
- Exactly **one** `outbound_flood` alert captured on `WHATSOUP_ALERT_SINK`
  (`EMIT_ALERT_THROTTLE_MS=0` + `resetEmitAlertThrottle()` so the dedup proven is
  the detector's edge-trigger, not emit-alert's real-clock throttle).
- Below threshold (19 sends): `flooding === false`, zero alerts.
GREEN: `Tests  2 passed (2)`.

### Tasks 4 + 5 — feed parser
RED (branches absent): `Tests  3 failed | 2 passed (5)`.
GREEN after adding `Sending media` + `outbound_flood_signal` branches:
`Tests  5 passed (5)`. Includes a negative case (an ordinary `Sending message`
is **not** misclassified as a flood signal).

## Suite results (pre-existing stays green)

```
PR test files (5)          207 passed (207)
tests/transport/ (61)      875 passed (875)
tests/core/ (127)        2,727 passed (2,727)
tests/fleet/ (99)        1,681 passed (1,681)
typecheck (tsc --noEmit) clean
```

## Guards

```
guard:boundaries        import boundary check passed (32 grandfathered baseline; 0 new)
guard:lint:src          eslint fitness ring: 203 warning(s), 0 error(s) — passed
                        (all max-lines warnings are pre-existing files; none are PR files)
guard:test-integrity    status=pass exit_class=clean total=6 baseline=6 new=0 drifted=0
file-size ratchet       tests/scripts/fitness-file-size-warning-budget.test.ts — 3 passed
pre-commit hooks        passed on every commit (repo hygiene, publication, node-pin, claude-settings)
```

Test-integrity note: the PostToolUse hook emits an **advisory** `test-file-tree-sitter-parse-error`
on the TS test files (bundled tree-sitter grammar; not a deterministic rule). The
authoritative `guard:test-integrity` baseline check reports **0 new / 0 drifted**
findings, and every test executes and asserts under vitest.

## Design ↔ code notes

- **PR-F merge point.** The design says "count at the `this.sock.sendMessage`
  wrap PR-F adds (connection.ts:681)." An initial commit (`7dcf2afe`) did exactly
  that via `installOutboundFloodCounter`, but replacing `sock.sendMessage` in
  place **destroys the `vi.fn` spy that 20+ existing suites assert on** after
  `connect()` (e.g. `tests/transport/typing.test.ts`). Pivoted to a single
  private hook `ConnectionManager.countOutboundSend(chatJid)` called at the 4
  send methods (all `this.sock.sendMessage` callers — grep-confirmed). Same
  single logical seam, zero socket mutation, full transport + core suites green.
  **When PR-F's real wrapper lands, it calls `countOutboundSend` in place of the
  per-method calls** — that method is the merge point (`connection.ts`,
  `handleOutboundFlood`/`countOutboundSend`).
- **Resolver-at-seam gap closed.** A pure detector unit test only proves it *can*
  fold given a resolver. `ContactsDirectory.resolveConversationKey` (reusing
  `canonicalConversationKey`, ingest's store-side keying) is unit-tested against a
  real in-memory DB + one `lid_mappings` row (`tests/core/mentions.test.ts`), and
  the ConnectionManager integration test exercises the real wired resolver — so
  flood counts fold **and** correlate with durability/ingest, not just internally.
- **Redaction at the boundary, not in the detector.** The detector keys on the
  raw resolved `conversation_key` (needed for correct folding; a DM key *is* the
  bare phone). `shortHash` is applied at all three surfacing points: the
  connection-state field, the WARN log `dest`, and the alert payload.
- **Media counted once per logical send.** `countOutboundSend` sits *before*
  `sendMedia`'s retry loop, so connection retries don't inflate the count and
  false-trip the detector.
- **Alert plane.** Routed through `emitAlertChecked` (source `outbound_flood`,
  `critical`) — the same bot-errors outbox path connection.ts's auth alerts use
  (mq-remind is downstream of it). One alert per flood via the detector's
  rising-edge dedup, not emit-alert's throttle.

## Best-effort / follow-on (not blocking; noted for review)

- **Task 4 patterns are speculative** — PR-E/PR-F are unmerged, so the recognised
  strings (`outbound flood-guard tripped`, `outbound governor ceiling exceeded`,
  `transport outbound ceiling exceeded`, `high-volume turn`) track the design's
  named text and are matched by string only (no code dependency, so G stays
  independent). **Reconcile these with E/F's final log text when those PRs land**
  (`src/fleet/routes/feed.ts`, the `outbound_flood_signal` branch).
- **Feed aggregator alerting on `outbound_flood_signal` is a fleet-side follow-on.**
  This PR makes the parser *recognise* prevented-flood signals and media sends;
  raising a fleet alert off those events belongs to the aggregator/consumer. The
  **in-bot seam counter is the authoritative alerting path** and is complete here
  (Tasks 1–3). `sendRaw`/poll log no uniform `Sending` line, which is precisely
  why the in-bot counter (which sees all tiers) — not the log feed — is authoritative.

## Constraints honoured

Committed, unpushed. No pushes. No bot run/restart. Only this worktree touched.
No attribution trailers (commit-msg hook enforced on every commit). Commit
identity `SoupBot <soupbot@users.noreply.github.com>` (allowlist-mandated).
