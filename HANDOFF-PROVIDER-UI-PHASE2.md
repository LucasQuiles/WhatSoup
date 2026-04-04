# Handoff: Provider UI — Phase 2 (Detail Pages & Dashboard Polish)

**From:** L (lab agent) — frontend provider selection (Phase 1)
**To:** Frontend agent — detail pages, dashboard integration, health endpoint
**Date:** 2026-04-04
**Branch:** `main` (pushed, 9 commits since `3d20d5f`)
**Reviewed by:** Oracle council (adversarial auditor, behavioral prover, completeness auditor)

## What Phase 1 Built

Provider selection is fully wired in the **wizard** and **edit modal**:

| Component | File | What's There |
|-----------|------|-------------|
| Provider constants | `console/src/lib/providers.ts` | `PROVIDERS` array, `DEFAULT_PROVIDER_ID`, `getProvider()`, `getProviderConfigFields()` — all with O(1) lookups via precomputed Maps |
| Wizard ConfigStep | `console/src/components/wizard/ConfigStep.tsx` | Provider dropdown + dynamic config fields in Permissions tab |
| Wizard ReviewStep | `console/src/components/wizard/ReviewStep.tsx` | Provider + all config fields shown before creation |
| Wizard formData | `console/src/components/AddLineWizard.tsx` | `provider: DEFAULT_PROVIDER_ID` + `providerConfig: {}` in defaults |
| Edit modal | `console/src/components/EditConfigModal.tsx` | Delegates to ConfigStep (provider UI works), restart notice banner for non-default providers |
| Provider badge | `console/src/components/LineTags.tsx` | `getProviderTag()` returns display-name badge for non-default agent providers |

### Key Imports Available

```typescript
// From console/src/lib/providers.ts:
import { PROVIDERS, DEFAULT_PROVIDER_ID, getProvider, getProviderConfigFields } from '../lib/providers'
import type { ProviderDef, ConfigFieldDef } from '../lib/providers'

// DEFAULT_PROVIDER_ID = 'claude-cli'
// PROVIDERS = [{id, displayName, type: 'cli'|'api'}, ...]
// getProvider(id) → ProviderDef | undefined  (O(1) Map lookup)
// getProviderConfigFields(id) → ConfigFieldDef[]  (cached, stable references)
```

### Existing Provider Badge (LineTags.tsx)

```typescript
// Already implemented — returns null for claude-cli (default) and non-agent modes
function getProviderTag(line: LineInstance): TagDef | null
```

---

## What Phase 2 Needs to Do

### Task 1: Add LineTags to LineDetail Header

**File:** `console/src/pages/LineDetail.tsx`, lines 174–184

Currently the header shows:
```
[●] instance-name  [agent]
    +1234567890
```

Add `LineTags` after the ModeBadge so it shows:
```
[●] instance-name  [agent]  [Codex CLI] [sandbox]
    +1234567890
```

**Current code** (line 179):
```tsx
<ModeBadge mode={line.mode} />
```

**Change to:**
```tsx
<ModeBadge mode={line.mode} />
<LineTags line={line} />
```

Add import: `import LineTags from '../components/LineTags'`

**Note:** `LineTags` is already used in `SoupKitchen.tsx:406` (the table view). LineDetail and Ops.tsx are the two surfaces missing it.

---

### Task 2: Add LineTags to Ops.tsx Instance Cards

**File:** `console/src/pages/Ops.tsx`, line 147

Currently the Ops fleet dashboard cards show:
```
[●] instance-name  [agent]    +1234567890
[heartbeat] [runtime stats]
```

Add LineTags after ModeBadge in the first row (line 147):

**Current code** (line 147):
```tsx
<ModeBadge mode={line.mode} />
```

**Change to:**
```tsx
<ModeBadge mode={line.mode} />
<LineTags line={line} />
```

Add import: `import LineTags from '../components/LineTags'`

---

### Task 3: Add Provider to LineDetail KPI Cards

**File:** `console/src/pages/LineDetail.tsx`, lines 907–913

The Summary tab has a 6-card KPI row. For agent instances, replace the generic `MODE` card with a `PROVIDER` card that shows the active provider, since mode is already visible in the header badge.

**Current `cards` array** (lines 907–914, inside `SummaryTab` function):
```typescript
const cards = [
  { label: 'STATUS', value: line.status, color: line.status === 'online' ? 'text-s-ok' : line.status === 'degraded' ? 'text-s-warn' : 'text-s-crit' },
  { label: 'UPTIME', value: line.uptime ?? '—', color: 'text-t1' },
  { label: 'MESSAGES', value: (line.messagesToday ?? 0).toLocaleString(), color: 'text-t1' },
  { label: 'MODE', value: line.mode, color: line.mode === 'passive' ? 'text-m-pas' : line.mode === 'chat' ? 'text-m-cht' : 'text-m-agt' },
  { label: 'ACCESS', value: line.accessMode ?? '—', color: 'text-t2' },
  { label: 'ACTIVE', value: line.lastActive ? formatRelative(line.lastActive) : '—', color: 'text-t3' },
]
```

**Change to** (add provider extraction above, replace MODE card):
```typescript
const provider = (line.config?.agentOptions as Record<string, unknown> | undefined)?.provider as string | undefined
const providerDisplay = line.mode === 'agent' && provider
  ? (getProvider(provider)?.displayName ?? provider)
  : line.mode

const cards = [
  { label: 'STATUS', value: line.status, color: line.status === 'online' ? 'text-s-ok' : line.status === 'degraded' ? 'text-s-warn' : 'text-s-crit' },
  { label: 'UPTIME', value: line.uptime ?? '—', color: 'text-t1' },
  { label: 'MESSAGES', value: (line.messagesToday ?? 0).toLocaleString(), color: 'text-t1' },
  { label: line.mode === 'agent' ? 'PROVIDER' : 'MODE', value: providerDisplay, color: line.mode === 'passive' ? 'text-m-pas' : line.mode === 'chat' ? 'text-m-cht' : 'text-m-agt' },
  { label: 'ACCESS', value: line.accessMode ?? '—', color: 'text-t2' },
  { label: 'ACTIVE', value: line.lastActive ? formatRelative(line.lastActive) : '—', color: 'text-t3' },
]
```

Add import: `import { getProvider } from '../lib/providers'`

**Behavior by mode:**
- `passive` / `chat` → card shows `MODE` label with mode value, mode color
- `agent` with default provider → card shows `PROVIDER: Claude Code`, agent color
- `agent` with non-default → card shows `PROVIDER: Codex CLI` (etc.), agent color
- `agent` with unknown provider ID → card shows `PROVIDER: <raw-id>` (fallback via `?? provider`)

---

### Task 4: Add Provider Row to LineDetail Config Panel

**File:** `console/src/pages/LineDetail.tsx`, lines 1034–1042

The config panel calls `buildConfigEntries(rawConfig)` (line 942) which flattens the raw config into key-value rows. `agentOptions` appears as a JSON blob. The variable `rawConfig` is defined at line 941: `const rawConfig = line.config ?? {}` — it is in scope at the insertion point.

Add a prominent provider row **inside** the config entries panel, for agent instances only. The insertion point is at line 1036, just before `{config.map((entry, i) => (` and inside the `{config ? (` truthy branch that opens at line 1034.

**Insert between lines 1035 and 1036** (after `<div style={{ padding: 'var(--sp-3) var(--sp-4)' }}>`, before `{config.map(...)}` ):

```tsx
{line.mode === 'agent' && (
  <div className="flex items-center justify-between" style={{ padding: '6px 0', borderBottom: 'var(--bw) solid var(--b1)' }}>
    <span className="c-label">provider</span>
    <span className="font-mono" style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-m-agt)' }}>
      {getProvider(
        ((rawConfig.agentOptions as Record<string, unknown> | undefined)?.provider as string) ?? DEFAULT_PROVIDER_ID
      )?.displayName ?? DEFAULT_PROVIDER_ID}
    </span>
  </div>
)}
```

Add import: `import { getProvider, DEFAULT_PROVIDER_ID } from '../lib/providers'`

**Note on unknown provider IDs:** If the provider ID is not in the PROVIDERS list, `getProvider()` returns `undefined` and the display falls back to `DEFAULT_PROVIDER_ID`. This matches the safe default behavior — an unrecognized provider shows as "claude-cli" rather than a raw unknown string. This is intentionally different from Task 3's fallback (which shows the raw ID) because the config panel is a system-facing surface where showing the default is safer than showing an unvalidated string.

---

### Task 5: Add Provider to Health Endpoint (Backend)

**File:** `src/core/health.ts` — function `startHealthServer()`, response body at line 342

The `config` object is already imported at line 3: `import { config } from '../config.ts'`

The health endpoint currently returns (lines 342–372):
```json
{
  "status": "healthy|degraded|unhealthy",
  "uptime_seconds": 12345,
  "instance": {
    "name": "besbot",
    "mode": "agent",
    "accessMode": "self_only"
  },
  "whatsapp": { "connected": true, "account_jid": "..." },
  "sqlite": { "messages_total": 500, "unprocessed": 0 },
  "access_control": { "pending_count": 0 },
  "enrichment": { "last_run": "..." },
  "models": { "conversation": "...", "extraction": "...", ... },
  "durability": { ... },
  "runtime": { ... }
}
```

**Add `provider` to the `instance` block** at line 346–349:

```typescript
instance: {
  name: deps.instanceName,
  mode: deps.instanceType,
  accessMode: deps.accessMode,
  provider: config.agentProvider,  // ← ADD THIS (exported from config.ts:230)
},
```

`config.agentProvider` is already available in scope (imported at line 3) and defaults to `'claude-cli'` when not configured. No changes to `HealthDeps` interface are needed — the provider comes from the global config singleton, not from the deps parameter.

**Also update the frontend type** in `console/src/types.ts`, lines 32–37:

```typescript
instance?: {
  name: string;
  mode: Mode;
  accessMode: string;
  socketPath: string | null;
  provider?: string;  // ← ADD THIS
};
```

This allows the dashboard to distinguish the *configured* provider (from `line.config.agentOptions.provider`) from the *running* provider (from `line.health.instance.provider`), which matters when a provider change has been saved but not yet restarted.

---

### Task 6: Show Config vs Running Provider Mismatch

**File:** `console/src/components/LineTags.tsx`

**Depends on Task 5** — the health endpoint must return `provider` first.

Once the health endpoint includes `provider`, add a mismatch warning tag when the configured provider differs from the running provider.

**Add this function** after the existing `getProviderTag` function (module-level, not inside the component):

```typescript
function getProviderMismatchTag(line: LineInstance): TagDef | null {
  if (line.mode !== 'agent') return null
  const configProvider = (line.config?.agentOptions as Record<string, unknown> | undefined)?.provider as string | undefined
  const runningProvider = line.health?.instance?.provider
  // Skip if either is missing (health fetch failed, or legacy instance without provider)
  if (!configProvider || !runningProvider) return null
  if (configProvider === runningProvider) return null
  return { label: 'restart needed', icon: AlertTriangle, color: 'var(--color-s-warn)', bg: 'var(--s-warn-wash)' }
}
```

**Add `AlertTriangle` to the existing lucide-react import** on line 2:
```typescript
import { Shield, ShieldAlert, ShieldOff, Lock, Cpu, Layers, AlertTriangle } from 'lucide-react'
```

**Add the tag to the component body** (after the existing `providerTag` push):
```typescript
const mismatchTag = getProviderMismatchTag(line)
if (mismatchTag) tags.push(mismatchTag)
```

**Edge cases handled:**
- `line.health === null` (health fetch error) → `line.health?.instance?.provider` is `undefined` → early return, no tag
- Legacy instance without provider in config → `configProvider` is `undefined` → early return, no tag
- Provider changed but not yet restarted → mismatch detected → "restart needed" tag appears
- Provider matches → no tag

---

## Surfaces Evaluated and Intentionally Excluded

| Component | File | Why Excluded |
|-----------|------|-------------|
| `LinePicker.tsx` | `console/src/components/LinePicker.tsx` | Compact navigation dropdown — shows StatusDot + name + ModeBadge. Provider tags would clutter the dropdown. |
| `FeedCard.tsx` | `console/src/components/FeedCard.tsx` | Activity feed events — shows mode for styling but not instance details. Not a provider surface. |
| `Inbox.tsx` | `console/src/pages/Inbox.tsx` | Message inbox — reads lines but shows no instance-mode info. |

---

## Files to Read First

| File | What's There | Lines of Interest |
|------|-------------|-------------------|
| `console/src/lib/providers.ts` | All provider constants and helpers | Full file (75 lines) |
| `console/src/components/LineTags.tsx` | Existing provider badge + tag system | Lines 2 (imports), 39–44 (`getProviderTag`), 69–94 (component) |
| `console/src/pages/LineDetail.tsx` | Main detail page — header, KPI, config panel | 174–184 (header), 907–914 (KPIs), 941 (`rawConfig`), 1034–1042 (config panel) |
| `console/src/pages/Ops.tsx` | Fleet dashboard cards | 140–150 (instance cards) |
| `console/src/pages/SoupKitchen.tsx` | Table view — already uses LineTags | 406 (LineTags usage pattern) |
| `console/src/types.ts` | LineInstance + health types | 32–37 (`health.instance`) |
| `src/core/health.ts` | Backend health endpoint | 3 (config import), 16–29 (`HealthDeps`), 342–372 (response body) |
| `src/config.ts` | Backend config exports | 230–231 (`agentProvider`, `agentProviderConfig`) |

## API Surface

No new endpoints needed. The only backend change is Task 5 — adding `provider` to the existing health response.

Existing endpoints that return config (already include provider data):
- `GET /api/lines/:name` → `line.config.agentOptions.provider`
- `PATCH /api/lines/:name/config` → accepts `agentOptions.provider` + `agentOptions.providerConfig`
- `GET /health` (per-instance health port) → needs `instance.provider` added (Task 5)

## Design Decisions Already Made (Don't Revisit)

1. **`DEFAULT_PROVIDER_ID` is the single source of truth** for the default provider string — never hardcode `'claude-cli'`
2. **Provider badge hidden for default provider** — only non-default shows a badge
3. **Provider badge shows display name** not raw ID (e.g., "Codex CLI" not "codex-cli")
4. **Restart notice lives in EditConfigModal**, not ConfigStep — ConfigStep doesn't know its hosting context
5. **`getProviderConfigFields()` results are cached** and return stable references — safe to call in render without useMemo in simple cases, but use useMemo in keystroke-hot paths
6. **Unknown provider IDs:** `getProvider()` returns `undefined` for unknown IDs. Task 3 falls back to showing the raw ID string. Task 4 falls back to `DEFAULT_PROVIDER_ID`. This asymmetry is intentional — the KPI card is user-facing (show what's configured), the config panel is system-facing (show the safe default).

## Verification Plan

After implementing each task, run:

```bash
# Build check
cd /home/q/LAB/WhatSoup/console && npx vite build 2>&1 | tail -5
# Expected: ✓ built, exit 0

# Existing tests still pass
cd /home/q/LAB/WhatSoup && npx vitest run tests/console/ 2>&1 | tail -5
# Expected: 57 passed (57)

# Full regression
cd /home/q/LAB/WhatSoup && npx vitest run 2>&1 | tail -5
# Expected: 3114+ passed, 0 failed
```

**Manual verification** (run the console dev server):
- Tasks 1–2: Navigate to LineDetail and Ops pages with an agent instance configured with a non-default provider. Verify the provider badge appears next to the mode badge.
- Task 3: On LineDetail, verify the KPI card shows "PROVIDER" (not "MODE") for agent instances.
- Task 4: On LineDetail config panel, verify a "provider" row appears above the flat config entries.
- Task 5: Hit the instance health port directly (`curl http://localhost:<healthPort>/health | jq .instance`) and verify `provider` field is present.
- Task 6: Change an instance's provider via the edit modal without restarting. Verify a "restart needed" tag appears in all surfaces showing LineTags.

## Complexity Estimate

| Task | Effort | Risk |
|------|--------|------|
| 1. LineTags in LineDetail header | Trivial — 2 lines + import | None |
| 2. LineTags in Ops cards | Trivial — 2 lines + import | None |
| 3. Provider KPI card | Small — 10 lines | Low — conditional label/value |
| 4. Provider config panel row | Small — 10 lines | Low — follows existing pattern |
| 5. Health endpoint + type | Small — 1 line backend + 1 line type | Low — additive, `config` already in scope |
| 6. Provider mismatch tag | Medium — 15 lines | Medium — depends on Task 5, edge cases |

Tasks 1–4 are independent and can be done in parallel. Task 5 is independent of 1–4. Task 6 depends on Task 5 (both the backend change and the frontend type update).
