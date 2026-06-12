# Design Debt Register — SOUP v3 Implementation (SSOT)

Schema per qa-hardening §8. Status: open unless marked. Closed items move to the bottom table.
Lint waivers (WVR-*) live in `console/eslint-waivers.yaml` and are not duplicated here.

| ID | Title | Area | Type | Sev | Reason | Workaround | Owner / next step | Cleanup phase | Expiration condition | Blocks final acceptance? |
|---|---|---|---|---|---|---|---|---|---|---|
| DD-4 | Geist via Google Fonts runtime import | typography | token | P2 | font files unavailable offline at C1 | CDN import + full fallback stacks | impl agent / self-host woff2 under console/public/fonts | C2 | self-hosted before any deploy; hard 2026-07-31 | YES (deploy gate) |
| DD-5 | Theme toggle minimal ghost button | component | component | P3 | final nav treatment belongs with nameplate work | functional toggle shipped | C3 nav slice | C3 | nameplate slice merged | no |
| DD-8 | text-3/ghost-tier essential-use audit | color | accessibility | P2 | ghost tier intentionally sub-AA for decorative metadata; some call sites may carry essential text | spec restricts tier usage | per-screen C3 checklists | C3 | every screen migration confirms no essential text on ghost tier | YES |
| DD-9 | Legacy half-step spacing aliases (--sp-0h/1h/2h, 14px/7px) | layout | token | P3 | consumed by composites pending migration | tokens-v3 disposition mapped | per-directory C2/C3 | C3 | composites absorbed into primitives | no |
| DD-10 | 24px target floor: class-level proof only | accessibility | test | P2 | jsdom cannot compute CSSOM boxes; pseudo-element hit areas invisible to unit tests | class-contract assertions | D7: Playwright/CSSOM computed-box checks (incl. sm pill + removable X) | D7 | computed-box evidence for every interactive primitive | YES |
| DD-11 | SummaryTab connection-health map outside status-map | status | helper | P2 | adjacent taxonomy not yet folded | separate map functions | SummaryTab C2/C3 slice | C3 | imports status-map or documented as distinct domain | no |
| DD-12 | LinePicker lacks combobox semantics (+ compact StatusCell treatment) | a11y/component | component | P2 | custom dropdown predates primitives | works mouse/Enter | LinePicker slice: combobox/listbox pattern + arrow keys | C2 | WAI combobox contract + keyboard tests | YES |
| DD-13 | TagInput duplicates removable Pill; unlabeled remove buttons | component | component | P2 | predates Pill | functional | migrate to Pill variant=removable | C2 | TagInput renders via Pill; remove buttons labeled | YES |
| DD-14 | CardSelector radio-like without radio semantics | a11y | component | P2 | visual-only selection state | works with pointer | radiogroup/aria-checked pattern | C2 | wizard keyboard tests pass | YES |
| DD-15 | Segmented controls hand-rolled ×3+ | component | component | P3 | no shared primitive | c-btn toggles | SegmentedControl primitive | C2/C3 | all segmented sites migrated | no |
| DD-16 | Search-picker family ×3 divergent (ChatPicker/ContactSearchPicker/ContactSearch) | component | component | P2 | pre-primitive popovers | functional | one picker composite (combobox+listbox) | C2/C3 | one implementation; orphan ContactSearch removed | YES |
| DD-17 | Inbox chat list partial listbox (no arrow nav/active-descendant) | a11y | component | P2 | predates interaction spec | Enter/Space works | Inbox slice | C3 | arrow-key contract tested | YES |
| DD-18 | Responsive hardening backlog (wave-7): Fleet KPI/chart/table stacking + squeeze, Inbox collapse path, LineDetail header/tabs overflow, legacy modal sizing SSOT, nav width pressure, log wrap policy, MessageBubble hover-card positioning, side-panel law, chart-expand layout animation (incl. SoupKitchen inline flex/width drives), viewport tests | responsive | layout | P1 | surfaces predate layout-density spec | desktop-first works | each named surface slice + D7 viewport tests | C3/D7 | every named item PASS or NOT-APPLICABLE in the QA matrix | YES |
| DD-19 | Modal exit motion instant; background inert/aria-hidden not implemented | motion/a11y | motion | P2 | exit animation needs unmount-delay machinery | instant exit (reduced-motion-equivalent); focus trap contains | motion-polish stage (D5) | D5/C3 | paired exit motion + inert background or documented exception | no |
| DD-20 | Framer Motion transitions hard-coded on 4 pages (no useReducedMotion path) | motion | motion | P2 | predates motion spec; global CSS policy does not reach JS-driven springs | CSS-driven motion neutralized globally | page slices: MotionConfig reducedMotion="user" at app root | C3/D5 | app-level MotionConfig + spot checks | YES |
| DD-21 | Fleet table mouse-first (th/tr onClick, no keyboard) + tabs/wizard tablists incomplete | a11y | component | P1 | predates interaction spec | mouse + some Enter handlers | Table primitive slice (sortable header buttons, row focus model); Tabs primitive | C2 | keyboard contract tests | YES |

## Closed

| ID | Title | Closed by | Evidence |
|---|---|---|---|
| DD-6 | Status shape law not rendered | C2.1 `fb67b43f` | c2-1-evidence.md |
| DD-7 | No modal focus-restoration primitive | C2.2 `59ceeb4f` | c2-2-evidence.md |
