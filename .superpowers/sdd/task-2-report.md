# Task 2 report — strict shared runtime readiness

## Result

- Commit: `fix(transport): require strict runtime readiness`
- Scope: runtime readiness only; no `bot.db`, manager/host branching, live/external changes, deploy edits, or controller changes.
- #2674 remains unchanged.

## RED

1. `npx vitest run --pool=forks tests/main-bootstrap-helpers.test.ts -t 're-arms instead of announcing until the transport is fully connected'`
   - Failed as expected: startup sent the notice for `{ connected: true, state: 'reconnecting' }`.
2. `npx vitest run --pool=forks tests/transport/runtime-connection.test.ts`
   - Failed as expected: the absent shared predicate returned `false` for the sole fully-ready truth-table row.

## GREEN

- `bash scripts/run-with-pinned-npm.sh test -- tests/core/health.test.ts --pool=forks` — 166 passed.
- `bash scripts/run-with-pinned-npm.sh test -- tests/transport/runtime-connection.test.ts tests/transport/factory.test.ts tests/main-bootstrap-helpers.test.ts --pool=forks` — 100 passed.
- `bash scripts/run-with-pinned-npm.sh test -- tests/transport/twilio/connection-bridge.test.ts --pool=forks` — 24 passed.
- `bash scripts/run-with-pinned-npm.sh test -- tests/transport/reconnect.test.ts --pool=forks` — 57 passed.
- `bash scripts/run-with-pinned-npm.sh run typecheck` — passed.
- `bash scripts/run-with-pinned-npm.sh run guard:boundaries` — passed.
- `bash scripts/run-with-pinned-npm.sh run guard:transport-patterns` — passed.
- `bash scripts/run-with-pinned-npm.sh run guard:import-cycle` — passed.
- Strict readiness static guard confirmed no optional accessor or `?? true` fallback in startup/health; exactly one `connected === true && state === 'connected'` predicate; scheduler optional port remains unchanged.
- Test-integrity scan — no findings. `git diff --check` — clean.

## Inventory and implementation

- `RuntimeConnection.getConnectionState()` is mandatory.
- `isFullyConnected(snapshot)` is exported by the runtime-connection boundary and owns the full-readiness predicate.
- Startup, public health, diagnostic health, auth/disconnect classification use it for full readiness.
- The only retained raw `connectionState.connected` in health is documented as the non-readiness credential-write race diagnostic.
- Adapter/factory coverage calls bounded snapshots across Baileys, Twilio, Signal, and iMessage.
- The scheduler's core-local optional connection port was inspected and left unchanged.

## Files

- Source: `src/transport/runtime-connection.ts`, `src/core/health.ts`, `src/main.ts`, and Twilio/iMessage bridge comments.
- Tests: health, startup bootstrap helper, runtime boundary truth table, factory adapter coverage, Twilio bridge, and reconnect.

## Self-review and risks

- Reviewed the final diff for duplicated predicates, removed synthetic health fallback behavior and its obsolete test, and verified no runtime import cycle.
- An initial unpinned factory run hit a local `re2` Node-ABI mismatch, so it was inconclusive rather than treated as green. All reported test evidence uses the repository's pinned Node wrapper.
- A combined six-file test invocation ended without a final receipt; it is likewise inconclusive. Its individual focused suites were re-run successfully and are the GREEN evidence above.
