# Brand — the SOUP nameplate, locked vocabulary, microcopy voice, and protected identity boundaries

v3.0.0-draft · G2-locked direction · pending G3

Sources: v2.html (locked nameplate), decision-log G1/G2 (vocabulary locks; open item 2 assigned
here), research-digest signal 11, inconsistency-register P2-11.

## 1. The SOUP nameplate

The wordmark is the **brand mark** — a round, dense, tightly-spaced display read matched to the
identity showcase. It is the single carrier of the product's playfulness budget; everything else
stays calm. (It supersedes the v2 mono "engraved instrument label": the showcase nav brand is the
Bricolage wordmark, so the console adopts it everywhere the SOUP mark appears.)

### 1.1 Anatomy

```
[tick] SO·U·P [· context subtitle]
```

- **Wordmark**: `SOUP` in `--type-nameplate` (Bricolage Grotesque **800 18/24**, the display face),
  uppercase, tight tracking `--tracking-tighter` (−0.06em ≈ showcase −0.055em), ink `--text-1`,
  `white-space: nowrap`. The **"U" is rendered in `--accent`** (`.soup-nameplate__accent`) — the one
  accent letter per the showcase brand wordmark.
- **Tick**: one 8×8px square, corner radius 1px, fill `--mode-passive-solid` — brand heritage
  teal, deliberately NOT the action accent. Sits before the wordmark at a `--sp-3` (12px) gap.
- **Subtitle** (optional, context label such as a page or build tag): IBM Plex Mono 400 11/16,
  +0.18em, `--text-2`; hides first under width pressure. (The context label stays mono — only the
  wordmark itself is the display face, mirroring the showcase `.wm` / `.ctx` split.)

### 1.2 Mandatory tuning rules (G2 open item 2 — resolved; updated for the display wordmark)

1. **Tracking.** The wordmark uses *negative* display tracking (`--tracking-tighter`), so — unlike
   the prior mono +0.38em spaced caps — there is no trailing letter-space to cancel. The old
   `margin-inline-end: -0.38em` compensation is removed. The subtitle keeps its mono +0.18em and its
   own −0.18em trailing-space cancellation.
2. **Optical centering.** The display face carries descenders and ordinary cap metrics, so the prior
   `translateY(0.5px)` mono cap-height offset no longer applies and is removed; the lockup
   flex-centers on its line box. Re-verify centering if the wordmark size/face changes again.
3. **Tick placement/size/color.** Tick is 8×8px, radius 1px, `--mode-passive-solid` in both themes,
   flex-centered with the wordmark. Gap to wordmark: `--sp-3`. The tick never animates, never glows,
   never recolors with status.
4. **Minimum clear space**: 12px (`--sp-3`) on all sides of the lockup; nothing may enter it.
   Minimum rendering size: the locked 18px style; the wordmark has no smaller variant — where 18px
   does not fit, the wordmark is omitted, not shrunk.

### 1.3 Forbidden treatments

No gradients. No illustration, no soup-bowl imagery, no mascot. No glow, shadow, or outline on the
mark. No lowercase or mixed-case rendering. No action-accent or status-colored tick. No use of
`--type-nameplate` for anything except this lockup (lint: `nameplate-reserved`). The kitchen
metaphor may survive only in naming history, never in imagery.

### 1.4 Identity-system extension (2026-06-13 follow-on direction)

The identity is a small **system**, not a single lockup: a favicon, minimal icon/badge marks, and
the text wordmark. The in-product **nameplate stays the locked instrument label** (§1.1–§1.3,
IBM-Plex-Mono engraved style) for console chrome. For friendlier brand-signal surfaces — landing,
identity, marketing — the wordmark may move toward a **round, dense, tightly-spaced** display read
(heavy round grotesque, **uppercase** — the §1.3 case discipline still binds — tracking ≈ −0.05 to
−0.06em) where the context calls for it. The favicon
and badge resolve to one legible glyph at 16px (primary: the round "S" monogram). All §1.3
forbidden treatments still bind: no bowls, mascots, gradients, glow, or second action accent; the
single electric-blue accent stays locked, and warmth comes from warmer neutral surfaces, not chroma.
This warmth is now implemented in the product surface ramp (decision-log #4): the neutral surface
ladders run warm (hue ~70°, chroma ≤ 0.012) in both themes per `tokens-v3.md` §2.8/§3.1, and the
pre-paint browser `theme-color` tracks the warm `--surface-base`. Reference exploration: standalone
identity showcase.

The primary mark is now **wired into the product** (G8): `console/public/favicon.svg` is the round
"S" monogram — a 32×32 `rx=7` accent square (`#6BA6FF`) with the flat `#0A0E14` "S", path-identical
to the identity-showcase Candidate A / in-product nav mark. The legacy purple/blue bolt
(`#863bff/#7e14ff/#47bfff`, display-p3, gaussian-blur glow, `<mask>` illustration) is retired. PWA
identity coverage ships alongside: `console/public/manifest.webmanifest` (name/short_name, warm
`theme_color`/`background_color`, a `maskable`-purpose icon) and `console/public/icon-maskable.svg`
(full-bleed accent, glyph inside the maskable safe zone), linked from `index.html` via
`<link rel="manifest">`.

### 1.5 Multi-channel positioning (2026-06-13 follow-on decision #5)

SOUP is positioned as **multi-channel/global fleet infrastructure**, not as a WhatsApp-only console.
Brand, marketing, navigation, empty-state, and generic UI copy must describe **conversational agents**,
**Lines**, **channels**, and **fleet operations**. Generic user-visible copy must not say "WhatsApp"
when the product concept is channel-agnostic.

The copy rule is deliberately scoped: runtime/protocol surfaces may still name the actual substrate.
Agent-facing generated prompts, channel-specific setup instructions, protocol identifiers, and future
channel-picker labels may say "WhatsApp" when they are naming a concrete integration rather than
positioning the product. The G7 copy sweep must classify each hit before editing it.

## 2. Locked vocabulary (G1)

| Concept | Was | Locked term |
|---|---|---|
| Product | WhatSoup | **SOUP** — the nameplate carries the playfulness |
| Dashboard | Soup Kitchen | **Fleet** |
| Managed object | line / instance (mixed) | **Line** — the single user-facing noun; "instance" demoted to process-level copy only |
| Channel scope | WhatsApp agents / WhatsApp console (generic copy) | **conversational agents**, **channels**, or **Lines** — channel names appear only in concrete integration/runtime contexts |
| Messages surface | Inbox | **Inbox** (kept) |
| Operations surface | Ops | **Ops** (kept) |
| Alerts | two competing definitions | one **attention** metric: lines not online; always a click-through |
| Modes | passive / chat / agent | unchanged — load-bearing |
| Status | online / degraded / unreachable / logged_out / config_error / unknown; unlinked linkage marker | locked taxonomy (shape-coded; badge.md) |

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

## 4. Protected product and channel boundary

"SOUP" is the **console-facing brand**. The platform, repo, packages, service units, and protocol
surface remain **WhatSoup** — renaming those is out of this program's scope and partially breaking.
The C4/G7 copy sweep uses three identifier classes:

| Class | Visible-copy action | Protected substrate |
|---|---|---|
| Product name | `WhatSoup` → `SOUP` in user-visible copy | `whatsoup:`, `mcp__whatsoup__`, `WhatSoupError`, service units, package/repo names, filesystem/socket paths |
| Channel name | generic "WhatsApp" positioning → channel-agnostic copy | `@s.whatsapp.net`, Baileys, JID, `conversation_key`, generated runtime prompts, concrete channel setup labels |
| Retired vocabulary | `Soup Kitchen` → `Fleet` | none |

The six `console/src` WhatSoup occurrences (inconsistency-register P2-11) are classified:

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

Channel rule: generic user-visible strings say "channel", "conversational agents", "Line", or
"Fleet" after G7; protocol code and generated agent/runtime prompts may continue to say WhatsApp
when they describe the actual channel. In particular, the `ConfigStep.tsx` default agent prompts
(`You are ... on WhatsApp`, `running on WhatsApp via WhatSoup`, delivered via WhatsApp) are
**PROTECTED** until a separate channel-platform rewrite changes the runtime contract. Baileys, JID,
`@s.whatsapp.net`, and `conversation_key` are also protected runtime vocabulary, not brand copy.

## 5. Enforcement hooks

`nameplate-reserved` (type token + class), vocabulary-drift review lane (grep list: "instance" in
user-visible strings outside process-level copy, "Soup Kitchen", "WhatSoup" outside the §4
PROTECTED list), `no-channel-specific-copy` / channel vocabulary guard (generic visible "WhatsApp"
outside the §4 protected channel contexts), forbidden-treatment review in the QA matrix (no
gradient/illustration assets in the console bundle).

`design:brand-assets` is the identity asset audit. The package script fail-closes the already-zero
canonical `/favicon.svg` shell link (`soup/brand-favicon-link-required`) and hard-fails peripheral
legacy copy / orphan public SVGs. SVG reachability must be proven by public-relative asset paths in
actual references; comments, prose, or basename-only mentions are not usage evidence. As of G8 the
visual asset lanes are **resolved to zero findings**: the favicon carries the SOUP identity palette
(no legacy bolt colors, no display-p3), no gradients/glow/masks remain in production brand assets,
the favicon canvas is square (32×32), and the HTML/PWA manifest path carries the maskable SOUP mark.
A PASS still means the inventory ran; the visual asset itself is approved by SSOT path-equivalence to
the identity-showcase Candidate A mark plus 16px legibility, not by the audit alone.

`console/index.html` owns document-shell brand/chrome hooks: the favicon link, PWA manifest link
when present, and browser `theme-color`. `theme-color` initializes to the dark `--surface-base`
semantic surface and runtime theme changes must sync it from computed `--surface-base`; it must not
define an independent browser-chrome color scale. The document `<title>` is **`SOUP Console`** —
landed 2026-07-19 with the C4 straggler packet (peripheral-audit P1; the vocabulary table in §2
governs: SOUP for the console UI, WhatSoup for the protected boundary), pinned exactly by
`tests/console/peripheral-brand-regression.test.ts` and `design-regression.sh` check 8.
