# Brand — the SOUP nameplate, locked vocabulary, microcopy voice, and the protected WhatSoup boundary

v3.0.0-draft · G2-locked direction · pending G3

Sources: v2.html (locked nameplate), decision-log G1/G2 (vocabulary locks; open item 2 assigned
here), research-digest signal 11, inconsistency-register P2-11.

## 1. The SOUP nameplate

The nameplate is an **engraved instrument label, not a logotype**. It is the single carrier of the
product's playfulness budget; everything else stays calm.

### 1.1 Anatomy

```
[tick] SOUP [· context subtitle]
```

- **Wordmark**: `SOUP` in `--type-nameplate` (Geist Mono 600 14/24), uppercase, letter-spacing
  +0.38em, ink `--text-1`, `white-space: nowrap`.
- **Tick**: one 8×8px square, corner radius 1px, fill `--mode-passive-solid` — brand heritage
  teal, deliberately NOT the action accent. Sits before the wordmark at a `--sp-3` (12px) gap.
- **Subtitle** (optional, context label such as a page or build tag): Geist Mono 400 11/16,
  +0.18em, `--text-2`; hides first under width pressure.

### 1.2 Mandatory tuning rules (G2 open item 2 — resolved)

1. **Tracking compensation.** CSS letter-spacing adds the full 0.38em *after every glyph including
   the last*, so the wordmark's visual right edge is ~0.38em short of its box. The wordmark element
   MUST cancel the trailing space: `margin-inline-end: -0.38em` (negative margin exactly equal to
   the tracking value, in the same em units so it scales with any future size change). Without
   this, centered or right-aligned lockups read off-center. The same rule applies to the subtitle
   at its own −0.18em. Centering math must use the corrected box.
2. **Optical centering against bar height.** The wordmark is all-caps mono: no descenders, so the
   24px line box carries dead space below the baseline. When vertically centering inside chrome
   (the 56px header bar), align the **cap-height midpoint**, not the line box: flex-center the
   lockup, then apply `translateY(0.5px)` at the 14px size (half the difference between line-box
   center and cap-height center for Geist Mono caps). This offset is a declared optical correction
   (layout-density §1 exception) and re-derives if the nameplate size ever changes.
3. **Tick placement/size/color.** Tick is 8×8px (cap-height-scaled: ~0.78× cap height), radius
   1px, `--mode-passive-solid` in both themes, vertically aligned to the cap-height midline using
   the same optical offset as rule 2. Gap to wordmark: `--sp-3`. The tick never animates, never
   glows, never recolors with status.
4. **Minimum clear space**: 12px (`--sp-3`, ≈ one cap height) on all sides of the lockup; nothing
   may enter it. Minimum rendering size: the locked 14px style; the nameplate has no smaller
   variant — where 14px does not fit, the nameplate is omitted, not shrunk.

### 1.3 Forbidden treatments

No gradients. No illustration, no soup-bowl imagery, no mascot. No glow, shadow, or outline on the
mark. No lowercase or mixed-case rendering. No action-accent or status-colored tick. No use of
`--type-nameplate` for anything except this lockup (lint: `nameplate-reserved`). The kitchen
metaphor may survive only in naming history, never in imagery.

## 2. Locked vocabulary (G1)

| Concept | Was | Locked term |
|---|---|---|
| Product | WhatSoup | **SOUP** — the nameplate carries the playfulness |
| Dashboard | Soup Kitchen | **Fleet** |
| Managed object | line / instance (mixed) | **Line** — the single user-facing noun; "instance" demoted to process-level copy only |
| Messages surface | Inbox | **Inbox** (kept) |
| Operations surface | Ops | **Ops** (kept) |
| Alerts | two competing definitions | one **attention** metric: lines not online; always a click-through |
| Modes | passive / chat / agent | unchanged — load-bearing |
| Status | online / degraded / unreachable / unlinked | locked taxonomy (shape-coded; badge.md) |

One term per concept; synonyms in UI copy are lint-findable vocabulary drift.

## 3. Microcopy voice

Professional, calm, precise, slightly playful-ambiguous — the playfulness lives in the name, not
in the copy. Rules with examples:

| Rule | Do | Don't |
|---|---|---|
| Sentence case, plain verbs | "Add line" · "Mark read" | "ADD LINE!" · "Create New Line" |
| State consequence, then preserve calm | "The line goes offline until restarted. Queued messages (7) are preserved." | "Are you sure?? This is dangerous!" |
| Errors: specific + fix + example | "Error: use E.164 format, for example +15550123." | "Invalid input." |
| Numbers are data, not drama | "2 lines need attention" | "⚠ CRITICAL ALERTS DETECTED" |
| Remedies always offered | "Couldn't load metrics … Retry" | error text with only a Close button |
| Empty states orient, then route | "No chats yet. Conversations on this line will appear here once messages arrive." | "Nothing here :(" |
| No exclamation marks in operational copy; at most one in a success toast | "Line billing created and linked." | "Success!!!" |
| Time/identity rendered in data lane | `14:32:07` · `+1 555-0104` (mono, tabular) | prose-formatted timestamps in tables |

## 4. Protected WhatSoup boundary

"SOUP" is the **console-facing brand**. The platform, repo, packages, service units, and protocol
surface remain **WhatSoup** — renaming those is out of this program's scope and partially breaking.
The six `console/src` occurrences (inconsistency-register P2-11) are classified:

| Occurrence | Class | Action |
|---|---|---|
| `console/src/components/wizard/ConfigStep.tsx` (system-prompt copy referencing WhatSoup) | **PROTECTED** | The prompt text is part of the runtime/agent contract surface; renaming alters agent behavior. Do not touch in the reskin. |
| `console/src/types.ts` (contract identifiers/comment header) | **PROTECTED** | Type names align with the server API contract; renaming is an API-surface change, not a reskin. |
| `console/src/hooks/use-fleet.ts` (contract identifiers/comment header) | **PROTECTED** | Same contract alignment; fetch-layer identifiers stay. |
| `console/src/components/UpdateModal.tsx` (user-visible copy) | **UI-flip at P4** | User-visible string; flips to SOUP in the C4 rename sweep. |
| `console/src/mock-data.ts` (comment header) | **UI-flip at P4** | Cosmetic; sweep at P4. |
| `console/src/hooks/use-keyboard-shortcuts.ts` (comment header) | **UI-flip at P4** | Cosmetic; sweep at P4. |

Rule: user-visible strings say SOUP after P4; code identifiers, API contracts, and agent-facing
prompt text say WhatSoup until a separate, explicitly approved platform-rename program exists. The
P4 sweep must verify each flip is render-only (no identifier, storage key, or protocol string).

## 5. Enforcement hooks

`nameplate-reserved` (type token + class), vocabulary-drift review lane (grep list: "instance" in
user-visible strings outside process-level copy, "Soup Kitchen", "WhatSoup" outside the §4
PROTECTED list), forbidden-treatment review in the QA matrix (no gradient/illustration assets in
the console bundle).
