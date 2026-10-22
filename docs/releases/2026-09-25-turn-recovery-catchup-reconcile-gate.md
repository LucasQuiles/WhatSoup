# 2026-09-25 Turn-Recovery Catch-Up Reconciler Gate

## Public surface additions

- `agentOptions.turnRecoveryCatchupReconcile` (instance `config.json`) turns on
  the turn-recovery supervisor's automatic operator catch-up reconciler for one
  instance: `{ "enabled": true, "groupLimit": 50 }`. `enabled` is a required
  boolean inside the block; `groupLimit` is an optional integer from 1 to 1000
  (default 50). The block is a closed shape: an unknown inner key or an invalid
  value is a load-time `ConfigValidationError`. See
  [configuration.md §agentOptions](../configuration.md#agentoptions) and the
  [enabling guide](../turn-recovery-continuity-reconciler.md#enabling-per-instance).

## Behavioral changes

- None by default. Without the block, or with `enabled: false`, the supervisor
  behaves exactly as before. The value is read once at startup, so enabling or
  disabling it takes an instance restart.
- With the gate on, each scan cycle closes up to `groupLimit` recovery groups
  whose conversation already received a delivered catch-up reply. Closure rows
  carry `actor = 'auto_reconciler'`, and each pass that closes at least one
  group logs `turn recovery catch-up reconciler closed caught-up groups` at
  info level.
