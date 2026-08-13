# runtime.ts decomposition design (#1977 QR-019)

Design-first program for decomposing `src/runtimes/agent/runtime.ts` (12,473 lines at
`3e8d66d32`), per the owner call of 2026-07-02 (deferred, design required before
extraction) and the 2026-08-13 authorization to execute the waiver payback: return the
file below 12,131 lines, then ratchet down.

Measurement basis (full-file tiling, 2026-08-13): blast radius = `this.<member>`
references to the eight shared runtime members (`chatSessions`, `chatQueues`,
`cleanupPerChatState`, `turnQueue`, `perChatTurnQueues`, `durability`, `session`,
plus module-scope `config`, which costs an import, not a port field). Cohesion =
internal / (internal + external) call sites for the group's methods.

## Decision 1 — ownership (the issue's stated prerequisite)

`chatSessions`, `chatQueues`, and `cleanupPerChatState` REMAIN owned by `AgentRuntime`.
No extraction transfers them. Rationale, measured: `chatSessions` has 79 in-file
references plus five sibling modules already reaching it through host ports;
`chatQueues` 59 (+3); `cleanupPerChatState` is a shared utility with seven external
call sites spread across six concerns. Any ownership transfer would invert dozens of
access paths for zero cohesion gain.

Extractions access runtime state through **host ports**, the proven in-repo pattern
(four existing factories, `runtime.ts:2398-2402` / `2438-2696`):

- Maps pass as plain references (`chatSessions: runtime.chatSessions`) — they mutate
  in place, no getter needed.
- Reassignable reads use `get X() { return runtime.X; }`; read-write fields use
  getter/setter pairs (`session`, `recoveryGeneration`).
- Precedent scale: `createRuntimeTurnHost` 91 fields (upper bound),
  `createChatTransportHost` 17 (the shape these extractions should resemble).

## Decision 2 — extraction order (ascending blast radius, one per PR)

| PR | Cluster | Lines | LOC | Blast | Cohesion | Port sketch |
|---|---|---|---|---|---|---|
| D1 | Routing + model preference | 8364-9009 | ~646 | 2 | 61% | ~2 state fields + 6 entry points (`resolveRouteForTurn`, `scanRouteMarkerDelta`, `routeSessionProviderConfig`, `emitRouteEventChecked`, `applyRouteChangeAndRecycle`, `noteRouteAtSpawn`) |
| D2 | Fallback core | 9010-10438 | ~1,429 | 3 | 58% | ~3 state fields + ~11 entry points; `effectiveProvider` / `isFallbackWindowActive` stay as delegating getters on `AgentRuntime` (17 call sites read them) |
| D3 | Poll bridge | 5809-6844 | ~1,036 | 7 | 64% | builds on the existing `PendingPollStore` collaborator; 7 entry points |

Boundary notes that make these numbers true:
- D1's cut is at **9009, not 9021**: the two fallback getters at 9010/9018 belong to
  D2 (moving them raised D1 cohesion 38%→61% at unchanged blast).
- D2 is G16+G17 **merged**: the fallback window block alone (9608-10438) touches zero
  shared members, and five of its ten external callers are in 9010-9607 — merged, the
  pair adds no shared-member touches. Do NOT extend D2 to 11035 (provider-failure
  replay): cohesion rises only 58%→63% while blast jumps 3→15.
- Test debt: zero private-METHOD bindings exist in `tests/runtimes/agent/` (219 files)
  for any candidate method (verified with positive/negative grep controls). Tests bind
  to fields via `(runtime as any).<field>`, which host ports preserve.

Projected effect: D1+D2 alone bring the file to ≈10,400 + port overhead — under the
12,131 waiver target with margin; D3 lands ≈9,400.

## Decision 3 — explicitly deferred (do not extract on this program)

- **Auto-compact / system-turn quarantine (1123-1409)** and **per-chat cleanup /
  image-coalesce (1768-2305)**: low blast but cohesion 20% / 27% — extraction creates
  a 12-method port for 287 LOC (the leaky-wrapper anti-pattern the 2026-07-02 scoping
  rejected for SessionSweeper).
- **God methods** — `start()` (~628 lines), `_handleMessageInner()` (~532),
  `handleEvent()` (349), `handleEventPerChat()` (178): single methods dominating their
  regions' blast radius. Decomposing them is intra-method refactoring, a separate
  design, not a cluster lift.
- **Control-session / self-healing repair** (the epic's `ControlSessionCoordinator`
  candidate, banner at 2297): its code now interleaves with the public control/command
  API region (6845-7494, blast 14). Largest and highest-risk; re-map after D1-D3 land.

## Per-PR acceptance gate (every extraction)

1. Full push gate + CI green; the cluster's dedicated tests pass unchanged or with
   mechanical import updates only.
2. Measured `runtime.ts` line-count drop recorded in the PR (file-size ratchet
   tightened when the waiver retires).
3. The new module touches shared state ONLY through its declared port — no new
   `this.<shared>` references outside it (reviewer greps the extracted file).
4. No behavior change: extraction commits are move + port-wiring only; any fix found
   en route lands as its own car first.

## Sequencing vs the waiver

Waiver (`growth-waivers.json`) expires 2026-08-25 at ceiling 12,500. D1 alone restores
real headroom (~11,850); D1+D2 satisfy the payback target. If any runtime-touching car
must land before D1, it must fit the 27-line headroom or wait behind D1.
