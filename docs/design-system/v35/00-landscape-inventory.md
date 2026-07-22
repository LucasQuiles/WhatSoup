# 00 — Landscape Inventory (as-audited 2026-07-21)

Sources: `restart-reliability` worktree (branch `fix/q-restart-reliability`),
`docs/design-system/**`, `console/**`. Line counts from the v3 program's own verified census.

## 1. Stack (verified v3 program census A1)

React 19.2.4 · Vite 8 · Tailwind 4.2 · TS 5.9 · react-router-dom 7 · framer-motion 12.38 ·
lucide-react 1.7 · recharts 3.8 · @tanstack/react-query 5.96 · react-table 8.21 · react-virtual 3.13.
Console LOC ≈ 18K (ts/tsx/css). Route-level code splitting per page.

## 2. Surfaces (routes)

| Route | Page | Role |
|---|---|---|
| `/` | SoupKitchen ("Fleet") | Fleet dashboard: KPI cards, fleet charts (metrics/session/token), lines table, activity feed, heartbeat strip, log stream |
| `/welcome` | Landing | SOUP hero + 3 value-prop cards + CTA into console (single page) |
| `/lines/:name` | LineDetail | Per-line ops: 9 tabs — Summary, Mode, Access, Groups, Metrics, Logs, Pipeline, Scheduled, History |
| `/inbox` | Inbox | Chat list + thread + contact pane (virtualized messages) |
| `/metrics` | Metrics | Fleet-level metrics (60s poll) |
| `/operator` | Operator | Ops surface (alias `/ops`) |

Global chrome: left nav rail with SOUP nameplate, CommandPalette, KeyboardShortcutsHelp,
UnlockScreen, UpdateModal, ConnectionBanner (transport-loss state), Toast system.

## 3. Component inventory

- **Primitives (25):** Accordion, ActionButton, Avatar, Badge, Button, Calendar, Card, Checkbox,
  DateTimePicker, Drawer, FormControl, HoverCard, InlineEdit, LogStream, Menu, Modal, Pill,
  Popover, Segmented, Stepper, Switch, Table, Tabs, Toolbar, Tooltip.
- **Feature components (~35):** charts (Fleet/Metrics/Session/Token/ChartPanel), feed (FeedCard,
  ActivityFeed, FeedIcon), chat (ChatList(Item), MessageBubble(Content)), line ops
  (LinePicker, LineTags, TagInput, FleetRowMenu, BulkActionBar, CardSelector, ModeBadge,
  StatusDot, KpiCard, AlertBanner, EmptyState, Skeleton, ErrorBoundary), QR/link (QrDisplay,
  RelinkModal, SaveContactDialog), AddLineWizard (Identity/Link/ModelAuth/Config/Review steps).
- **line-detail/**: 9 tab implementations + group modals + schedule composer (~18 files).
- **Hooks (15):** use-fleet (WS-push + polling fallback), use-websocket, use-metrics, use-theme,
  use-transport-status, use-toast, use-console-session, use-dismissable, use-exit-presence,
  use-background-inert, use-keyboard-shortcuts, use-sticky-scroll, use-update-check,
  useViewportPlacement, use-virtual-messages.

## 4. Data / real-time layer

- WebSocket push (`use-websocket`); when connected, most polling is disabled; polling fallback
  per-resource (lines/logs/typing/feed) when disconnected.
- Metrics: 60s `refetchInterval`. Lines: `POLL_LINES`. react-query cache throughout.
- Virtualization: react-virtual for message threads; LogStream renders bounded poll snapshots
  (no live tail — DD-22, product decision pending).
- **No performance budget exists** — no render-cost targets, no measured FPS/TTI for Fleet at N
  lines, no chart re-render throttling policy.

## 5. Design-system v3 state

- **Spec:** `03-spec/` — tokens-v3 (primitive→semantic→component 3-tier), color (6 channels +
  single electric-blue accent), typography (Geist self-hosted, closed ramp), layout-density,
  motion (restraint law, 1 ambient loop, reduced-motion=off), interaction-patterns, iconography
  (shape-coded status law), brand (SOUP nameplate: teal tick + Bricolage wordmark, accent "U"),
  component specs, state-taxonomy.
- **Conformance:** 24 rows — 16 PASS · 2 LANDED · 1 PARTIAL · 4 INCONCLUSIVE · 1 PENDING.
- **Burn-down:** 55 items, **0 blocking** (54 half-step spacing polish + 1 utility-smell).
- **Open debt (blocking final acceptance):** DD-8 (ghost-tier text audit), DD-18r (nav width
  pressure + non-Fleet side-panel law), DD-35 (accent-law residue in legacy wordmark).
- **Open non-blocking:** DD-5, DD-9, DD-22, DD-23, DD-24, DD-26, DD-28, DD-34, DD-36, DD-37,
  DD-38, DD-39 (see WS5 dispositions in `01-gap-audit.md` §8).
- **Enforcement:** 20+ design lint/audit scripts (theme parity, contrast, color semantics,
  brand assets, token drift, resilience), shadow ratchet at 1 warning, CI browser suites.

## 6. Brand state

SOUP nameplate landed in Nav (tick + wordmark + accent U); favicon = round "S" monogram; PWA
manifest + maskable icon; warm neutral ramps both themes; WhatSoup↔SOUP protected boundary
lint-enforced; multi-channel copy positioning locked 2026-06-13 (generic copy must not say
"WhatsApp"). Document `<title>` flip pending (was C4 scope).

## 7. What exists for v3.5 scope items

| v3.5 item | Exists today |
|---|---|
| Multi-channel Lines | ◐ Add Line supports WhatsApp, SMS, Signal, and iMessage with transport-specific config, identity, and linkage; the 14-channel product registry remains unimplemented |
| Managed social channels | ❌ nothing |
| Agents as objects | ❌ agent config is per-line settings (mode/model/plugins), no Agent entity, no roster, no assignment UX |
| First-run onboarding | ⚠️ AddLineWizard (5 utilitarian steps, per-line, not first-run) |
| Hatching ceremony | ❌ nothing |
| Marketing surface | ⚠️ single Landing page (hero + 3 props + CTA) |
| Real-time dashboard | ⚠️ works (WS + fallback) but unmeasured, no budget |
| Settings/config IA | ⚠️ per-line config deep; no fleet/account-level settings surface |
