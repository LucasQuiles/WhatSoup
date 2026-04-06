# LEAK-04 Output

<!-- BEAD_OUTPUT_COMPLETE -->

- Bead: LEAK-04 — workspace resource idle eviction
- Branch: fix/leak-04-workspace-eviction
- Commit: 2ed7364
- Summary: Added idle eviction for sandbox-per-chat workspace socket/media resources with `lastActivity` tracking, a 30m sweep window, shutdown timer cleanup, and regression coverage for eviction, active-session protection, re-creation, result touches, and timer lifecycle.

## Files Changed
- src/runtimes/agent/runtime.ts
- tests/runtimes/agent/runtime.test.ts
- bead-output.md

## Verification
- `npx vitest run tests/runtimes/agent/runtime.test.ts` ✅
- `npm run typecheck` ✅
- `npx vitest run tests/console/line-detail-history-metrics.test.ts tests/console/modal-workflows.test.ts tests/console/nav-status.test.ts tests/console/ops-actions.test.ts tests/console/soup-kitchen.test.tsx` ✅
- `npx vitest run` ⚠️ fails on pre-existing `tests/console/design-system-scheduled-groups-primitives.test.ts` (`ContactSearchPicker` still contains `bg-d1`), reproduced on the repo main checkout at `/home/q/LAB/WhatSoup` too.

## Notes
- `workspaceResources` now carry `lastActivity`, refreshed on workspace provisioning, delivery-JID/media-bridge updates, active-session sweeps, and per-chat result completion.
- The workspace sweep timer is sandbox-per-chat only, unref'd, and cleared during shutdown.
- Full-suite verification needed corrected worktree dependency links (`node_modules` and `console/node_modules`) before reproducing the unrelated console failure.
