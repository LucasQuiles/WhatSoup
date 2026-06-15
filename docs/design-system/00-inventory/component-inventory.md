# Component Inventory — WhatSoup Console

Design-system audit, phase 00. Stack: React 19 + Vite + Tailwind v4 + TypeScript (`console/`).
Every entry lists repo-relative path, role, notable props/variants (with line evidence), consumers (verified by import grep), and state handling.

Scope: 60 components + 4 pages (64 `.tsx` files) under `console/src/components/` and `console/src/pages/`, plus UI-shaping hooks under `console/src/hooks/`.

App shell context: `console/src/App.tsx` mounts `Nav`, routes the 4 pages (lazy, each wrapped in `ErrorBoundary`), and hosts `UpdateModal` + `KeyboardShortcutsHelp` globally (`console/src/App.tsx:11-17`, `console/src/App.tsx:55-72`). Providers (`ToastProvider`, `RealtimeProvider`) mount in `console/src/main.tsx:5-6`.

---

## 1. Layout / Navigation

### Nav
- Path: `console/src/components/Nav.tsx`
- Role: Top app bar — logo, route links (Soup Kitchen / Inbox / Ops), alert + unread badges, version/update button, WS connection indicator.
- Props: `NavProps` at `console/src/components/Nav.tsx:15` — `alertCount?`, `unreadCount?`, `version?`, `updateAvailable?`, `remoteSha?`, `onUpdateClick?`.
- Consumers: `console/src/App.tsx:5` (only).
- State: stateless except realtime context — reads `connected` from `useRealtime()` (`console/src/components/Nav.tsx:25`); active route via `useLocation` (`console/src/components/Nav.tsx:26`).

### LinePicker
- Path: `console/src/components/LinePicker.tsx`
- Role: Dropdown selector of line instances with status dot + mode badge per row.
- Props: `LinePickerProps` at `console/src/components/LinePicker.tsx:8` — `lines`, `activeLine`, `onSelect`, `variant?: 'toolbar' | 'compact'` (two visual variants, `console/src/components/LinePicker.tsx:15`).
- Consumers: `console/src/pages/Inbox.tsx:16`, `console/src/pages/Ops.tsx:10`.
- State: local `useState` open/close + outside-click and Escape handling via `useRef`/`useEffect` (`console/src/components/LinePicker.tsx:16-34`). Composes `StatusDot` and `ModeBadge` (`console/src/components/LinePicker.tsx:3-4`).

---

## 2. Cards / Panels

### KpiCard
- Path: `console/src/components/KpiCard.tsx`
- Role: Clickable KPI tile (value + label + optional sparkline) used as fleet filter toggles.
- Props: `KpiCardProps` at `console/src/components/KpiCard.tsx:3` — `value`, `label`, `color` (token class mapped via `colorMap`, `console/src/components/KpiCard.tsx:13`), `onClick?`, `active?`, `sparkData?`, `suffix?`.
- Consumers: `console/src/pages/SoupKitchen.tsx:12`.
- State: stateless; `useId` for SVG gradient id (`console/src/components/KpiCard.tsx:26`).

### ChartPanel
- Path: `console/src/components/ChartPanel.tsx`
- Role: Chart container shell handling loading/error/empty/partial-failure framing around chart children.
- Props: `ChartPanelProps` at `console/src/components/ChartPanel.tsx:6` — `title`, `isLoading`, `isError`, `hasData`, `instancesFailed?`, `expanded?` (140px vs 240px height, `console/src/components/ChartPanel.tsx:27`), `onRetry?`, `children`. Also exports `ChartKey` type (`console/src/components/ChartPanel.tsx:4`).
- Consumers: `console/src/pages/SoupKitchen.tsx:17` (type-only import at `console/src/pages/SoupKitchen.tsx:11`).
- State: stateless.

### CardSelector
- Path: `console/src/components/CardSelector.tsx`
- Role: Radio-style card group (icon + label + description) for option choices.
- Props: `CardSelectorProps` at `console/src/components/CardSelector.tsx:11`; option shape `CardOption` at `console/src/components/CardSelector.tsx:3` (`value`, `label`, `description`, `icon`, `color`); `colorToWash` derives wash backgrounds (`console/src/components/CardSelector.tsx:18`).
- Consumers: `console/src/components/wizard/ConfigStep.tsx`, `console/src/components/wizard/IdentityStep.tsx` (both `from '../CardSelector'`).
- State: stateless, controlled by `selected`/`onChange`.

### GroupCard
- Path: `console/src/components/line-detail/GroupCard.tsx`
- Role: Group summary tile (avatar initials, role badge) in the Groups tab grid.
- Props: `GroupCardProps` at `console/src/components/line-detail/GroupCard.tsx:6` — `group`, `onSelect`, `myJid?` (rendered `console/src/components/line-detail/GroupCard.tsx:12`).
- Consumers: `console/src/components/line-detail/GroupsTab.tsx:6`.
- State: stateless; styling helpers from `console/src/components/line-detail/groups-utils.ts` (`avatarColor`, `roleLabel`, `roleBadgeStyle`, imported at `console/src/components/line-detail/GroupCard.tsx:3`).

---

## 3. Tables / Lists / Feeds

### ActivityFeed
- Path: `console/src/components/ActivityFeed.tsx`
- Role: Live fleet event stream with filter pills, pause/snapshot, and stop-instance confirmation.
- Props: `ActivityFeedProps` at `console/src/components/ActivityFeed.tsx:11` — single `events: FeedEvent[]`. Filter variants: `all | msgs | conn | errors | health | sessions` (`console/src/components/ActivityFeed.tsx:15-24`).
- Consumers: `console/src/pages/SoupKitchen.tsx:14`.
- State: local `useState` for `paused`, `snapshot`, `filter`, `stopTarget` (`console/src/components/ActivityFeed.tsx:53-56`); `useToast` + `api` calls for restart/stop actions; composes `FilterPill`, `FeedCard`, `ConfirmDialog` (`console/src/components/ActivityFeed.tsx:6-8`).

### FeedCard
- Path: `console/src/components/FeedCard.tsx`
- Role: Renders one feed event as a typed card (message, connection, tool error, health, session...) with edge color, badges, and per-type actions.
- Props: `FeedCardProps` at `console/src/components/FeedCard.tsx:429` — `event`, `onRestart?`, `onStop?`, `onNavigate?`, `onCopyResult?`.
- Consumers: `console/src/components/ActivityFeed.tsx:7`.
- State: stateless render-dispatch on `event.detail.type` (`renderCard`, switch ending `console/src/components/FeedCard.tsx:421`).

### FeedIcon
- Path: `console/src/components/FeedIcon.tsx`
- Role: Maps a `FeedEvent` to a lucide icon + semantic color.
- Props: `FeedIconProps` at `console/src/components/FeedIcon.tsx:16` — `event: FeedEvent`; switch on `detail.type` (`console/src/components/FeedIcon.tsx:24`).
- Consumers: `console/src/components/FeedCard.tsx:4`.
- State: stateless.

### ScheduledMessageRow
- Path: `console/src/components/line-detail/ScheduledMessageRow.tsx`
- Role: Expandable row for a scheduled message (status, cron description, cancel/edit/duplicate actions).
- Props: `ScheduledMessageRowProps` at `console/src/components/line-detail/ScheduledMessageRow.tsx:23` — `message`, `onCancel`, `onEdit`, `onDuplicate`, `cancelling: number | null`. Internal `ContentTypeIcon` sub-component (`console/src/components/line-detail/ScheduledMessageRow.tsx:31`).
- Consumers: `console/src/components/line-detail/ScheduledTab.tsx:7`.
- State: local `expanded` `useState` (`console/src/components/line-detail/ScheduledMessageRow.tsx:60`); display helpers from `console/src/components/line-detail/scheduled-utils.ts`.

---

## 4. Status / Badges

### StatusDot
- Path: `console/src/components/StatusDot.tsx`
- Role: Colored status dot with glow for `online | degraded | unreachable`.
- Props: `StatusDotProps` at `console/src/components/StatusDot.tsx:6` — `status`, `size?: 'sm' | 'md'` (size/color/glow maps at `console/src/components/StatusDot.tsx:11-26`).
- Consumers: `console/src/components/LinePicker.tsx:3`, `console/src/pages/Ops.tsx:5`. (LineDetail header re-implements an inline status dot instead of reusing it — `console/src/pages/LineDetail.tsx:148-162`.)
- State: stateless.

### ModeBadge
- Path: `console/src/components/ModeBadge.tsx`
- Role: Pill badge for line mode `passive | chat | agent`.
- Props: `ModeBadgeProps` at `console/src/components/ModeBadge.tsx:5`; per-mode config map at `console/src/components/ModeBadge.tsx:9`.
- Consumers: `console/src/components/LinePicker.tsx:4`, `console/src/components/wizard/ReviewStep.tsx`, `console/src/pages/LineDetail.tsx:11`, `console/src/pages/Ops.tsx:6`, `console/src/pages/SoupKitchen.tsx:15`.
- State: stateless.

### LineTags
- Path: `console/src/components/LineTags.tsx`
- Role: Derived tag chips for a line (access mode, sandbox, provider, warnings) from config inspection.
- Props: `LineTagsProps` at `console/src/components/LineTags.tsx:5` — single `line: LineInstance`; tag derivation in `getAccessTag` (`console/src/components/LineTags.tsx:16`).
- Consumers: `console/src/pages/LineDetail.tsx:12`, `console/src/pages/Ops.tsx:7`, `console/src/pages/SoupKitchen.tsx:21`.
- State: stateless.

### HeartbeatStrip
- Path: `console/src/components/HeartbeatStrip.tsx`
- Role: 20-bar health sparkline (`up | down | slow` beats), padded/truncated to fixed length.
- Props: `HeartbeatStripProps` at `console/src/components/HeartbeatStrip.tsx:5`; beat config map at `console/src/components/HeartbeatStrip.tsx:9`; `STRIP_LENGTH = 20` at `console/src/components/HeartbeatStrip.tsx:15`.
- Consumers: `console/src/pages/LineDetail.tsx:13`, `console/src/pages/Ops.tsx:8`.
- State: stateless.

### FilterPill
- Path: `console/src/components/FilterPill.tsx`
- Role: Toggleable filter chip with optional count and custom active color.
- Props: `FilterPillProps` at `console/src/components/FilterPill.tsx:3` — `label`, `isActive`, `activeColor?`, `activeBorder?`, `onClick`, `count?`, `suffix?`, `style?`.
- Consumers: `console/src/components/ActivityFeed.tsx:6`, `console/src/components/line-detail/LogsTab.tsx`, `console/src/pages/Ops.tsx:9`, `console/src/pages/SoupKitchen.tsx:16`.
- State: stateless (`aria-pressed` controlled, `console/src/components/FilterPill.tsx:20`).

### AlertBanner
- Path: `console/src/components/AlertBanner.tsx`
- Role: Critical-wash banner listing offline/degraded lines as clickable chips; renders null when no alerts.
- Props: `AlertBannerProps` at `console/src/components/AlertBanner.tsx:9` — `alerts: {line, message}[]`, `onAlertClick?`.
- Consumers: `console/src/pages/SoupKitchen.tsx:13`.
- State: stateless.

---

## 5. Forms & Form Primitives

### form-primitives (wizard primitives module — 6 exports)
- Path: `console/src/components/wizard/form-primitives.tsx`
- Role: Shared styled form controls with `error`/`confirmed` border-state convention (`borderColor` helper, `console/src/components/wizard/form-primitives.tsx:4`).
- Exports (each with its own props interface):
  - `Field` — label/error/helper wrapper using render-prop `children(id)` with `useId`; `FieldProps` at `console/src/components/wizard/form-primitives.tsx:12`, export at `:20`.
  - `TextInput` — `TextInputProps` at `console/src/components/wizard/form-primitives.tsx:39`, export at `:44`.
  - `NumberInput` — `NumberInputProps` at `console/src/components/wizard/form-primitives.tsx:52`, export at `:57`.
  - `SelectInput` — `SelectInputProps` at `console/src/components/wizard/form-primitives.tsx:66`, export at `:71`.
  - `TextArea` — `TextAreaProps` at `console/src/components/wizard/form-primitives.tsx:81` (adds `minHeight?`), export at `:87`.
  - `CheckboxField` — `CheckboxFieldProps` at `console/src/components/wizard/form-primitives.tsx:99`, export at `:106`.
- Consumers: `console/src/components/wizard/ConfigStep.tsx`, `console/src/components/wizard/ModelAuthStep.tsx` (both `from './form-primitives'`). Not used outside the wizard — line-detail dialogs use raw inputs/`c-input` classes instead (e.g. `console/src/components/line-detail/ConfigEditDialog.tsx`).
- State: all stateless/controlled.

### TagInput
- Path: `console/src/components/TagInput.tsx`
- Role: Multi-value pill input (Enter/comma to add, X to remove) with optional validation/normalization.
- Props: `TagInputProps` at `console/src/components/TagInput.tsx:5` — `values`, `onChange`, `placeholder?`, `validate?`, `normalizeValue?`, `accentColor?`, `displayLabels?`.
- Consumers: `console/src/components/wizard/ConfigStep.tsx`, `console/src/components/wizard/IdentityStep.tsx`, `console/src/components/line-detail/ConfigEditDialog.tsx:4`.
- State: local `input` `useState` + `useRef` focus management (`console/src/components/TagInput.tsx:17-18`).

### SearchInput
- Path: `console/src/components/shared/SearchInput.tsx`
- Role: Text input with leading search icon and optional `endAdornment`; renders through the `TextInput` form primitive.
- Props: `SearchInputProps` at `console/src/components/shared/SearchInput.tsx` (extends `TextInputProps` minus `type`).
- Consumers: `console/src/components/shared/ChatPicker.tsx`, `console/src/components/shared/ContactSearchPicker.tsx`, `console/src/components/line-detail/GroupDetailModal.tsx`, `console/src/pages/Inbox.tsx`.
- State: stateless/controlled.

### ChatPicker
- Path: `console/src/components/shared/ChatPicker.tsx`
- Role: Searchable single-select dropdown over a chat list (used to target scheduled messages).
- Props: `ChatPickerProps` at `console/src/components/shared/ChatPicker.tsx:6` — `chats`, `selected`, `onSelect`, `onClear`, `placeholder?`.
- Consumers: `console/src/components/line-detail/ScheduleComposerModal.tsx:5`.
- State: local `query`/`open` `useState`, outside-click `useEffect`, `useMemo` filtering (`console/src/components/shared/ChatPicker.tsx:19-37`).

### ContactSearchPicker
- Path: `console/src/components/shared/ContactSearchPicker.tsx`
- Role: Debounced multi-select contact search against the line's WhatsApp contacts (API-backed).
- Props: `ContactSearchPickerProps` at `console/src/components/shared/ContactSearchPicker.tsx:7` — `lineName`, `selected`, `onAdd`, `onRemove`, `placeholder?`.
- Consumers: `console/src/components/line-detail/GroupDetailModal.tsx:8`, `console/src/components/line-detail/CreateGroupModal.tsx:6`.
- State: local `query`/`results`/`searching` + debounce timer ref; calls `api.searchContacts` (`console/src/components/shared/ContactSearchPicker.tsx:16-31`).

### ContactSearch — ORPHAN
- Path: `console/src/components/ContactSearch.tsx`
- Role: Older inline contact search (manual search button, single-select list) against `api.searchContacts`.
- Props: inline at `console/src/components/ContactSearch.tsx:10-16` — `lineName`, `onSelect?`.
- Consumers: NONE found. `grep -rn "ContactSearch\b"` across `console/src` matches only its own definition (`console/src/components/ContactSearch.tsx:10`); no static or lazy import exists. Apparent dead code superseded by `console/src/components/shared/ContactSearchPicker.tsx`.
- State: local `query`/`results`/`loading`/`searched` `useState` (`console/src/components/ContactSearch.tsx:17-20`).

---

## 6. Modals / Dialogs

### ConfirmDialog
- Path: `console/src/components/ConfirmDialog.tsx`
- Role: Generic confirm modal (title, body children, confirm/cancel) — the base confirmation primitive.
- Props: `ConfirmDialogProps` at `console/src/components/ConfirmDialog.tsx:4` — `open`, `title`, `children`, `confirmLabel?`, `confirmVariant?: 'danger' | 'primary' | 'warning'`, `confirmIcon?`, `onConfirm`, `onCancel`.
- Consumers (6): `console/src/components/AddLineWizard.tsx:9`, `console/src/components/ActivityFeed.tsx:8`, `console/src/components/line-detail/SummaryTab.tsx:8`, `console/src/components/line-detail/AccessTab.tsx`, `console/src/components/line-detail/ModeSwitchDialog.tsx:6`, `console/src/components/line-detail/GroupDetailModal.tsx:6`, plus pages `console/src/pages/Ops.tsx:23` and `console/src/pages/LineDetail.tsx:14`.
- State: stateless except Escape-key `useEffect` (`console/src/components/ConfirmDialog.tsx:26`).

### RelinkModal
- Path: `console/src/components/RelinkModal.tsx`
- Role: Re-link dialog wrapping the wizard `LinkStep` for an existing line.
- Props: `RelinkModalProps` at `console/src/components/RelinkModal.tsx:5` — `lineName`, `open`, `onClose`, `onLinked`.
- Consumers (lazy): `console/src/pages/LineDetail.tsx:16`, `console/src/pages/Ops.tsx:24`.
- State: Escape-key `useEffect` only; QR/link state lives in embedded `LinkStep` (`console/src/components/RelinkModal.tsx:13-17`).

### UpdateModal
- Path: `console/src/components/UpdateModal.tsx`
- Role: Multi-phase fleet self-update flow (confirm → SSE-streamed update steps → fleet restart wait → per-instance restart → done/error).
- Props: `UpdateModalProps` at `console/src/components/UpdateModal.tsx:7` — `open`, `onClose`, `currentSha`, `lines`. Phase machine `confirm | updating | restarting-fleet | restart-instances | done | error` (`console/src/components/UpdateModal.tsx:31`), step registry at `console/src/components/UpdateModal.tsx:22-30`.
- Consumers (lazy): `console/src/App.tsx:17`.
- State: heaviest state component — `useReducer` state machine + `AbortController`/poll/timeout refs + React Query invalidation (`console/src/components/UpdateModal.tsx:1`, `:100-141`).

### KeyboardShortcutsHelp
- Path: `console/src/components/KeyboardShortcutsHelp.tsx`
- Role: Overlay dialog listing global shortcuts; OS-aware modifier label (`console/src/components/KeyboardShortcutsHelp.tsx:3-4`).
- Props: inline at `console/src/components/KeyboardShortcutsHelp.tsx:15` — `open`, `onClose`.
- Consumers: `console/src/App.tsx:4` (toggled by `useKeyboardShortcuts` `onHelp`, `console/src/App.tsx:40`).
- State: stateless; static `SHORTCUTS` table (`console/src/components/KeyboardShortcutsHelp.tsx:6`).

### ConfigEditDialog
- Path: `console/src/components/line-detail/ConfigEditDialog.tsx`
- Role: Schema-driven line config editor (enum selects, validators, nested agentOptions paths) with patch-and-restart save.
- Props: inline at `console/src/components/line-detail/ConfigEditDialog.tsx:23-33` — `config`, `lineName`, `adminPhonesDisplay?`, `onClose`.
- Consumers: `console/src/pages/LineDetail.tsx` (via barrel `console/src/components/line-detail/index.ts:8`).
- State: local `patch`/`saving`/`customEnumFields` `useState` + memoized editable entries; field metadata from `console/src/components/line-detail/config-helpers.ts` (`console/src/components/line-detail/ConfigEditDialog.tsx:36-72`); React Query invalidation + toast on save.

### ModeSwitchDialog
- Path: `console/src/components/line-detail/ModeSwitchDialog.tsx`
- Role: Mode change dialog (passive/chat/agent option list) built on `ConfirmDialog`; applies `api.updateConfig` + `api.restart`.
- Props: inline at `console/src/components/line-detail/ModeSwitchDialog.tsx:15-23` — `currentMode`, `lineName`, `onClose`. `MODE_OPTIONS` registry at `console/src/components/line-detail/ModeSwitchDialog.tsx:9`.
- Consumers: `console/src/pages/LineDetail.tsx` (barrel `console/src/components/line-detail/index.ts:9`).
- State: local `selected`/`switching` `useState` + query invalidation (`console/src/components/line-detail/ModeSwitchDialog.tsx:26-37`).

### CreateGroupModal
- Path: `console/src/components/line-detail/CreateGroupModal.tsx`
- Role: Create WhatsApp group dialog (subject + participant picker).
- Props: `CreateGroupModalProps` at `console/src/components/line-detail/CreateGroupModal.tsx:9` — `open`, `lineName`, `onClose`, `onCreated`.
- Consumers: `console/src/components/line-detail/GroupsTab.tsx:8`.
- State: local `subject`/`participants`/`submitting` `useState`; reset + Escape `useEffect`s; `api` call + query invalidation + toast (`console/src/components/line-detail/CreateGroupModal.tsx:19-39`).

### GroupDetailModal
- Path: `console/src/components/line-detail/GroupDetailModal.tsx`
- Role: Largest modal (847 lines): tabbed group management — Info (subject/desc/invite link), Participants (add/remove/promote), Settings, plus leave-group confirm.
- Props: `GroupDetailModalProps` at `console/src/components/line-detail/GroupDetailModal.tsx:22` — `open`, `group`, `lineName`, `myJid?`, `onClose`; internal `TabId = 'info' | 'participants' | 'settings'` (`console/src/components/line-detail/GroupDetailModal.tsx:20`). Internal sub-components `InfoTab` (`:37`) and others; main export at `console/src/components/line-detail/GroupDetailModal.tsx:717`.
- Consumers: `console/src/components/line-detail/GroupsTab.tsx:7`.
- State: `useQuery` for group detail (`console/src/components/line-detail/GroupDetailModal.tsx:722`), local tab state with render-time reset on group change (`:737-741`), per-tab `useState` clusters, admin-status derivation from `myJid` (`:746-751`), nested `ConfirmDialog`s.

### ScheduleComposerModal
- Path: `console/src/components/line-detail/ScheduleComposerModal.tsx`
- Role: Create/edit scheduled message dialog — chat target, text/media content, datetime or cron recurrence with presets.
- Props: `ScheduleComposerModalProps` (exported) at `console/src/components/line-detail/ScheduleComposerModal.tsx:10` — `open`, `onClose`, `onCreated`, `lineName`, `chats`, `editMessage?`. Recurrence presets at `console/src/components/line-detail/ScheduleComposerModal.tsx:22`.
- Consumers: `console/src/components/line-detail/ScheduledTab.tsx:8`.
- State: large local form state (`selectedChat`, `contentType`, `text`, `mediaPath`, `caption`, `datetimeLocal`, `recurring`, `cronExpr`, `console/src/components/line-detail/ScheduleComposerModal.tsx:63-70`); cron helpers from `console/src/components/line-detail/scheduled-utils.ts`.

---

## 7. Wizard

### AddLineWizard
- Path: `console/src/components/AddLineWizard.tsx`
- Role: 5-step modal wizard (Identity → Link → Model → Config → Review) for provisioning a new line; creates the instance after step 0 and supports teardown on discard.
- Props: `AddLineWizardProps` at `console/src/components/AddLineWizard.tsx:14` — single `onClose`. Step map documented at `console/src/components/AddLineWizard.tsx:18-27`; per-step validation in `validateStep` (`console/src/components/AddLineWizard.tsx:92`). Renders as `c-dialog-backdrop` overlay (`console/src/components/AddLineWizard.tsx:255-258`). Internal `WizardStepper` sub-component (`console/src/components/AddLineWizard.tsx:30`).
- Consumers (lazy): `console/src/pages/SoupKitchen.tsx:4`.
- State: orchestrator — `currentStep`, `formData` record, `errors`, `creating`, `createError`, dirty ref, `showConfirmExit`, `instanceCreated`, `wizardCompleted`, `lockedName` (`console/src/components/AddLineWizard.tsx:122-168`, `:183`); `beforeunload` guard (`:171-180`); `api.createLine`/`api.deleteLine`.

### WizardStep
- Path: `console/src/components/wizard/WizardStep.tsx`
- Role: Step layout shell — optional title/subtitle, body slot, `footerExtra` slot.
- Props: `WizardStepProps` at `console/src/components/wizard/WizardStep.tsx:3`.
- Consumers: `console/src/components/wizard/IdentityStep.tsx`, `console/src/components/wizard/ModelAuthStep.tsx` (only those two import it; other steps build their own layout).
- State: stateless.

### IdentityStep
- Path: `console/src/components/wizard/IdentityStep.tsx`
- Role: Step 0 — line type (CardSelector), name with debounced availability check, admin phones (TagInput).
- Props: `IdentityStepProps` at `console/src/components/wizard/IdentityStep.tsx:10` — `data`, `onChange`, `errors`, `nameLocked?`. `TYPE_OPTIONS` at `console/src/components/wizard/IdentityStep.tsx:19`.
- Consumers: `console/src/components/AddLineWizard.tsx:4`.
- State: `nameStatus`/`showConfirmed` `useState` + debounce and `AbortController` refs (`console/src/components/wizard/IdentityStep.tsx:45-48`).

### LinkStep
- Path: `console/src/components/wizard/LinkStep.tsx`
- Role: Step 1 — WhatsApp QR pairing with status polling, QR aging, and retry.
- Props: `LinkStepProps` at `console/src/components/wizard/LinkStep.tsx:7` — `lineName`, `onComplete`. Status machine `waiting | connected | error` (`console/src/components/wizard/LinkStep.tsx:12`).
- Consumers: `console/src/components/AddLineWizard.tsx:8`, `console/src/components/RelinkModal.tsx:3` (reused outside the wizard).
- State: `status`/`qrValue`/`errorMsg`/`retryKey`/`qrAge` `useState`, QR timer + retry-count refs, polling `useEffect` (`console/src/components/wizard/LinkStep.tsx:15-23`).

### ModelAuthStep
- Path: `console/src/components/wizard/ModelAuthStep.tsx`
- Role: Step 2 — provider auth: Anthropic / OpenAI / Local tabs with model catalogs and key entry (visibility toggle).
- Props: `ModelAuthStepProps` at `console/src/components/wizard/ModelAuthStep.tsx:6` — `data`, `onChange`, `errors`. Model lists at `console/src/components/wizard/ModelAuthStep.tsx:12-20`.
- Consumers: `console/src/components/AddLineWizard.tsx:5`.
- State: `activeTab` `useState` (`console/src/components/wizard/ModelAuthStep.tsx:63`); key-visibility `useState` in sub-component (`:158`).

### ConfigStep
- Path: `console/src/components/wizard/ConfigStep.tsx`
- Role: Step 3 — largest component (863 lines): system prompt, access mode, agent options (cwd, sandbox, MCP, per-user dirs, plugins, provider config), file upload prefill, skip-with-defaults.
- Props: `ConfigStepProps` at `console/src/components/wizard/ConfigStep.tsx:12` — `data`, `onChange`, `errors`, `onSkip?`; nested `AgentOptions` shape at `console/src/components/wizard/ConfigStep.tsx:19`.
- Consumers: `console/src/components/AddLineWizard.tsx:6`.
- State: derived `useMemo` agentOptions + prefill ref + many `useCallback` patch handlers (`console/src/components/wizard/ConfigStep.tsx:151-279`); controlled via parent `formData`.

### ReviewStep
- Path: `console/src/components/wizard/ReviewStep.tsx`
- Role: Step 4 — read-only summary cards with per-phase edit links and final create action.
- Props: `ReviewStepProps` at `console/src/components/wizard/ReviewStep.tsx:8` — `data`, `onEditPhase`, `onCreateLine`, `creating`, `error`.
- Consumers: `console/src/components/AddLineWizard.tsx:7`.
- State: stateless; uses `ModeBadge` and `ACCESS_MODE_LABELS`.

### QrDisplay
- Path: `console/src/components/QrDisplay.tsx`
- Role: Renders a QR code to canvas via `qrcode` lib, themed from CSS custom properties.
- Props: `QrDisplayProps` at `console/src/components/QrDisplay.tsx:4` — `value`, `size?` (default 256).
- Consumers: `console/src/components/wizard/LinkStep.tsx`.
- State: `useRef` canvas + draw `useEffect` (`console/src/components/QrDisplay.tsx:10-12`).

---

## 8. Messaging

### ChatListItem
- Path: `console/src/components/ChatListItem.tsx`
- Role: Conversation row (avatar initials, name, preview, time, typing indicator, selected accent border).
- Props: `ChatListItemProps` at `console/src/components/ChatListItem.tsx:6` — `chat`, `isSelected`, `onClick`, `isTyping?`.
- Consumers: `console/src/components/line-detail/HistoryTab.tsx`, `console/src/pages/Inbox.tsx:14`.
- State: stateless; keyboard activation handler inline (`console/src/components/ChatListItem.tsx:21`).

### MessageBubble
- Path: `console/src/components/MessageBubble.tsx`
- Role: Chat message bubble — direction styling, hover detail card, create-contact affordance for raw-JID senders, failed-send retry.
- Props: `MessageBubbleProps` at `console/src/components/MessageBubble.tsx:8` — `msg`, `outgoingBg?`, `onCreateContact?`, `highlightQuery?`, `animate?`, `onRetry?`. Internal `DetailCard` sub-component (`console/src/components/MessageBubble.tsx:22`).
- Consumers: `console/src/components/line-detail/HistoryTab.tsx`, `console/src/pages/Inbox.tsx:15`.
- State: `showDetail` `useState` + hover timer ref (`console/src/components/MessageBubble.tsx:96-97`).

### MessageContent
- Path: `console/src/components/MessageContent.tsx`
- Role: Message body renderer — WhatsApp text formatting (bold/italic/code/links via `formatWhatsAppText`), media indicators (image/audio/document/video/sticker), byte formatting, search highlight.
- Props: `MessageContentProps` at `console/src/components/MessageContent.tsx:11` — `msg`, `highlightQuery?`. `MediaIndicator` sub-component at `console/src/components/MessageContent.tsx:24`.
- Consumers: `console/src/components/MessageBubble.tsx:5`.
- State: stateless.

---

## 9. Charts

All four recharts components share axis/tooltip constants from `console/src/lib/chart-utils.ts` (imported e.g. `console/src/components/MetricsChart.tsx:12`).

### MetricsChart
- Path: `console/src/components/MetricsChart.tsx`
- Role: Per-line message volume bar chart (inbound/outbound/media).
- Props: `MetricsChartProps` at `console/src/components/MetricsChart.tsx:14` — `data: MessageVolumeBucket[]`, `range?` (default `'24h'`).
- Consumers: `console/src/components/line-detail/MetricsTab.tsx:3`.
- State: stateless.

### FleetMetricsChart
- Path: `console/src/components/FleetMetricsChart.tsx`
- Role: Fleet-wide stacked area chart of message volume.
- Props: `FleetMetricsChartProps` at `console/src/components/FleetMetricsChart.tsx:14` — `data`, `range?`.
- Consumers: `console/src/pages/SoupKitchen.tsx:18`.
- State: stateless.

### FleetTokenChart
- Path: `console/src/components/FleetTokenChart.tsx`
- Role: Token consumption area chart; switches to per-provider multi-series when `providers.length > 1` (`console/src/components/FleetTokenChart.tsx:25`).
- Props: `FleetTokenChartProps` at `console/src/components/FleetTokenChart.tsx:16` — `data`, `byProvider?`, `providers?`, `range?`.
- Consumers: `console/src/pages/SoupKitchen.tsx:19`, `console/src/components/line-detail/MetricsTab.tsx:4` (reused at line level with `byProvider`, `console/src/components/line-detail/MetricsTab.tsx:118-120`).
- State: stateless; provider colors via `console/src/lib/providers.ts`.

### FleetSessionChart
- Path: `console/src/components/FleetSessionChart.tsx`
- Role: Composed chart (area = active sessions, bar = sessions started); same multi-provider branch (`console/src/components/FleetSessionChart.tsx:26`).
- Props: `FleetSessionChartProps` at `console/src/components/FleetSessionChart.tsx:17` — `data`, `byProvider?`, `providers?`, `range?`.
- Consumers: `console/src/pages/SoupKitchen.tsx:20`, `console/src/components/line-detail/MetricsTab.tsx:5` (`:126-128`).
- State: stateless.

### ActiveHoursHeatmap
- Path: `console/src/components/ActiveHoursHeatmap.tsx`
- Role: 7x24 message-activity heatmap; collapses to a single 24h bar view when `range === '24h'` (`console/src/components/ActiveHoursHeatmap.tsx:60`); custom (non-recharts) CSS rendering with `color-mix` intensity ramp (`console/src/components/ActiveHoursHeatmap.tsx:7`).
- Props: inline at `console/src/components/ActiveHoursHeatmap.tsx:53` — `data: number[][]`, `byDate?`, `range?`. Internal `HeatmapLegend` (`console/src/components/ActiveHoursHeatmap.tsx:29`).
- Consumers: `console/src/components/line-detail/MetricsTab.tsx:6`.
- State: stateless.

---

## 10. Line-Detail Tabs

All nine `*Tab.tsx` components are re-exported through the barrel `console/src/components/line-detail/index.ts:1-11` and consumed only by `console/src/pages/LineDetail.tsx:23-35`. Shared types via `console/src/components/line-detail/types.ts` (re-exports + `getModeColor`, `console/src/components/line-detail/types.ts:8`).

### SummaryTab
- Path: `console/src/components/line-detail/SummaryTab.tsx`
- Role: Overview — pipeline mini-diagram (reuses `PipelineNode`/`PipelineArrow`), config summary, restart/stop actions.
- Props: inline at `console/src/components/line-detail/SummaryTab.tsx:14-22` — `line`, `onEditConfig`, `onChangeMode`.
- State: `confirmAction` `useState` (`console/src/components/line-detail/SummaryTab.tsx:24`) + toast + `api.restart`/`api.stopInstance` (`:249`, `:273`).

### ModeTab
- Path: `console/src/components/line-detail/ModeTab.tsx`
- Role: Mode-specific config view (passive shows EmptyState-style explainer; chat/agent show config entries) with edit/change-mode actions.
- Props: inline at `console/src/components/line-detail/ModeTab.tsx:7-16` — `mode`, `line`, `onEditConfig`, `onChangeMode`.
- State: stateless; entries from `console/src/components/line-detail/config-helpers.ts`.

### PipelineTab
- Path: `console/src/components/line-detail/PipelineTab.tsx`
- Role: Message pipeline visualization with selectable nodes and per-node detail.
- Props: inline at `console/src/components/line-detail/PipelineTab.tsx:183` — `mode`, `line`, `modeColor`. Also exports `PipelineNode` + `PipelineArrow` building blocks (`console/src/components/line-detail/PipelineTab.tsx:74`; node props at `:5-18`).
- Consumers of sub-exports: `console/src/components/line-detail/SummaryTab.tsx:9`.
- State: `selectedNode` `useState` (`console/src/components/line-detail/PipelineTab.tsx:184`).

### AccessTab
- Path: `console/src/components/line-detail/AccessTab.tsx`
- Role: Access-control list with approve/deny decisions per subject.
- Props: inline at `console/src/components/line-detail/AccessTab.tsx:11` — `access: AccessEntry[]`, `lineName`.
- State: `pendingAction` `useState` + `ConfirmDialog`; `api.accessDecision` + React Query invalidation (`console/src/components/line-detail/AccessTab.tsx:14-25`).

### HistoryTab
- Path: `console/src/components/line-detail/HistoryTab.tsx`
- Role: Two-pane conversation browser (chat list + message thread) with send box and load-older pagination.
- Props: inline at `console/src/components/line-detail/HistoryTab.tsx:239-241` — `chats`, `messages`, `selectedChat`, `onSelectChat`, `mode`, `lineName`, `typingJids: Set<string>`.
- State: composer text/sending + older-messages pagination `useState`s (`console/src/components/line-detail/HistoryTab.tsx:21-38`); composes `ChatListItem`, `MessageBubble`, `EmptyState`.

### LogsTab
- Path: `console/src/components/line-detail/LogsTab.tsx`
- Role: Log viewer with level filter pills (filter state lifted to parent).
- Props: inline at `console/src/components/line-detail/LogsTab.tsx:6` — `logs`, `filter`, `onFilterChange`.
- State: stateless (controlled); uses `Pill` tones for level filters and delegates rows to `LogStream`.

### MetricsTab
- Path: `console/src/components/line-detail/MetricsTab.tsx`
- Role: Per-line metrics dashboard — volume chart, tokens/sessions detail sub-tabs, heatmap, CSV export.
- Props: inline at `console/src/components/line-detail/MetricsTab.tsx:13-31` — `metrics`, `metricsLoading`, `metricsError`, `metricsRange`, `setMetricsRange`, `lineName?`, `line?`, `onRetry?`.
- State: local `detailTab: 'tokens' | 'sessions'` (`console/src/components/line-detail/MetricsTab.tsx:32`); range state lifted to `console/src/pages/LineDetail.tsx:60-64` (persisted via preferences).

### ScheduledTab
- Path: `console/src/components/line-detail/ScheduledTab.tsx`
- Role: Scheduled-messages list (MCP-gated tab) with composer modal and cancel/edit/duplicate row actions.
- Props: inline at `console/src/components/line-detail/ScheduledTab.tsx:11` — `lineName` only.
- State: self-fetching — `useQuery` for scheduled messages and chats (`console/src/components/line-detail/ScheduledTab.tsx:18-25`); local `cancelling`/`composerOpen`/`editMessage` (`:14-16`).

### GroupsTab
- Path: `console/src/components/line-detail/GroupsTab.tsx`
- Role: Group grid (MCP-gated tab) with create modal and detail modal.
- Props: inline at `console/src/components/line-detail/GroupsTab.tsx:11` — `lineName`, `myJid?`.
- State: self-fetching `useQuery` (`console/src/components/line-detail/GroupsTab.tsx:16-18`); local `selectedGroup`/`showCreate` (`:13-14`).

---

## 11. Utilities (skeleton, error boundary, empty state, toast)

### Skeleton (+ TableSkeleton)
- Path: `console/src/components/Skeleton.tsx`
- Role: Shimmer placeholder block; `TableSkeleton` composes a 5-row table placeholder (`console/src/components/Skeleton.tsx:12`).
- Props: `SkeletonProps` at `console/src/components/Skeleton.tsx:3` — `className?`, `style?`.
- Consumers: `console/src/pages/LineDetail.tsx:15` (only).
- State: stateless.

### ErrorBoundary
- Path: `console/src/components/ErrorBoundary.tsx`
- Role: Class-component route-level error boundary rendering an error-variant `EmptyState` with retry.
- Props: `ErrorBoundaryProps` at `console/src/components/ErrorBoundary.tsx:4` — `children` only.
- Consumers: `console/src/App.tsx:3` (wraps each route element, `console/src/App.tsx:56-59`).
- State: class state `{hasError, error}` via `getDerivedStateFromError` (`console/src/components/ErrorBoundary.tsx:14-24`).

### EmptyState
- Path: `console/src/components/EmptyState.tsx`
- Role: Centered empty/error placeholder with optional icon, retry button; framer-motion entrance.
- Props: `EmptyStateProps` at `console/src/components/EmptyState.tsx:5` — `icon?`, `title`, `description?`, `variant?: 'default' | 'error'`, `onRetry?`, `retryLabel?`.
- Consumers: `console/src/components/ErrorBoundary.tsx:2`, `console/src/components/line-detail/ModeTab.tsx:3`, `console/src/components/line-detail/HistoryTab.tsx`, `console/src/components/line-detail/MetricsTab.tsx:7`, `console/src/components/line-detail/GroupsTab.tsx:5`, `console/src/components/line-detail/ScheduledTab.tsx:6`, `console/src/components/line-detail/GroupDetailModal.tsx:7`, `console/src/pages/Inbox.tsx:13`.
- State: stateless.

### Toast
- Path: `console/src/components/Toast.tsx`
- Role: Single toast card (success/error/info icon + border color maps) with auto-dismiss timer.
- Props: `ToastProps` at `console/src/components/Toast.tsx:6` — `variant`, `message`, `onClose`, `duration?`; variant type at `console/src/components/Toast.tsx:4`.
- Consumers: `console/src/hooks/use-toast.tsx:3` (rendered only by the provider stack).
- State: auto-close `useEffect` timer (`console/src/components/Toast.tsx:34`).

---

## 12. Pages

### SoupKitchen (fleet dashboard, route `/`)
- Path: `console/src/pages/SoupKitchen.tsx`
- Role: Fleet overview — KPI cards, alert banner, three fleet charts in `ChartPanel`s, sortable/filterable line table, activity feed, Add Line wizard launcher.
- Consumers: routed from `console/src/App.tsx:11`, `console/src/App.tsx:56`.
- State: `activeKpi`, `expandedChart`, `chartRange`, `modeFilter`, `search`, `showAddWizard`, `sortKey`, `sortDir` (`console/src/pages/SoupKitchen.tsx:78-85`); data via `useLines`/`useFeed` (`:6`) and `useFleetMetrics` (`:7`).

### LineDetail (route `/lines/:name`)
- Path: `console/src/pages/LineDetail.tsx`
- Role: Single-line console — header (status, mode, tags, heartbeat, restart/re-link/delete) + 7-9 tab registry rendering the line-detail tab components.
- Consumers: routed from `console/src/App.tsx:12`, `console/src/App.tsx:57`.
- State: tab + metrics-range (preference-persisted) + selected chat + dialog visibility flags (`console/src/pages/LineDetail.tsx:59-85`); data via `useLine/useChats/useAccess/useLogs/useMetrics/useTyping/useMessages` (`console/src/pages/LineDetail.tsx:5-6`, `:65-75`); skeleton fallback while line loads (`:103-117`).

### Inbox (route `/inbox`)
- Path: `console/src/pages/Inbox.tsx`
- Role: Cross-line unified messaging — line picker, chat list, virtualized message thread with sticky scroll, send box, search, contact actions.
- Consumers: routed from `console/src/App.tsx:13`, `console/src/App.tsx:58`.
- State: heavy local state (`selectedLine`, `selectedChat`, `msgText`, `isSending`, pagination, `searchInput`, `console/src/pages/Inbox.tsx:23-29`); `useStickyScroll` + `useVirtualMessages` (`console/src/pages/Inbox.tsx:7-8`); URL state via `useSearchParams` (`console/src/pages/Inbox.tsx:3`).

### Ops (route `/ops`)
- Path: `console/src/pages/Ops.tsx`
- Role: Operations table — per-line status/mode/tags/heartbeat rows with restart/stop/delete/re-link actions, plus filtered log stream.
- Consumers: routed from `console/src/App.tsx:14`, `console/src/App.tsx:59`.
- State: `deleteTarget`, `deleting`, `relinkTarget`, `logFilter`, `selectedLine` + memoized log filtering (`console/src/pages/Ops.tsx:29-41`); data via `useLines/useLogs/useFeed` (`console/src/pages/Ops.tsx:3`).

---

## 13. UI-Shaping Hooks (included for behavior mapping)

### use-toast.tsx — RENDERS UI
- Path: `console/src/hooks/use-toast.tsx`
- Role: `ToastProvider` renders the fixed bottom-right toast stack (AnimatePresence + `Toast` cards) and provides the context API; `MAX_TOASTS = 5` eviction (`console/src/hooks/use-toast.tsx:9-11`).
- Consumers: mounted in `console/src/main.tsx:5`.

### toast-context.ts
- Path: `console/src/hooks/toast-context.ts`
- Role: Context + `useToast()` accessor (`console/src/hooks/toast-context.ts:20-22`); `ToastContextValue` API (`toast/success/error/info/dismiss/clear`, `console/src/hooks/toast-context.ts:11`). Consumed by ~12 components/pages (grep `from '../hooks/toast-context'` and `'../../hooks/toast-context'`).

### use-websocket.tsx — RENDERS PROVIDER
- Path: `console/src/hooks/use-websocket.tsx`
- Role: `RealtimeProvider` (`console/src/hooks/use-websocket.tsx:44`) maintains a single WS connection with exponential backoff (1s-30s, `:41-42`), invalidates React Query caches on server events, exposes `useRealtime()` connected flag (`:33`). Drives polling fallback in `use-fleet`.
- Consumers: provider in `console/src/main.tsx:6`; `useRealtime` in `console/src/components/Nav.tsx:13` and `console/src/hooks/use-fleet.ts:18`.

### use-keyboard-shortcuts.ts — DRIVES KeyboardShortcutsHelp
- Path: `console/src/hooks/use-keyboard-shortcuts.ts`
- Role: Global hotkeys — Cmd/Ctrl+K search, 1/2/3 page nav, `?` help toggle (`console/src/hooks/use-keyboard-shortcuts.ts:25`); input-focus guard.
- Consumers: `console/src/App.tsx:8` (wired to `KeyboardShortcutsHelp` via `onHelp`, `console/src/App.tsx:40`).

### use-update-check.ts — DRIVES Nav badge + UpdateModal
- Path: `console/src/hooks/use-update-check.ts`
- Role: Hourly version poll via React Query (`console/src/hooks/use-update-check.ts:15-25`), one-shot toast on update availability, modal open/close state.
- Consumers: `console/src/App.tsx:7`.

### use-sticky-scroll.ts — UI behavior
- Path: `console/src/hooks/use-sticky-scroll.ts`
- Role: Chat auto-scroll: pins to bottom when user was at bottom, exposes `showJump` for jump-to-latest affordance (`console/src/hooks/use-sticky-scroll.ts:9-13`).
- Consumers: `console/src/pages/Inbox.tsx:7`.

### use-virtual-messages.ts — UI behavior
- Path: `console/src/hooks/use-virtual-messages.ts`
- Role: TanStack Virtual wrapper for the message thread with content-length-based row-height estimation (`estimateMessageRowHeight`, `console/src/hooks/use-virtual-messages.ts:30`; hook at `:62`).
- Consumers: `console/src/pages/Inbox.tsx:8`.

### use-fleet.ts — data layer
- Path: `console/src/hooks/use-fleet.ts`
- Role: React Query hooks (`useLines/useLine/useChats/useMessages/useAccess/useLogs/useTyping/useFeed`, `console/src/hooks/use-fleet.ts:82-133`) with polling intervals disabled while WS connected (`console/src/hooks/use-fleet.ts:3-4`, `:25-30`).
- Consumers: all 4 pages + `console/src/App.tsx:6`.

### use-metrics.ts — data layer
- Path: `console/src/hooks/use-metrics.ts`
- Role: `useMetrics(name, range)` and `useFleetMetrics(range)` query hooks (`console/src/hooks/use-metrics.ts:14`, `:26`).
- Consumers: `console/src/pages/LineDetail.tsx:6`, `console/src/pages/SoupKitchen.tsx:7`.

---

## Verified counts

### Components: 60
- Top-level `console/src/components/*.tsx`: 34 files (ActiveHoursHeatmap, ActivityFeed, AddLineWizard, AlertBanner, CardSelector, ChartPanel, ChatListItem, ConfirmDialog, ContactSearch, EmptyState, ErrorBoundary, FeedCard, FeedIcon, FilterPill, FleetMetricsChart, FleetSessionChart, FleetTokenChart, HeartbeatStrip, KeyboardShortcutsHelp, KpiCard, LinePicker, LineTags, MessageBubble, MessageContent, MetricsChart, ModeBadge, Nav, QrDisplay, RelinkModal, Skeleton, StatusDot, TagInput, Toast, UpdateModal).
- `console/src/components/line-detail/*.tsx`: 16 files (AccessTab, ConfigEditDialog, CreateGroupModal, GroupCard, GroupDetailModal, GroupsTab, HistoryTab, LogsTab, MetricsTab, ModeSwitchDialog, ModeTab, PipelineTab, ScheduleComposerModal, ScheduledMessageRow, ScheduledTab, SummaryTab). Non-component helpers excluded: config-helpers.ts, groups-utils.ts, scheduled-utils.ts, types.ts, index.ts.
- `console/src/components/shared/*.tsx`: 3 files (ChatPicker, ContactSearchPicker, SearchInput).
- `console/src/components/wizard/*.tsx`: 7 files (ConfigStep, form-primitives, IdentityStep, LinkStep, ModelAuthStep, ReviewStep, WizardStep). form-primitives.tsx counts as 1 file but exports 6 primitives (Field, TextInput, NumberInput, SelectInput, TextArea, CheckboxField — `console/src/components/wizard/form-primitives.tsx:20,44,57,71,87,106`). Helper excluded: link-step-events.ts.
- Total: 34 + 16 + 3 + 7 = 60. Note: 1 of the 60 (`ContactSearch`) has no consumers (orphan, see section 5).

### Pages: 4
`console/src/pages/SoupKitchen.tsx`, `console/src/pages/LineDetail.tsx`, `console/src/pages/Inbox.tsx`, `console/src/pages/Ops.tsx` — all routed in `console/src/App.tsx:56-59`.

### LineDetail tabs: 9 (7 base + 2 MCP-gated)
- File count: 9 `*Tab.tsx` files in `console/src/components/line-detail/` (AccessTab, GroupsTab, HistoryTab, LogsTab, MetricsTab, ModeTab, PipelineTab, ScheduledTab, SummaryTab).
- Registry verification: `BASE_TABS` defines 7 entries (summary, mode, pipeline, access, history, logs, metrics) at `console/src/pages/LineDetail.tsx:37-45`; `MCP_TABS` defines 2 entries (scheduled, groups) at `console/src/pages/LineDetail.tsx:48-52`. The conditional: `hasMcpSocket = line.mode === 'passive' || (line.mode === 'agent' && !line.sandboxPerChat)` at `console/src/pages/LineDetail.tsx:124`, and `tabs = hasMcpSocket ? [...BASE_TABS, ...MCP_TABS] : BASE_TABS` at `console/src/pages/LineDetail.tsx:125`. File count matches registry count exactly (9 = 7 + 2).

### Modal/dialog components: 10
1. ConfirmDialog — `console/src/components/ConfirmDialog.tsx`
2. RelinkModal — `console/src/components/RelinkModal.tsx`
3. UpdateModal — `console/src/components/UpdateModal.tsx` (backdrop at `console/src/components/UpdateModal.tsx:301`)
4. KeyboardShortcutsHelp — `console/src/components/KeyboardShortcutsHelp.tsx` (fixed-overlay dialog, `console/src/components/KeyboardShortcutsHelp.tsx:19-27`)
5. AddLineWizard — `console/src/components/AddLineWizard.tsx` (renders as `c-dialog-backdrop` modal, `console/src/components/AddLineWizard.tsx:255-258`)
6. ConfigEditDialog — `console/src/components/line-detail/ConfigEditDialog.tsx` (backdrop at `:264`)
7. ModeSwitchDialog — `console/src/components/line-detail/ModeSwitchDialog.tsx` (renders through ConfirmDialog shell)
8. CreateGroupModal — `console/src/components/line-detail/CreateGroupModal.tsx` (backdrop at `:65`)
9. GroupDetailModal — `console/src/components/line-detail/GroupDetailModal.tsx` (backdrop at `:756`)
10. ScheduleComposerModal — `console/src/components/line-detail/ScheduleComposerModal.tsx` (backdrop at `:174`)

### Inconclusive
- None. All claims above were verified against source with file:line evidence. The only anomaly found is the orphaned `ContactSearch` component (no importers anywhere in `console/src`).
