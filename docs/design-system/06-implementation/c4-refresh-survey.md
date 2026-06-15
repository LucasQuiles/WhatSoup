# C4 Pre-Flip Refresh Survey — branding touchpoints vs the current tree

Re-audit (2026-06-12) of `05-cutover/branding-touchpoints.md` against the post-C2.3/B1
tree. Verdict: **the T7 audit remains fully authoritative** — zero occurrences vanished,
zero new occurrences introduced by the implementation slices, protected boundary intact.

## C4 build list (confirmed against today's code)

1. **Nameplate (heaviest lift):** Nav still renders the split What/Soup spans
   (Nav.tsx ~43-44). brand.md target: `[tick] SOUP` — Geist Mono 600 14/24 uppercase,
   +0.38em tracking with `margin-inline-end: -0.38em` compensation, translateY(0.5px)
   optical centering, 8×8px radius-1px tick in `--mode-passive-solid` teal, gap --sp-3.
2. **UI-copy flips (9 sites):** index.html title, UpdateModal "Update WhatSoup",
   Nav "Soup Kitchen" link, KeyboardShortcutsHelp "Go to Soup Kitchen", Ops empty-state
   copy, console-guide/README docs prose.
3. **Vocabulary drift flips (11 sites):** "Instances"→"Lines" headings/copy
   (SoupKitchen ~724/881, Ops ~122/141/283/288, ActivityFeed stop copy), alerts→
   unified "attention" (Nav ~153 dead span + AlertBanner), UpdateModal restart copy.
4. **Identifier rename:** SoupKitchen component/file → Fleet (4 src + ~28 test/import
   lines; use the touchpoints inventory, not grep alone).
5. **Favicon:** current purple/blue bolt is unrelated to SOUP; replace per brand.md
   (asset design needed — flag for the C4 frontend-design checkpoint).
6. **Test assertions (15 lines / 5 files):** update-modal, nav-status, nav, app,
   keyboard-shortcuts-help — all confirmed present at current line numbers.

## Protected boundary (verified intact, NEVER flips)

`whatsoup:` storage prefix (preferences.ts) · `/run/whatsoup/` socket paths ·
`~/.local/share/whatsoup/instances/` workspace paths · `mcp__whatsoup__*` namespace ·
ConfigStep generated agent contract ("via WhatSoup") · WhatSoupError / units (server-side).

## Sequencing note

The vocabulary flips (item 3) are spec'd as C3/C4-boundary copy work; the nameplate +
title + favicon + rename are the C4 flip proper. DD-5 (theme-toggle treatment) rides
the same Nav slice as the nameplate.
