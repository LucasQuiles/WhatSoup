# Design Debt Register — SOUP v3 Implementation (SSOT)

Schema per qa-hardening §8. Status: open unless marked. Closed items move to the bottom table.
Lint waivers (WVR-*) live in `console/eslint-waivers.yaml` and are not duplicated here.

| ID | Title | Area | Type | Sev | Reason | Workaround | Owner / next step | Cleanup phase | Expiration condition | Blocks final acceptance? |
|---|---|---|---|---|---|---|---|---|---|---|
| DD-5 | Theme toggle minimal ghost button | component | component | P3 | final nav treatment belongs with nameplate work | functional toggle shipped | C3 nav slice | C3 | nameplate slice merged | no |
| DD-8 | text-3/ghost-tier essential-use audit | color | accessibility | P2 | ghost tier intentionally sub-AA for decorative metadata; some call sites may carry essential text | spec restricts tier usage | per-screen C3 checklists | C3 | every screen migration confirms no essential text on ghost tier | YES |
| DD-9 | Legacy half-step spacing aliases (--sp-0h/1h/2h, 14px/7px) | layout | token | P3 | consumed by composites pending migration | tokens-v3 disposition mapped | per-directory C2/C3 | C3 | composites absorbed into primitives | no |
| DD-10 | 24px target floor: class-level proof only | accessibility | test | P2 | jsdom cannot compute CSSOM boxes; pseudo-element hit areas invisible to unit tests | class-contract assertions | D7: Playwright/CSSOM computed-box checks (incl. sm pill + removable X) | D7 | computed-box evidence for every interactive primitive | YES |
| DD-12 | LinePicker lacks combobox semantics (+ compact StatusCell treatment) | a11y/component | component | P2 | custom dropdown predates primitives | works mouse/Enter | LinePicker slice (B2): combobox/listbox pattern + arrow keys | C2 | WAI combobox contract + keyboard tests | YES |
| DD-13 | TagInput duplicates removable Pill; unlabeled remove buttons | component | component | P2 | predates Pill | functional | migrate to Pill variant=removable (B2) | C2 | TagInput renders via Pill; remove buttons labeled | YES |
| DD-14 | CardSelector radio-like without radio semantics | a11y | component | P2 | visual-only selection state | works with pointer | radiogroup/aria-checked pattern (B2) | C2 | wizard keyboard tests pass | YES |
| DD-15 | Segmented controls hand-rolled ×3+ | component | component | P3 | no shared primitive | c-btn toggles; ToolbarTimeRange (C2.3) is the canonical seg pattern to migrate onto | migrate remaining sites (B2) | C2/C3 | all segmented sites migrated | no |
| DD-16 | Search-picker family ×3 divergent (ChatPicker/ContactSearchPicker/ContactSearch) | component | component | P2 | pre-primitive popovers | functional | one picker composite (combobox+listbox) (B2) | C2/C3 | one implementation; orphan ContactSearch removed | YES |
| DD-17 | Inbox chat list partial listbox (no arrow nav/active-descendant) | a11y | component | P2 | predates interaction spec | Enter/Space works | Inbox slice (B4) | C3 | arrow-key contract tested | YES |
| DD-18r | Responsive hardening backlog — REMAINING legs after C2.3+B1: Inbox three-pane collapse path, legacy modal sizing SSOT, nav width pressure beyond label hiding, MessageBubble hover-card positioning, side-panel law for non-Fleet surfaces, deterministic viewport tests | responsive | layout | P1 | surfaces predate layout-density spec | desktop-first works | each named surface slice (B3/B4) + D7 viewport tests | C3/D7 | every named item PASS or NOT-APPLICABLE in the QA matrix | YES |
| DD-19 | Modal/Drawer exit motion instant; background inert/aria-hidden not implemented | motion/a11y | motion | P2 | exit animation needs unmount-delay machinery (Drawer follows Modal's unmount-on-close) | instant exit (reduced-motion-equivalent); focus trap contains | motion-polish stage (D5/B5) | D5/C3 | paired exit motion + inert background or documented exception | no |
| DD-20 | Framer Motion transitions hard-coded on 4 pages (no useReducedMotion path) | motion | motion | P2 | predates motion spec; global CSS policy does not reach JS-driven springs | CSS-driven motion neutralized globally | page slices: MotionConfig reducedMotion="user" at app root (B5) | C3/D5 | app-level MotionConfig + spot checks | YES |
| DD-21r | Wizard/modal tablists incomplete keyboard contracts (ConfigStep, ModelAuthStep, GroupDetailModal — REMAINING after B1 delivered the Tabs primitive and migrated LineDetail) | a11y | component | P1 | predates interaction spec | mouse + some Enter handlers | migrate onto Tabs primitive (B2/B3 slices) | C2/C3 | tablist keyboard contract tests per site | YES |
| DD-22 | LogStream renders bounded poll snapshots; no virtualization/live-tail streaming | component | component | P3 | log-stream.md requires virtualization for unbounded data; today getLogs returns bounded snapshots polled at 3s — no streaming source exists | bounded render + maxEntries tail cap (drawer last-50) | LogStream maturity slice; product decision required for SSE/WS log streaming | future | before any live-tail/streaming log feature ships | no |

## Closed

| ID | Title | Closed by | Evidence |
|---|---|---|---|
| DD-6 | Status shape law not rendered | C2.1 `fb67b43f` | c2-1-evidence.md |
| DD-7 | No modal focus-restoration primitive | C2.2 `59ceeb4f` | c2-2-evidence.md |
| DD-4 | Geist via Google Fonts runtime import | self-hosted woff2 (vercel/geist-font v1.7.2, SIL OFL 1.1; sha256 provenance in console/public/fonts/README.md); CDN import removed | fonts.css + public/fonts on feat/soup-v3-foundation |
| DD-18 (Fleet legs) | Fleet KPI/chart/table stacking + squeeze, chart-expand layout animation, log wrap policy, fixed side-panel law for Fleet (drawer squeeze 900px container), Fleet pane stacking below lg + short-window page scroll | C2.3 `1f9bde39` + `682558f7` + stacking fix | c2-3-evidence.md (live QA rounds 1–3, both themes, 390/768/1024/1280/1440 + 1440×500) |
| DD-21 (Fleet table half) | Fleet table mouse-first th/tr onClick, no keyboard | C2.3 `1f9bde39` (TableHeaderCell sort buttons + aria-sort; row Enter activation; tested) | c2-3-evidence.md |
| DD-11 | SummaryTab connection-health map outside status-map | B1 `048a26f7` (CONNECTION_MAP/resolveConnection, fail-visible, tested) | b1-evidence.md |
| DD-21r (LineDetail leg) | LineDetail hand-rolled tablist, no keyboard | B1 `d7feb2a4`+`3f4e4d0b` (Tabs primitive + adoption, live-verified) | b1-evidence.md |
| DD-18r (LineDetail leg) | LineDetail header/tabs overflow | B1 `92deece2`+`883a13b4` (truncation, wrap, identity floor, governed tab x-scroll — live-measured) | b1-evidence.md |
