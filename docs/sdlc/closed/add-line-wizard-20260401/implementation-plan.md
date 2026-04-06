# Add Line Wizard — Implementation Plan

## Wave 1: Infrastructure + Shared Components (Parallel)

### B01: POST /api/lines — Instance Creation Endpoint
**Files:** `src/fleet/routes/ops.ts`, `src/fleet/index.ts`

1. Add `handleCreateLine` to ops.ts:
   - Parse JSON body with all config fields from spec
   - Validate: name slug format (`/^[a-z0-9-]+$/`), uniqueness (check discovery), type, adminPhones, type-specific rules (mirror instance-loader.ts:80-183)
   - Auto-assign healthPort (scan existing configs, start from 9095)
   - Write `~/.config/whatsoup/instances/<name>/config.json`
   - Write `~/.config/whatsoup/instances/<name>/tokens.env` (copy shared health token)
   - Create dirs: `~/.local/share/whatsoup/instances/<name>/logs`, `media`
   - Create dirs: `~/.local/state/whatsoup/instances/<name>/`
   - Write CLAUDE.md to agent CWD if provided
   - `execFile('systemctl', ['--user', 'enable', 'whatsoup@<name>'])` — enable but don't start (wait for auth)
   - Re-scan discovery to pick up new instance
   - Return 201 `{ name, healthPort }`
2. Register route: `{ method: 'POST', path: /^\/api\/lines$/, handler: 'createLine' }`

### B03: GET /api/lines/:name/exists — Name Check
**Files:** `src/fleet/routes/data.ts`, `src/fleet/index.ts`

1. Add `handleCheckExists` — returns `{ exists: boolean }` by checking discovery + filesystem
2. Register route: `{ method: 'GET', path: /^\/api\/lines\/(?<name>[^/]+)\/exists$/, handler: 'checkExists' }`

### B04: AddLineButton
**Files:** `console/src/index.css`, `console/src/pages/SoupKitchen.tsx`

1. Add `.c-btn-add` CSS class — mirrors `.c-btn-send` pattern (green bg, compact +, expands to "+ Add Line" on hover)
2. Add `Plus` import from lucide-react in SoupKitchen.tsx
3. Insert button after search input div (line ~292), before closing toolbar div
4. Button opens wizard modal: `const [showAddWizard, setShowAddWizard] = useState(false)`

### B05: WizardShell + Stepper + Navigation
**Files:** `console/src/components/AddLineWizard.tsx` (new)

1. Full-screen modal overlay using existing pattern (ConfirmDialog as reference)
2. Stepper component: 5 labeled dots (Identity, Model, Config, Review, Link). Current = green, completed = checkmark, upcoming = muted.
3. Content area with AnimatePresence for step transitions (same motion pattern as LineDetail tabs)
4. Footer: Back / Next / Cancel buttons. "Skip with Defaults" variant for Next on optional steps.
5. Wizard state: `currentStep`, `formData` object accumulating across phases
6. Export as default component, import in SoupKitchen

### B11: TagInput Component
**Files:** `console/src/components/TagInput.tsx` (new)

1. Text input + Enter to add tag, tags rendered as pills with X remove button
2. Uses FilterPill-like styling for tags
3. Props: `values: string[]`, `onChange: (values: string[]) => void`, `placeholder: string`
4. Validation callback prop for input (e.g., phone number format)

### B12: CardSelector Component
**Files:** `console/src/components/CardSelector.tsx` (new)

1. Row of clickable cards, one selected at a time
2. Each card: icon, title, description, mode-color border when selected
3. Props: `options: { value, label, description, icon, color }[]`, `selected`, `onChange`

### B13: CollapsibleSection Component
**Files:** `console/src/components/CollapsibleSection.tsx` (new)

1. Header with title + chevron (rotates on expand)
2. framer-motion for expand/collapse animation
3. Props: `title: string`, `defaultOpen?: boolean`, `children: ReactNode`

---

## Wave 2: Wizard Phase Forms (After Wave 1)

### B06: IdentityStep
**Files:** `console/src/components/wizard/IdentityStep.tsx` (new)

1. Name input with live slug preview + debounced uniqueness check via `api.checkExists(name)`
2. Description text input
3. Type CardSelector with 3 options (passive/chat/agent), mode colors
4. Admin phones TagInput
5. Props: `data`, `onChange`, `errors`

### B07: ModelAuthStep
**Files:** `console/src/components/wizard/ModelAuthStep.tsx` (new)

1. Conditional on `data.type`:
   - Passive: green check + auto-advance message
   - Chat: model dropdowns (4 roles) + API key password input
   - Agent: model dropdowns + auth method toggle (API key vs Claude session)
2. Model options: hardcoded known set (claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5, gpt-4.1, etc.)

### B08: ConfigStep
**Files:** `console/src/components/wizard/ConfigStep.tsx` (new)

1. CollapsibleSection for each config group:
   - Access (open by default): access mode CardSelector + admin phones TagInput
   - Behavior: system prompt textarea + CLAUDE.md file upload/editor
   - Permissions (agent only): checkbox lists for MCP/plugins/skills/tools
   - Sandbox (agent only): CWD + paths TagInput
   - Limits: number inputs (rate limit, max tokens, token budget)
   - RAG: Pinecone config fields
2. "Use Defaults & Continue" button skips entire step

---

## Wave 3: Integration (After Wave 2)

### B02: GET /api/lines/:name/auth — SSE QR Stream
**Files:** `src/fleet/routes/ops.ts`, `src/fleet/index.ts`

1. Add `handleAuth` — SSE endpoint:
   - Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
   - Spawn `node --experimental-strip-types src/bootstrap-auth.ts <name>` as child process
   - Parse stderr line by line. Detect QR strings (Baileys outputs them after "Scan the QR code")
   - Actually: the raw `qr` value comes from `connection.update` event. The auth.ts script calls `qrcodeTerminal.generate(qr)`. We need to capture the RAW qr string before it goes to qrcode-terminal. **Alternative:** modify auth.ts to also write raw QR to stdout as JSON: `console.log(JSON.stringify({ event: 'qr', data: qr }))`
   - Stream SSE events: `event: qr`, `event: connected`, `event: error`
   - On connected: `execFile('systemctl', ['--user', 'start', 'whatsoup@<name>'])`, re-scan discovery
   - On client disconnect (`req.on('close')`): kill child process
2. Register route as GET

### B09: ReviewStep
**Files:** `console/src/components/wizard/ReviewStep.tsx` (new)

1. Summary cards grouped by phase, showing key config values
2. Edit button per section → `onEditPhase(phaseNumber)` callback to wizard shell
3. "Create Line" button → calls `api.createLine(formData)`, advances to Link step on success

### B10: LinkStep + QR Display
**Files:** `console/src/components/wizard/LinkStep.tsx` (new), `console/src/components/QrDisplay.tsx` (new)

1. Install `qrcode` npm package in console
2. QrDisplay component: renders QR string to canvas/SVG via qrcode library
3. LinkStep: connects to SSE endpoint (`new EventSource(/api/lines/<name>/auth)`)
4. States: waiting (show QR) → linking (spinner) → connected (success + link to detail page) → error (retry button)
5. Cleanup: close EventSource on unmount

### API Client Updates
**Files:** `console/src/lib/api.ts`

Add:
```
createLine: (config) => apiFetch('/api/lines', { method: 'POST', body: JSON.stringify(config) })
checkExists: (name) => apiFetch(`/api/lines/${name}/exists`)
```

---

## Wave 4: Verification

### B14: Integration Verification
1. tsc --noEmit, eslint, vite build
2. Visual verification in browser: full wizard flow
3. Code review agent
4. Push to origin/main

---

## Execution Plan

```
Wave 1: 4 parallel agents
  Agent A: B01 (create endpoint) + B03 (exists check)
  Agent B: B04 (add button) + B05 (wizard shell)
  Agent C: B11 (tag input) + B12 (card selector) + B13 (collapsible section)
  Agent D: API client updates

Wave 2: 3 parallel agents (after Wave 1)
  Agent E: B06 (identity step)
  Agent F: B07 (model/auth step)
  Agent G: B08 (config step)

Wave 3: 2 parallel agents (after Wave 2)
  Agent H: B02 (SSE auth) + B09 (review step)
  Agent I: B10 (link step + QR display)

Wave 4: Verification
  Agent J: Code review
  Final: tsc + eslint + build + push
```
