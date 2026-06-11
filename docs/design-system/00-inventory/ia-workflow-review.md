# IA and Operator-Workflow Review — WhatSoup Console

Part of the SOUP Design System v3 audit (00-inventory). Every claim cites repo-relative `file:line` evidence from the current tree. Items that cannot be verified from the console source alone are marked **Inconclusive**. The v2 design precedent baseline is `docs/console-mockups/gap-analysis.html`; section 6.5 reconciles its findings against the shipped code.

---

## 1. Route Hierarchy

Routing is a flat, four-page React Router tree defined in `console/src/App.tsx`. `BrowserRouter` is mounted in `console/src/main.tsx:23`, wrapped by `QueryClientProvider` (`console/src/main.tsx:21`) and `RealtimeProvider` (`console/src/main.tsx:22`).

| Route | Page | Params | Evidence |
|---|---|---|---|
| `/` | SoupKitchen (fleet overview) | — | `console/src/App.tsx:55` |
| `/lines/:name` | LineDetail | `:name` = instance name, read via `useParams` | `console/src/App.tsx:56`, `console/src/pages/LineDetail.tsx:57` |
| `/inbox` | Inbox | query params `?line=&chat=` consumed as a one-shot deep link, then cleared with `replace` | `console/src/App.tsx:57`, `console/src/pages/Inbox.tsx:40-51` |
| `/ops` | Ops | — | `console/src/App.tsx:58` |
| `*` | redirect | `<Navigate to="/" replace />` | `console/src/App.tsx:59` |

- **Lazy loading**: all four pages are route-level code-split via `lazy()` (`console/src/App.tsx:11-14`); `UpdateModal` is modal-level code-split (`console/src/App.tsx:17`). `AddLineWizard` is lazy inside SoupKitchen (`console/src/pages/SoupKitchen.tsx:4`); `RelinkModal` is lazy inside LineDetail (`console/src/pages/LineDetail.tsx:16`) and Ops (`console/src/pages/Ops.tsx:24`).
- **Suspense fallback**: a full-page centered text `Loading...` (`console/src/App.tsx:19-25`) — text only, no skeleton, no spinner.
- **404 handling**: there is no 404 page. Unknown paths silently redirect to `/` (`console/src/App.tsx:59`). A *valid route with an invalid param* (`/lines/does-not-exist`) is worse: LineDetail renders a skeleton forever because the `!line` branch has no not-found or timeout state (`console/src/pages/LineDetail.tsx:101-115`). This is a dead end (see 6.2).
- **Error isolation**: each route element is wrapped in its own `ErrorBoundary` (`console/src/App.tsx:55-58`), which renders an error EmptyState with a Retry button (`console/src/components/ErrorBoundary.tsx:37-49`).
- **Deep links into the app**: the activity feed emits `/inbox?line=...&chat=...` navigations for message events (`console/src/components/FeedCard.tsx:348`); SoupKitchen table rows navigate to `/lines/${name}` (`console/src/pages/SoupKitchen.tsx:464`).

## 2. Nav Structure

`console/src/components/Nav.tsx` renders a single horizontal top bar.

**Left cluster — brand + 3 items, in order:**

1. Logo wordmark "What"+"Soup" in two colors (`console/src/components/Nav.tsx:36-41`).
2. **Soup Kitchen** (`/`, LayoutDashboard icon) — `console/src/components/Nav.tsx:43-64`. Active state is hand-rolled: `isFleetActive = pathname === '/' || pathname.startsWith('/lines/')` (`console/src/components/Nav.tsx:27`), so LineDetail keeps the fleet item highlighted. Active = `text-t1 bg-d4` + a green underline accent bar (`console/src/components/Nav.tsx:54-63`).
3. **Inbox** (`/inbox`, Inbox icon) — `NavLink` with `isActive` render prop (`console/src/components/Nav.tsx:66-99`). Carries the only badge in the nav: total fleet unread, capped at "99+", warn-colored (`console/src/components/Nav.tsx:80-86`); the count is summed in App from `line.unread` (`console/src/App.tsx:30`).
4. **Ops** (`/ops`, Terminal icon) — `console/src/components/Nav.tsx:101-127`.

**Right cluster — system status, in order** (`console/src/components/Nav.tsx:131-175`):

- Realtime indicator: "Live" (Wifi, ok-color) when WebSocket connected, "Polling" (WifiOff, muted) when not (`console/src/components/Nav.tsx:132-142`), driven by `useRealtime()` (`console/src/hooks/use-websocket.tsx:33-35`).
- Alert summary: "All systems operational" or "{n} alerts" in crit color (`console/src/components/Nav.tsx:144-156`). The count is `lines.filter(l => l.status !== 'online').length` (`console/src/App.tsx:29`). **This is a non-interactive `<span>`** — it announces alerts but offers no path to them (see 6.2).
- Version / update indicator: plain `v{sha}` normally; when `updateAvailable`, it becomes a clickable `{sha} → {remoteSha}` button with a Download icon that opens UpdateModal (`console/src/components/Nav.tsx:157-174`, handler wired at `console/src/App.tsx:50`).

**Keyboard shortcuts** (`console/src/hooks/use-keyboard-shortcuts.ts`):

- `1`/`2`/`3` navigate to SoupKitchen / Inbox / Ops when no input is focused (`console/src/hooks/use-keyboard-shortcuts.ts:55-66`).
- `?` toggles the shortcuts help modal (`console/src/hooks/use-keyboard-shortcuts.ts:49-52`, wired at `console/src/App.tsx:40`).
- **`Cmd/Ctrl+K` is dead.** The hook intercepts it and calls `handlers.onSearch?.()` (`console/src/hooks/use-keyboard-shortcuts.ts:39-43`), but the only call site passes only `onHelp` (`console/src/App.tsx:40`), so the keypress is swallowed and nothing happens. The help modal still advertises "⌘+K — Focus search" (`console/src/components/KeyboardShortcutsHelp.tsx:7`). Documented-but-nonfunctional shortcut.
- There are no per-list shortcuts (j/k navigation, Enter-to-open) anywhere; `ChatListItem` supports Enter/Space activation only via its own keydown (`console/src/components/ChatListItem.tsx:21`).

**Hidden/conditional nav surface**: LineDetail has no nav item of its own — it is reachable only by SoupKitchen row click (`console/src/pages/SoupKitchen.tsx:464`); the back affordance is an arrow that always goes to `/` (`console/src/pages/LineDetail.tsx:140-146`). Ops instance cards select a line for the log pane but do not link to LineDetail at all (`console/src/pages/Ops.tsx:121-130`).

## 3. Vocabulary Audit

### 3.1 Page and section labels

| Term | Where | Evidence |
|---|---|---|
| "Soup Kitchen" | nav label for `/` | `console/src/components/Nav.tsx:53` |
| "Inbox", "Ops" | nav labels | `console/src/components/Nav.tsx:79`, `console/src/components/Nav.tsx:114` |
| "Instances" | SoupKitchen table heading | `console/src/pages/SoupKitchen.tsx:382` |
| "Line" | SoupKitchen table column for the same objects | `console/src/pages/SoupKitchen.tsx:35` |
| "Add Line" | primary create button | `console/src/pages/SoupKitchen.tsx:427` |
| "Fleet Status" | Ops left panel heading | `console/src/pages/Ops.tsx:81` |
| "Metrics" | SoupKitchen chart card heading | `console/src/pages/SoupKitchen.tsx:283` |
| "Activity" | feed toolbar title | `console/src/components/ActivityFeed.tsx:139` |

### 3.2 LineDetail tab labels

`BASE_TABS` (`console/src/pages/LineDetail.tsx:37-45`): **Summary, Mode, Pipeline, Access, History, Logs, Metrics**. `MCP_TABS` (`console/src/pages/LineDetail.tsx:48-51`): **Scheduled, Groups** — appended only when the instance has a global MCP socket (`hasMcpSocket = passive || (agent && !sandboxPerChat)`, `console/src/pages/LineDetail.tsx:124-125`). Chat-mode and sandboxed-agent lines therefore show 7 tabs, others 9 — the conditional tabs disappear without explanation rather than rendering disabled-with-reason.

### 3.3 "Lines" vs "instances" drift

The two words name the same object interchangeably, sometimes in the same view:

- SoupKitchen: heading "Instances" (`console/src/pages/SoupKitchen.tsx:382`) over a "Line" column (`:35`), with "Search lines..." placeholder (`:415`) and an "Add Line" button (`:427`); empty state says "No instances match the current filters" (`:518`).
- Ops: "{n} instances" (`console/src/pages/Ops.tsx:100`), "No instances discovered. Create one from the Soup Kitchen." (`:119`).
- Delete confirm body calls it an instance (`console/src/pages/LineDetail.tsx:333`), while the wizard calls it a line ("Add New Line", `console/src/components/AddLineWizard.tsx:272`; "Abandon new line?", `:379`) and then an instance in the same dialog body (`:386`).
- KPI label "Lines Connected" (`console/src/pages/SoupKitchen.tsx:226`).

v3 should pick one term ("line" is the product noun; "instance" is the infra noun) and assign each a consistent layer.

### 3.4 Playful vs operational naming tension

- Playful: "Soup Kitchen" (`console/src/components/Nav.tsx:53`), the split-color "WhatSoup" wordmark (`:39-40`), "Line is live!" success copy (`console/src/components/wizard/LinkStep.tsx:128`).
- Operational: "Ops", "Fleet Status", "All systems operational" (`console/src/components/Nav.tsx:147`), "instances", log-level pills `all/error/warn/info/debug` (`console/src/pages/Ops.tsx:240`), mode vocabulary `passive/chat/agent` (`console/src/pages/SoupKitchen.tsx:48`, descriptions at `console/src/components/line-detail/ModeSwitchDialog.tsx:9-13`).

The console reads as an operations tool with one playful landmark. The rebrand decision is whether "Soup Kitchen" survives as the fleet page name; everything else is already operational in tone.

### 3.5 Leftover "WhatSoup" strings (`grep 'WhatSoup' console/src`)

User-visible:

- Nav wordmark "What"+"Soup" (`console/src/components/Nav.tsx:39-40`).
- UpdateModal title "Update WhatSoup" (`console/src/components/UpdateModal.tsx:318`).
- Generated agent CLAUDE.md template: "an AI agent running on WhatsApp via WhatSoup" (`console/src/components/wizard/ConfigStep.tsx:114`) — this string is written into every new agent's workspace, so it outlives a UI-only rebrand.

Comment-only (no UI impact): `console/src/types.ts:2`, `console/src/mock-data.ts:2`, `console/src/hooks/use-keyboard-shortcuts.ts:2`, `console/src/hooks/use-fleet.ts:2`.

### 3.6 Empty-state and button copy inventory (selected)

- "Select a conversation" / "Choose a line and chat from the left panel." (`console/src/pages/Inbox.tsx:468-472`).
- "No messages loaded" / "Messages will appear here." (`console/src/pages/Inbox.tsx:408-412`).
- "No chats found" (`console/src/pages/Inbox.tsx:243-247`).
- "No scheduled messages" / "Messages scheduled via the agent or MCP tools will appear here." (`console/src/components/line-detail/ScheduledTab.tsx:119-123`).
- "No groups" / "Groups this instance participates in will appear here." (`console/src/components/line-detail/GroupsTab.tsx:58-61`).
- "No errors" / "No activity" (`console/src/components/ActivityFeed.tsx:200-204`).
- Buttons: "Add Line", "Create Line" (`console/src/components/wizard/ReviewStep.tsx:218`), "Create Group" (`console/src/components/line-detail/CreateGroupModal.tsx:145`), "New Scheduled Message" (`console/src/components/line-detail/ScheduledTab.tsx:114`), "Delete permanently" (`console/src/pages/LineDetail.tsx:327`), "Restart Selected" (`console/src/components/UpdateModal.tsx:435`), "Mark Read" (`console/src/pages/Inbox.tsx:552`), "Load older messages" (`console/src/pages/Inbox.tsx:382`).

## 4. Workflow Walkthroughs

### 4a. Fleet overview scan → drill into a line

**Path**: SoupKitchen renders, top to bottom: 7-card KPI strip (`console/src/pages/SoupKitchen.tsx:218-277`), Metrics chart card with 24h/7d/30d range pills (`:280-365`), AlertBanner (`:368`), then the main split: Instances table (12 columns, `:33-46`) and ActivityFeed (`:527-530`). A row click runs `navigate('/lines/${line.name}')` (`:464`). On LineDetail the first visible KPIs are the header strip — status dot, name, mode badge, tags, phone, uptime/port/msgs, heartbeat strip (`console/src/pages/LineDetail.tsx:136-213`) — then the Summary tab's adaptive KPI cards: STATUS, CONNECTION, LINK, plus mode-specific cards (UNREAD, QUEUE/ENRICHMENT, PROVIDER/SESSIONS), MODEL, ISOLATION, TOKENS (`console/src/components/line-detail/SummaryTab.tsx:35-69`).

**Scan-path observations**:

- KPI cards double as filters (`toggleKpi`, `console/src/pages/SoupKitchen.tsx:110-116`) and three of them also expand a chart. This is powerful but undiscoverable — nothing in the card visual indicates click-to-filter, and the active-filter state lives only in the card highlight.
- Unhealthy rows get a crit/warn row wash (`console/src/pages/SoupKitchen.tsx:465`), which is good triage signal, but the table has no default sort placing them on top; `sortKey` starts `null` (`:84`), so order is whatever the API returns. **Inconclusive** whether the API pre-sorts.
- **Sort/filter/search state is not persisted.** All of it is `useState` (`console/src/pages/SoupKitchen.tsx:78-85`); drilling into a line and pressing the back arrow (`console/src/pages/LineDetail.tsx:142`, hard `navigate('/')`) resets every filter, sort, and search term. Nothing is mirrored to the URL or to the preferences store — the only persisted preference in the app is LineDetail's metrics range (`console/src/pages/LineDetail.tsx:60-63`).
- **Misleading loading state**: while `useLines()` is in flight, `lines` defaults to `[]` (`console/src/pages/SoupKitchen.tsx:57,72`) and the table renders the *filtered-empty* message "No instances match the current filters" (`:515-520`). A cold load looks like an over-filtered table. Ops handles the same case correctly with an explicit `linesLoading` branch (`console/src/pages/Ops.tsx:113-116`).
- AlertBanner chips are dead controls here — see 6.2.

### 4b. Inbox triage

**Path**: three fixed panes (`console/src/pages/Inbox.tsx:212-661`). Left: LinePicker toolbar (`:225-230`) over the chat list (`:233-248`). Selecting a line resets the chat selection (`:228`). `activeLine` defaults to the first line in fleet order (`:86`). Center: chat header (`:258-276`), per-conversation search bar (`:278-318`), virtualized messages (`:364-425`), composer (`:427-464`). Right: contact details + actions (`:477-618`).

- **Unread handling**: per-chat unread badge in the list (`console/src/components/ChatListItem.tsx:64-69`); header shows "{n} unread"/"read" (`console/src/pages/Inbox.tsx:275`). Opening a conversation does **not** mark it read — clearing unread is a manual "Mark Read" button in the right panel, rendered only while `unreadCount > 0` (`:530-554`), with optimistic cache update and rollback (`:537-546`). There is no fleet-wide or per-line "mark all read", and no unread-only filter; the chat list has no search or filter at all (the only search is within an opened conversation, `:287-294`).
- **Line picker**: dropdown with status dot, mode badge, phone per line (`console/src/components/LinePicker.tsx:43-88`). Triage across lines is serial — one line's chats at a time (see 6.5 "cross-instance inbox").
- **Send**: optimistic insert with negative pk, rollback on failure (`console/src/pages/Inbox.tsx:149-180`); Enter sends, Shift+Enter newlines (`:451`).
- **Search**: 300 ms debounce (`:80-84`), React Query cached 30 s (`:102-107`), result count and clear button (`:295-317`), error/none/busy EmptyStates (`:326-362`).
- **Interruption/inconsistency**: the right-panel "Allow Contact"/"Block Contact" actions fire immediately with no confirmation (`:555-592`), while the *same operation* on LineDetail's Access tab requires a ConfirmDialog (`console/src/components/line-detail/AccessTab.tsx:169-182`). Blocking a contact from the Inbox is one accidental click.
- **Dead ends**: empty chat list shows "No chats found" with no remedy action (`:243-247`); this also displays during initial load since `chats` is undefined while fetching (`:87`). "No messages loaded / Messages will appear here." (`:408-412`) offers no retry.
- The Save Contact flow uses a hand-rolled dialog (`:619-660`) rather than `ConfirmDialog` or a shared modal primitive — one more bespoke modal shell for v3 to consolidate.

### 4c. Add-line wizard

**Actual step order** — verified: `STEPS = ['Identity', 'Link', 'Model', 'Config', 'Review']` (`console/src/components/AddLineWizard.tsx:27`), i.e. Identity → **Link (QR)** → Model → Config → Review. The prompt's assumed order (Identity → Config → ModelAuth → Link → Review) is wrong for current code; linking happens *second*, because the instance must exist on disk for auth keys: advancing from step 0 calls `api.createLine()` immediately (`console/src/components/AddLineWizard.tsx:191-207`).

- **Validation**: step 0 requires type, normalized name >= 2 chars, >= 1 admin phone (`console/src/components/AddLineWizard.tsx:94-103`); step 3 requires a system prompt for non-passive and a cwd for agents (`:104-111`). Errors render inline per-field and as a footer banner for create failures (`:329-336`).
- **QR linking step** (`console/src/components/wizard/LinkStep.tsx`): opens an SSE stream at `/api/lines/{name}/auth` with a single-use audience ticket (`:27-44`); renders QR (`:173-184`), ages it with a 45 s "expiring soon" warning (`:168,196-211`); `connected` event flips to a success panel with a "View Line" button that advances the wizard (`:116-138`, `console/src/components/AddLineWizard.tsx:299-304`); SSE errors retry up to 5 times with fresh tickets (`:79-93`), then show "Try Again" (`:141-164`).
- **Flow trap**: while on Link, the wizard footer is hidden (`console/src/components/AddLineWizard.tsx:325`) and LinkStep renders no skip/back control of its own (`console/src/components/wizard/LinkStep.tsx:116-218`). If the operator cannot scan right now, the only exits are waiting or closing the wizard — and closing after creation triggers "Abandon new line?" whose confirm **deletes the just-created instance** (`console/src/components/AddLineWizard.tsx:212-233,377-388`). There is no "save unlinked, link later" path from inside the wizard, even though the rest of the app supports unlinked lines via Re-link (`console/src/pages/LineDetail.tsx:187-195`).
- **Close mid-wizard**: dirty-but-not-created → "Discard changes?"; created → "Abandon" + `api.deleteLine` (`:224-233`); a `beforeunload` browser warning guards tab close between creation and completion (`:171-179`). The name field is locked after creation to prevent orphan duplicates on back-nav (`:181-182,296`).
- **Finish**: Review's "Create Line" button (`console/src/components/wizard/ReviewStep.tsx:218`) actually performs `api.updateConfig` — the instance already exists and is linked (`console/src/components/AddLineWizard.tsx:235-251`); the label lies slightly about what happens. Review maps backend validation errors to "click Edit on the X card" guidance (`console/src/components/wizard/ReviewStep.tsx:86-92`) and offers per-card Edit jumps (`:127,142,168`).

### 4d. Update flow

**Detection**: `useUpdateCheck` polls `/api` version hourly (`console/src/hooks/use-update-check.ts:6,20-25`), fires a one-time toast (`:27-35`), and the nav shows the `{sha} → {remoteSha}` button (`console/src/components/Nav.tsx:158-168`).

**Execution** (`console/src/components/UpdateModal.tsx`): phases `confirm → updating → restarting-fleet → restart-instances → done | error` (`:32`). Updating streams SSE-style progress over `fetch('/api/update')` with five labeled steps (`:22-30,192-253`); a dropped connection during the restart step is treated as expected and transitions to polling the version endpoint every 2 s with a 60 s timeout (`:134-164`). The restart-instances phase presents per-instance checkboxes, defaulted to online instances only (`:91-97,385-439`); "Restart Selected" runs them serially (`:256-275`); full success auto-closes after 2.2 s (`:269-274`).

- **Recovery gaps**: the error phase offers only "Close" — no retry (`:372-382`). Escape closes the modal at any phase (`:127-132`) and `handleClose` aborts the in-flight update stream (`:277-285`); a stray Escape mid-update silently abandons progress monitoring while the server-side update presumably continues (**Inconclusive** server behavior — outside console source).
- **Relink** (`console/src/components/RelinkModal.tsx`): a thin dialog wrapper that reuses `LinkStep` (`:51`). Entry points: LineDetail header "Re-link" when `linkedStatus === 'unlinked'` (`console/src/pages/LineDetail.tsx:187-195`) and Ops unhealthy-card "Re-link" (`console/src/pages/Ops.tsx:174-181`). On success both invalidate caches and toast (`console/src/pages/LineDetail.tsx:341`, `console/src/pages/Ops.tsx:328`). Good reuse of the linking flow.

### 4e. Filtering and search

Where filters live, per page:

| Surface | Controls | Persistence | Evidence |
|---|---|---|---|
| SoupKitchen | mode FilterPills with counts, KPI-card filters, inline search input, sortable column headers | none (useState) | `console/src/pages/SoupKitchen.tsx:385-419,78-85,436-451` |
| ActivityFeed | 6 FilterPills with counts + pause/resume snapshot | none | `console/src/components/ActivityFeed.tsx:163-181,148-159` |
| Inbox | per-conversation search only (debounced) | none; reset on chat/line switch | `console/src/pages/Inbox.tsx:59-63,80-84` |
| Ops | log-level FilterPills, line picker | none | `console/src/pages/Ops.tsx:34-44,240-250` |
| LineDetail Logs | level filter passed into LogsTab | none | `console/src/pages/LineDetail.tsx:78,299` |
| LineDetail Metrics | range pills | **localStorage preference** | `console/src/pages/LineDetail.tsx:60-63` |
| GroupDetailModal | participant SearchInput | none | `console/src/components/line-detail/GroupDetailModal.tsx:375-380` |

- The shared `SearchInput` component (`console/src/components/shared/SearchInput.tsx`) is used only by group surfaces (`console/src/components/line-detail/GroupDetailModal.tsx:9`); SoupKitchen (`console/src/pages/SoupKitchen.tsx:405-419`) and Inbox (`console/src/pages/Inbox.tsx:281-294`) each hand-roll the identical icon-input pattern. Three implementations of one control.
- `console/src/components/ContactSearch.tsx` has **no importers** (grep over `console/src` finds only its own definition; the group flows use `console/src/components/shared/ContactSearchPicker.tsx` instead, `console/src/components/line-detail/CreateGroupModal.tsx:6`). Orphaned component.
- Only one filter in the entire app survives navigation (metrics range). Everything else resets, which combines badly with the back-arrow hard navigation noted in 4a.

### 4f. Status and health review

- **StatusDot semantics**: exactly three states — `online` (ok green + breathing ring), `degraded` (warn), `unreachable` (crit) (`console/src/components/StatusDot.tsx:3,16-26,43-51`). The same triad drives row washes (`console/src/pages/SoupKitchen.tsx:457-465`) and LineDetail's header dot (`console/src/pages/LineDetail.tsx:149-161`).
- **HeartbeatStrip**: 20 bars, `up/down/slow` mapped to ok/crit/warn with height encoding (`console/src/components/HeartbeatStrip.tsx:9-15`). **Padding hazard**: when fewer than 20 beats exist, the strip left-pads with synthetic `'up'` beats (`console/src/components/HeartbeatStrip.tsx:19-21`) — a freshly created or data-poor line renders as mostly healthy history. The aria-label counts only real beats (`:27`), so the visual and accessible representations disagree.
- **Ops page purpose**: fleet status cards (heartbeat + per-mode runtime stats + repair actions on unhealthy cards) on the left, a per-line log stream with level filters on the right (`console/src/pages/Ops.tsx:73-211,213-308`). It is the recovery surface: Re-link / Restart / Delete appear directly on unhealthy cards (`:171-205`).
- **AlertBanner**: SoupKitchen-only, derived from `unreachable|degraded` lines with `auth expired`/`connection lost`/`degraded` messages (`console/src/pages/SoupKitchen.tsx:118-131,368`).
- **Two competing alert definitions**: the nav counts `status !== 'online'` lines (`console/src/App.tsx:29`); Ops counts error *feed events* (`console/src/pages/Ops.tsx:46`). The nav can read "2 alerts" while Ops says "all healthy", and vice versa. One vocabulary ("alert") with two computations.

### 4g. Degraded-state recovery

- **WebSocket disconnect**: `RealtimeProvider` reconnects with exponential backoff 1 s → 30 s (`console/src/hooks/use-websocket.tsx:41-42,104-107`), invalidates `lines/feed/typing` caches on close so polling refetch takes over (`:99-102`), and the only operator-visible signal is the nav "Polling" pill (`console/src/components/Nav.tsx:138-141`). There is no banner, no toast, and no manual "reconnect now" affordance — acceptable for a self-healing fallback, but a long outage is easy to miss.
- **Error boundaries**: per-route, with message + Retry (re-render attempt) (`console/src/components/ErrorBoundary.tsx:30-49`).
- **Data-load failures**: SoupKitchen shows an inline crit row with the message but no retry button (`console/src/pages/SoupKitchen.tsx:508-514`); ChartPanel gets a retry via `onRetry={() => metricsRefetch()}` (`:309`); Scheduled/Groups tabs render error EmptyStates, Groups' detail modal has retry (`console/src/components/line-detail/ScheduledTab.tsx:90-98`, `console/src/components/line-detail/GroupsTab.tsx:29-37`, `console/src/components/line-detail/GroupDetailModal.tsx:809-816`). Inbox ignores chat-list query errors entirely (`console/src/pages/Inbox.tsx:87` destructures only `data`).
- **QR relink** as recovery: surfaced contextually when `linkedStatus === 'unlinked'` in LineDetail header (`console/src/pages/LineDetail.tsx:187-195`), Ops unhealthy cards (`console/src/pages/Ops.tsx:174-181`), and SoupKitchen alert text "auth expired" (`console/src/pages/SoupKitchen.tsx:127`) — though the SoupKitchen alert itself is not clickable (6.2), so the operator must know to go to Ops or LineDetail.

### 4h. Confirmations — destructive-action inventory

`ConfirmDialog` (`console/src/components/ConfirmDialog.tsx`) call sites, enumerated:

| Action | Guarded? | Evidence |
|---|---|---|
| Delete line (LineDetail header) | Yes — danger, "Delete permanently", spells out data loss | `console/src/pages/LineDetail.tsx:324-334` |
| Delete line (Ops card) | Yes — same dialog | `console/src/pages/Ops.tsx:311-321` |
| Stop instance (Summary tab) | Yes — danger, consequence bullets | `console/src/components/line-detail/SummaryTab.tsx:264-285` |
| Stop instance (ActivityFeed quick action) | Yes | `console/src/components/ActivityFeed.tsx:207-217` |
| Restart (Summary tab) | Yes — primary variant, consequence bullets | `console/src/components/line-detail/SummaryTab.tsx:240-262` |
| **Restart (LineDetail header)** | **No** — fires `api.restart` on click | `console/src/pages/LineDetail.tsx:196-204` |
| **Restart (Ops unhealthy card)** | **No** | `console/src/pages/Ops.tsx:183-196` |
| **Restart (ActivityFeed quick action)** | **No** | `console/src/components/ActivityFeed.tsx:101-109` |
| Mode switch (restarts instance) | Yes — ConfirmDialog shell + warning strip | `console/src/components/line-detail/ModeSwitchDialog.tsx:52-118` |
| Wizard exit / abandon (deletes created instance) | Yes | `console/src/components/AddLineWizard.tsx:377-388` |
| Access allow/block (Access tab) | Yes — both directions | `console/src/components/line-detail/AccessTab.tsx:169-182` |
| **Access allow/block (Inbox panel)** | **No** | `console/src/pages/Inbox.tsx:555-592` |
| Group: revoke invite link | Yes | `console/src/components/line-detail/GroupDetailModal.tsx:225-234` |
| Group: remove participant | Yes | `console/src/components/line-detail/GroupDetailModal.tsx:433-443` |
| Group: leave group | Yes | `console/src/components/line-detail/GroupDetailModal.tsx:700-710` |
| **Group: promote/demote admin** | **No** — immediate | `console/src/components/line-detail/GroupDetailModal.tsx:277-286` |
| **Group: approve/reject join request** | **No** — immediate | `console/src/components/line-detail/GroupDetailModal.tsx:305-313` |
| **Cancel (delete) scheduled message** | **No** — trash icon deletes immediately, no undo | `console/src/components/line-detail/ScheduledTab.tsx:48-59`, `console/src/components/line-detail/ScheduledMessageRow.tsx:151-161` |
| **Update-flow instance restarts** | **No** per-instance confirm (checkbox selection is the gate) | `console/src/components/UpdateModal.tsx:256-275` |

Pattern: restart is confirmed in exactly one of its four entry points; allow/block is confirmed in one of its two. The guard depends on *where* the operator happens to click, not on the action's blast radius. v3 needs a per-action (not per-surface) confirmation policy.

### 4i. Scheduled messages

**Flow** (`console/src/components/line-detail/ScheduledTab.tsx`): list refetches every 30 s (`:18-23`), sorted pending-first ascending then the rest descending (`:35-44`). "New Scheduled Message" opens `ScheduleComposerModal` (`:108-115,138-145`). Rows (`console/src/components/line-detail/ScheduledMessageRow.tsx`) show content-type icon, preview, status badge, target, time, recurrence in human terms via `cronToHuman` (`:104-127`), failure error inline (`:130-136`), and an expandable detail strip (next run / last sent / retries / id, `:190-206`).

- **Create/edit**: composer supports chat picking, text or media-by-file-path, datetime-local, one-shot vs recurring with cron presets (Daily/Weekly/Monthly) + raw cron input + live human preview (`console/src/components/line-detail/ScheduleComposerModal.tsx:199-356`); validates chat/time-in-future/content before submit (`:108-129`). Edit is offered only for `pending` messages (`console/src/components/line-detail/ScheduledMessageRow.tsx:141-150`); Duplicate clones via a sentinel `id: -1` (`console/src/components/line-detail/ScheduledTab.tsx:66-70`).
- **No pause.** There is no pause/resume affordance for recurring schedules anywhere in the tab or row actions (`console/src/components/line-detail/ScheduledMessageRow.tsx:139-186` is the full action set: edit, cancel, duplicate, expand). The only way to stop a recurring message is to cancel (delete) it — unconfirmed (see 4h) — and recreate it later. Whether the backend supports pause is **Inconclusive** from console code; the UI gap is verified.
- Media scheduling requires typing a server-side file path (`console/src/components/line-detail/ScheduleComposerModal.tsx:260-267`) — no upload affordance; operator must know the host filesystem.

### 4j. Group management

**Flow**: GroupsTab lists `GroupCard`s with avatar, subject, role badge, participant count (`console/src/components/line-detail/GroupsTab.tsx:64-73`, `console/src/components/line-detail/GroupCard.tsx:22-63`). Card click opens `GroupDetailModal` with internal tabs Info / Participants / Settings (`console/src/components/line-detail/GroupDetailModal.tsx:786-802`); "Create Group" opens `CreateGroupModal` with subject + ContactSearchPicker, both required (`console/src/components/line-detail/CreateGroupModal.tsx:39-47,138-146`).

- **Modal-over-modal: yes, verified.** GroupDetailModal is a dialog (`console/src/components/line-detail/GroupDetailModal.tsx:756-762`) that renders `ConfirmDialog` children for revoke (`:225-234`), remove participant (`:433-443`), and leave group (`:700-710`) — each confirm stacks a second backdrop over the first.
- **Escape double-close defect**: GroupDetailModal registers a document-level Escape handler while open (`console/src/components/line-detail/GroupDetailModal.tsx:729-734`), and ConfirmDialog registers its own (`console/src/components/ConfirmDialog.tsx:26-31`). Both fire on the same keypress, so pressing Escape on "Leave group?" dismisses the confirm *and* the group modal underneath. Same stacked-listener pattern exists for AddLineWizard's exit confirm (wizard backdrop click + ConfirmDialog, `console/src/components/AddLineWizard.tsx:254-259,377-388` — the wizard has no Escape handler, so only backdrop interplay applies there).
- Inline edits (subject/description) save on blur with rollback on failure (`:60-82,128-159`); settings toggles (announce/locked/member-add/join-approval/ephemeral) apply immediately with per-key busy state (`:468-518`); admin gating via `isAdmin` computed from the line's own JID with @lid/@s.whatsapp.net tolerance (`:744-750`).

## 5. Structural Issues

### 5.1 Modal-over-modal (enumerated)

1. GroupDetailModal + ConfirmDialog x3 (`console/src/components/line-detail/GroupDetailModal.tsx:225,433,700` inside dialog at `:756`), with the Escape double-close defect (5.1 ↔ 4j).
2. AddLineWizard dialog + exit ConfirmDialog (`console/src/components/AddLineWizard.tsx:254,377-388`).
3. All other confirms are page-level (LineDetail, Ops, SummaryTab, AccessTab, ActivityFeed) and do not stack.

### 5.2 Dead ends (states with no available action)

- Nav alert count: announces "{n} alerts" but is a plain span — no click-through to Ops or the affected line (`console/src/components/Nav.tsx:150-156`).
- SoupKitchen AlertBanner chips: rendered as `<button>`s wired to `onAlertClick?.()` (`console/src/components/AlertBanner.tsx:36-48`) but SoupKitchen passes no handler (`console/src/pages/SoupKitchen.tsx:368`) — clickable-looking chips that do nothing.
- `/lines/:name` with an unknown name: permanent skeleton, no not-found message, no way out but the browser (`console/src/pages/LineDetail.tsx:101-115`).
- Cmd/Ctrl+K: intercepted and discarded (`console/src/hooks/use-keyboard-shortcuts.ts:39-43`, `console/src/App.tsx:40`) while advertised in help (`console/src/components/KeyboardShortcutsHelp.tsx:7`).
- Wizard Link step: no skip/back; abandon deletes the instance (`console/src/components/AddLineWizard.tsx:325,377-388`).
- Inbox "No chats found": no action offered, and shown during load (`console/src/pages/Inbox.tsx:243-247`).
- UpdateModal error phase: Close only, no retry (`console/src/components/UpdateModal.tsx:372-382`).

### 5.3 Flow interruptions

- Route transitions drop to a bare full-page "Loading..." text (`console/src/App.tsx:19-25`) — LineDetail proves the codebase has a skeleton vocabulary (`console/src/pages/LineDetail.tsx:101-114`, `console/src/components/Skeleton.tsx`), but route Suspense does not use it.
- SoupKitchen cold-load masquerades as a filtered-empty table (4a; `console/src/pages/SoupKitchen.tsx:515-520`).
- Mode switch and several settings changes restart the instance immediately after confirm (`console/src/components/line-detail/ModeSwitchDialog.tsx:36-37`) — warned in dialog copy, properly.
- Escape during a running update aborts client-side monitoring (4d; `console/src/components/UpdateModal.tsx:127-132,277-285`).

### 5.4 Scan-path problems

- **Primary action placement is inconsistent**: SoupKitchen's create action is top-right of the table toolbar (`console/src/pages/SoupKitchen.tsx:421-428`); ScheduledTab/GroupsTab put theirs top-right of the tab body (`console/src/components/line-detail/ScheduledTab.tsx:104-116`, `console/src/components/line-detail/GroupsTab.tsx:43-55`); Inbox's primary action (Send) is bottom-right of the center pane (`console/src/pages/Inbox.tsx:453-463`); LineDetail's header mixes a destructive Delete directly beside Restart/Re-link in the title row (`console/src/pages/LineDetail.tsx:186-212`) with no spatial separation of severity.
- **Duplicated chat UI**: Inbox center pane and LineDetail's History tab implement the same conversation view twice with divergent pagination strategies — Inbox appends older messages into the React Query cache (`console/src/pages/Inbox.tsx:128-144`) while HistoryTab keeps a parallel local `olderMessages` array (`console/src/components/line-detail/HistoryTab.tsx:36-66`). Two scan patterns, two behaviors, one task.
- Search input pattern implemented three ways (4e).
- Two alert definitions disagree across nav and Ops (4f).
- Lines/instances vocabulary split forces re-mapping at every page boundary (3.3).

### 5.5 IA gaps inherited from gap-analysis.html — still open

See 6.5 table below for full reconciliation; the open ones are: instance **Group concept**, **rule engine**, fully **unified cross-instance inbox**, and **budget-vs-consumption tracking**.

## 6.5 gap-analysis.html reconciliation

Baseline: `docs/console-mockups/gap-analysis.html` ("What the GUI Needs That Does NOT Exist Yet", rows at lines 126-186).

| v2 gap (evidence) | Status in current console | Evidence |
|---|---|---|
| Centralized web server (`docs/console-mockups/gap-analysis.html:127-129`) | **Addressed** — the console SPA + `/api/*` fleet endpoints exist | `console/src/main.tsx:19-31`, `console/src/lib/api.ts` usage throughout, e.g. `console/src/pages/SoupKitchen.tsx:68-69` |
| Aggregated fleet view (`:132-134`) | **Addressed** — `useLines()` powers the fleet table/KPIs | `console/src/pages/SoupKitchen.tsx:68,215-531` |
| WebSocket real-time events (`:137-139`) | **Addressed** — invalidation-first WS with ticket auth + polling fallback | `console/src/hooks/use-websocket.tsx:44-132` |
| Heartbeat history (`:142-144`) | **Addressed in UI** — `line.heartbeat` rendered as 20-bar strip; padding masks short history (4f). Server-side snapshot storage **Inconclusive** from console code | `console/src/components/HeartbeatStrip.tsx:17-40`, `console/src/pages/LineDetail.tsx:185` |
| Group concept — a grouping layer *above instances* (`:147-149`) | **Open** — the shipped "Groups" tab is WhatsApp groups, not instance grouping; the closest construct is derived status tags, not operator-defined groups | `console/src/components/line-detail/GroupsTab.tsx:11-23` vs `console/src/components/LineTags.tsx:16-50` |
| Cross-instance message inbox (`:152-154`) | **Partial** — Inbox exists but is strictly one-line-at-a-time via LinePicker; no unified multi-line view or cross-line unread roll-up beyond the nav badge | `console/src/pages/Inbox.tsx:86-88,225-230`, `console/src/App.tsx:30` |
| Activity feed / event log (`:157-159`) | **Addressed** — typed feed with filters, pause, quick actions | `console/src/components/ActivityFeed.tsx:49-219` |
| Rule engine (`:162-164`) | **Open** — no rule/automation UI anywhere in `console/src` (grep for rule-engine vocabulary returns nothing); scheduled messages are the only automation surface | `console/src/components/line-detail/ScheduledTab.tsx` (closest feature) |
| Metrics aggregation (`:167-169`) | **Addressed** — fleet metrics with ranges, per-provider token/session charts, sparklines | `console/src/pages/SoupKitchen.tsx:100-108,280-365` |
| Config editing via GUI (`:172-174`) | **Addressed** — ConfigEditDialog + `api.updateConfig`, mode switch with restart | `console/src/pages/LineDetail.tsx:344-351`, `console/src/components/line-detail/ModeSwitchDialog.tsx:36-37` |
| Agent budget tracking (`:177-179`) | **Partial** — tokenBudget is configurable (wizard) and cumulative token usage is displayed, but no budget-vs-spend comparison or per-session burn-down exists in any view | `console/src/components/wizard/ConfigStep.tsx:157,749-750`, `console/src/pages/SoupKitchen.tsx:483-487`, `console/src/components/line-detail/SummaryTab.tsx:66-68` |
| QR auth flow via GUI (`:182-184`) | **Addressed** — SSE QR in wizard + RelinkModal reuse | `console/src/components/wizard/LinkStep.tsx:27-106`, `console/src/components/RelinkModal.tsx:51` |

Score: 8 of 12 v2 gaps addressed, 2 partial (cross-instance inbox, budget tracking), 2 open (instance grouping, rule engine).

---

## Appendix: Priority shortlist for v3

1. **Per-action confirmation policy** — restart confirmed in 1 of 4 entry points, block-contact in 1 of 2, scheduled-message delete never (4h).
2. **Wire or remove dead affordances** — Cmd+K, nav alert count, AlertBanner chips, unknown-line skeleton (5.2).
3. **One conversation view** — merge Inbox center pane and HistoryTab (5.4).
4. **Fix Escape stacking** in modal-over-modal (GroupDetailModal + ConfirmDialog) (4j).
5. **Persist or URL-encode fleet filters** so drill-down round trips do not destroy triage state (4a).
6. **Vocabulary decision**: lines vs instances; Soup Kitchen naming; remaining "WhatSoup" user-visible strings including the generated CLAUDE.md template (3.3-3.5).
