# Daily-Health Receipt Mode Repair — Legacy Leaf Self-Heal

Operator reference for the automatic in-process repair in
`record_daily_health_receipt()` (`deploy/scripts/bot-errors-health-check.py`).

Status: automatic. There is no operator script to run and no manual step in the
normal case. This document exists so an operator can recognise the repair in the
logs, and can tell a repair from a refusal.

---

## Problem

`ensure_private_dir()` re-applies `0700` to the BOT ERRORS state directory on
every cycle. Nothing performed the equivalent repair on the leaf file. A
`daily-health-receipt.json` published before the strict durable reader was
adopted therefore keeps its pre-adoption mode — `0644` on the reported host —
forever.

The strict reader (`deploy/scripts/lib/durable_json.py`, `observe_json()`)
forbids any bit in `0o077` on a private target. So every subsequent daily cycle
observed the legacy receipt, rejected it with `DurableWriteError: permission`,
and never published a successor.

The failure is quiet in a specific and dangerous way. The daily-health outbox
event is queued *before* the receipt is published, so a queued event is not
evidence that the cycle completed. An operator watching the outbox sees success
while the cycle is in fact failing.

---

## What the repair does

Before observing the receipt, the cycle attempts one in-place mode repair:

- It clears **every bit in `0o077`** from the leaf. It does not special-case
  `0644`. `0640` and `0604` fail the reader in exactly the same way and are
  repaired the same way.
- It keeps the bytes and the inode. The legacy payload is left intact so the
  reader can still read it as the predecessor and carry its identity into the
  successor's publication.
- It records the pre-repair mode in two places: a stderr log line, and the
  `legacyReceiptModeRepairedFrom` field on the successor receipt.

The successor is then published at the target's `final_mode`, which is exactly
`0600` for a private target.

The repair is confined to the daily-health receipt. It is not a general sweep of
every durable state file.

---

## Ownership guards

The repair narrows permissions on a file that is, by definition, currently more
permissive than it should be — which is the exact condition an attacker would
have exploited. So it proves ownership before it touches the mode. Every guard
is evaluated against the same descriptor that is then `fchmod`ed, so the inode
that was checked and the inode that is modified cannot differ.

| Guard | Refusal code |
| ----- | ------------ |
| Leaf is not a symlink (opened `O_NOFOLLOW`) | `symlink` |
| Leaf is a regular file | `not_regular` |
| Leaf is owned by the executing UID | `foreign_owner` |
| Leaf has exactly one hard link | `multiple_links` |
| Parent is not group- or world-writable | `parent_writable` |
| Parent is stat-able | `parent_unreadable` |
| `O_NOFOLLOW` is available on this platform | `unsupported_capability` |
| Leaf could not be opened or chmod'ed | `unopenable` |

The repair runs *before* `ensure_private_dir()`, deliberately.
`ensure_private_dir()` re-applies `0700` to the state root, so running it first
would narrow a group- or world-writable root and hand the parent guard a
sanitized value — erasing the very signal that the leaf may have been planted.

A refusal never chmods, never raises, and leaves the leaf byte- and
mode-identical. The strict reader downstream stays the sole authority on whether
the leaf may be used, so a refused repair still fails the cycle closed rather
than masking the problem.

---

## Reading the logs

Repaired, the normal one-time case on a host carrying a legacy receipt:

```
[bot-errors-health] daily-health receipt mode repaired from 0644
```

This appears once. The next cycle finds a compliant `0600` receipt, repairs
nothing, and logs nothing.

Refused:

```
[bot-errors-health] daily-health receipt mode repair refused: foreign_owner
```

The cycle then fails with `DurableWriteError: permission` (or `identity_type`
for a symlink) from the reader, as it did before this change.

---

## Operator response to a refusal

A refusal means the receipt on that host is not what the health check is
entitled to modify. Do not chmod it by hand to get the cycle green — that
destroys the evidence of why it was refused.

1. Capture the current state before changing anything:
   ```
   ls -lni "$BOT_ERRORS_STATE_DIR/daily-health-receipt.json"
   ls -ldn "$BOT_ERRORS_STATE_DIR"
   ```
   `-n` gives numeric owner, `-i` gives the inode, and `ls -l` marks a symlink.
2. Match the output to the refusal code in the table above.
3. `foreign_owner`, `multiple_links` and `symlink` on a host that should have
   neither are a possible tampering signal, not a permissions nuisance.
   Preserve the file and escalate before repairing.
4. `parent_writable` means the state root itself is group- or world-writable.
   Fix the directory first; the leaf repair will then run on the next cycle.
5. The receipt is a receipt, not a source of truth. Once the cause is
   understood, deleting the leaf is a valid recovery: the next cycle observes an
   absent predecessor and publishes a fresh receipt at generation 1.

---

## Publication metadata

`record_daily_health_receipt()` returns the `PublicationResult`, whose
`generation` is advanced past the predecessor's. The legacy on-disk format
carries no `generation` field, and this repair does not synthesize one, so the
predecessor reads as generation-absent and the successor publishes at
generation 1.

Neither `generation` nor `operationId` is written into the receipt payload. That
is the pre-existing on-disk format and the repair does not change it. It is also
not a free choice for `operationId`: the operation id is a hash over the
payload, so embedding it in the payload would change the hash it is checked
against.

The one field this change does add to the successor is
`legacyReceiptModeRepairedFrom`, and only on the single cycle that performed a
repair.

---

## Scope note

The same latent hazard exists at every private durable site listed in
`deploy/bot-errors-durable-writer-inventory.json`; the daily-health receipt is
one row (`health-check-daily-health-receipt`). Any state file written before the
strict reader was adopted would fail the same way. This repair covers the
daily-health receipt only. A wider sweep has not been surveyed and is not
claimed here.
