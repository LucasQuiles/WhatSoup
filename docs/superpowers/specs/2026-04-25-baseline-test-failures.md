# Baseline Test Failures — Closed 2026-04-25

| Field | Value |
|---|---|
| Snapshot date | 2026-04-25 |
| Original anchor SHA | `29a0baf` (main) |
| jsx-runtime fix SHA | `df6d07f` (Groups A + C resolved) |
| instance-loader fix | this commit (Group B resolved) |
| Status | **0 baseline failures remain — baseline is clean** |
| Drift detection | Invoked via `scripts/check-baseline-test-drift.sh` |

---

## Summary

All baseline failures resolved.

| Error class | Count | Resolution |
|---|---|---|
| Console JSX runtime (`@esbuild-kit` collection failures) | 3 | Resolved at `df6d07f` |
| `ENOENT instances/loops/instance.json` | 1 | Resolved in this commit (sanitized inline fixture) |
| **Total** | **0 remaining** | |

---

## Drift detection format

The blocks below are the canonical machine-readable form consumed by `scripts/check-baseline-test-drift.sh`. Both blocks are intentionally empty — the baseline is clean.

```baseline-failures
```

```collection-failures
```
