# DD-8 Pre-Audit Survey — ghost-tier (text-3) essential-use inventory

Survey (2026-06-12) feeding the C3 per-screen checklists. Key alias fact verified:
legacy `text-t4` resolves to `--text-2` (NOT ghost) — only `text-t5`/`--text-3` is the
sub-AA ghost tier. Several initially-suspect sites are therefore already compliant.

## SPEC CONFLICT — needs a C3 design decision, not a unilateral fix

color.md §4–5: text-3 is **incidental ink only — never the sole carrier of a datum**.
But log-stream.md assigns the TIME LANE `--text-3` by design (`.soup-log__time`,
primitives.css ~1057), and the expanded-detail component name rides the same tier
(~1138). Either log timestamps are "metadata" (spec stands, color.md gets an explicit
carve-out) or they are load-bearing for operators (log-stream.md amends to --text-2).
**Decision owner: C3 checkpoint with frontend-design review.** Same judgment applies to
MessageBubble's timestamp (text-t5, ~line 154) and MessageContent file size/ext
(actually text-t4 = text-2 via alias — re-verify before listing as a fix).

## Essential-suspect shortlist (pending the decision above)

1. `.soup-log__time` (primitives.css ~1057) — log time lane.
2. `.soup-log__detail-component` (primitives.css ~1138) — component name in detail bed.
3. MessageBubble timestamp (text-t5) — B4 owns MessageBubble; fold into its slice.
4. Nav "Polling" badge + "All systems operational" copy (text-t5/t4) — icon-primary or
   text-primary is a Nav-slice (C3/DD-5) design call.

## Clean findings

- SoupKitchen, Inbox, Ops: all ghost uses decorative or already text-2 via alias — no action.
- Ops stats row: text-t4 = text-2 via alias — compliant (initial suspicion withdrawn).
- Icons, placeholders, separators, disabled states, em-dash ghosts, version tooltips,
  DEBUG chip (letter+border primary): compliant by design.
- Per-screen tallies recorded for the C3 checklist template (LineDetail ~35 uses with
  2–3 to audit; primitives 7 with the 2 above; dialogs 1 to confirm label tiering).
