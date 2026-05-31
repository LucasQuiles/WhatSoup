# Evidence Packet: Reconnect Backoff / Cooldown / Exhaustion

**Date:** 2026-04-06
**Collected by:** Q (orchestrator)
**Test file:** `tests/transport/reconnect.test.ts`
**Result:** 21/21 PASS

## Algorithmic Coverage

### Backoff Sequence (3 tests)
- ✓ First disconnect → 1s backoff
- ✓ Successive failures → exponential: 1s, 2s, 4s
- ✓ Backoff caps at 60s regardless of attempt count

### Phase Transitions (4 tests)
- ✓ After 10 backoff failures → enters cooldown phase (no immediate reconnect)
- ✓ After cooldown expires → retries with fresh reconnect attempt
- ✓ Successful connection → resets all counters (reconnectAttempts=0, phase=backoff, firstFailureAt=null)
- ✓ `restartRequired` disconnect → immediate reconnect without backoff

### Terminal Conditions (4 tests)
- ✓ `loggedOut` disconnect → no reconnect scheduled (terminal)
- ✓ 30-minute total failure window → emits `exhausted` event (no process.exit)
- ✓ Successful connection mid-cooldown → cancels cooldown, resets everything
- ✓ Exhausted failure window → triggers graceful reconnect attempt

### Connection State (2 tests)
- ✓ botJid and botLid cleared on disconnect
- ✓ Keepalive ping/pong after connection opens

### Event Handlers (6 tests)
- ✓ contacts.upsert → contactsUpsert event
- ✓ contacts.update → contactsUpdate event
- ✓ messages.update with editedMessage → messageEdited event
- ✓ messages.delete → messageDeleted event
- ✓ presence.update → presenceUpdate event + cache update
- ✓ call event → callReceived + auto-reject when configured

### Keepalive (2 tests)
- ✓ Periodic ping queries + pong timestamp recording
- ✓ Failed keepalive → triggers fresh reconnect

## Source Files Verified
- `src/transport/connection.ts:842-958` — backoff/cooldown/exhaustion path
- `src/transport/connection.ts:1171-1238` — reconnect scheduling logic

## SEC4/SEC5 Status
Both merged per state.md. Reconnect backoff with exponential increase, cooldown phase, and 30-minute exhaustion window all verified via unit tests.

## Live Reconnect Note
No live reconnect log capture was performed in this session. The above covers algorithmic correctness only. A live reconnect scenario should be captured during the next production deployment cycle.
