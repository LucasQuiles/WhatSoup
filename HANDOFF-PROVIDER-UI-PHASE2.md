# Handoff: Provider UI — Phase 2 (Detail Pages & Dashboard Polish)

**From:** L (lab agent) — frontend provider selection (Phase 1)
**To:** Frontend agent — detail pages, dashboard integration, health endpoint
**Date:** 2026-04-04
**Branch:** `main` (pushed, 9 commits since `3d20d5f`)

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

**Note:** `LineTags` is already used in `SoupKitchen.tsx:406` (the table view). LineDetail and Ops.tsx are missing it.

---

### Task 2: Add LineTags to Ops.tsx Instance Cards

**File:** `console/src/pages/Ops.tsx`, around line 147

Currently the Ops fleet dashboard cards show:
```
[●] instance-name  [agent]    +1234567890
[heartbeat] [runtime stats]
```

Add LineTags after ModeBadge in the first row (line 147):

**Current code:**
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

**Current `cards` array** (line 907):
```typescript
const cards = [
  { label: 'STATUS',   value: line.status, color: '...' },
  { label: 'UPTIME',   value: line.uptime ?? '—', color: 'text-t1' },
  { label: 'MESSAGES', value: (line.messagesToday ?? 0).toLocaleString(), color: 'text-t1' },
  { label: 'MODE',     value: line.mode, color: '...' },
  { label: 'ACCESS',   value: line.accessMode ?? '—', color: 'text-t2' },
  { label: 'ACTIVE',   value: line.lastActive ? formatRelative(line.lastActive) : '—', color: 'text-t3' },
]
```

**Change to:**
```typescript
const provider = (line.config?.agentOptions as Record<string, unknown> | undefined)?.provider as string | undefined
const providerDisplay = line.mode === 'agent' && provider
  ? (getProvider(provider)?.displayName ?? provider)
  : line.mode

const cards = [
  { label: 'STATUS',   value: line.status, color: '...' },
  { label: 'UPTIME',   value: line.uptime ?? '—', color: 'text-t1' },
  { label: 'MESSAGES', value: (line.messagesToday ?? 0).toLocaleString(), color: 'text-t1' },
  { label: line.mode === 'agent' ? 'PROVIDER' : 'MODE', value: providerDisplay, color: '...' },
  { label: 'ACCESS',   value: line.accessMode ?? '—', color: 'text-t2' },
  { label: 'ACTIVE',   value: line.lastActive ? formatRelative(line.lastActive) : '—', color: 'text-t3' },
]
```

Add import: `import { getProvider } from '../lib/providers'`

For non-agent instances, the card stays as `MODE` with the mode value. For agent instances with the default provider, it shows `PROVIDER: Claude Code`. For non-default providers, it shows the display name.

---

### Task 4: Add Provider Row to LineDetail Config Panel

**File:** `console/src/pages/LineDetail.tsx`, lines 1007–1048

The config panel calls `buildConfigEntries(rawConfig)` which flattens the raw config into key-value rows. `agentOptions` appears as a JSON blob like `{"cwd":"/home/q/agents/bot","sessionScope":"per_chat",...}`.

Add a prominent provider row **above** the flat config entries, for agent instances only:

**Before the `{config.map(...)}` block** (line 1034), insert:

```tsx
{line.mode === 'agent' && (
  <div className="flex items-center justify-between" style={{ padding: '6px 0', borderBottom: 'var(--bw) solid var(--b1)' }}>
    <span className="c-label">provider</span>
    <span className="font-mono" style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-m-agt)' }}>
      {(getProvider(
        ((rawConfig.agentOptions as Record<string, unknown> | undefined)?.provider as string) ?? DEFAULT_PROVIDER_ID
      )?.displayName) ?? DEFAULT_PROVIDER_ID}
    </span>
  </div>
)}
```

Add import: `import { getProvider, DEFAULT_PROVIDER_ID } from '../lib/providers'`

This surfaces the provider prominently at the top of the config panel instead of burying it inside a JSON blob.

---

### Task 5: Add Provider to Health Endpoint (Backend)

**File:** `src/health-server.ts` (or equivalent health endpoint handler)

The health endpoint currently returns:
```json
{
  "status": "healthy",
  "instance": { "name": "besbot", "mode": "agent" }
}
```

Add the active provider to the instance block:
```json
{
  "status": "healthy",
  "instance": { "name": "besbot", "mode": "agent", "provider": "codex-cli" }
}
```

This requires reading `config.agentProvider` (already exported from `src/config.ts:230`) and including it in the health response.

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

This allows the dashboard to distinguish the *configured* provider (from `line.config.agentOptions.provider`) from the *running* provider (from `line.health.instance.provider`), which is useful when a provider change has been saved but the instance hasn't been restarted yet.

---

### Task 6: Show Config vs Running Provider Mismatch

**File:** `console/src/components/LineTags.tsx`

Once the health endpoint includes `provider` (Task 5), add a mismatch warning tag when the configured provider differs from the running provider:

```typescript
function getProviderMismatchTag(line: LineInstance): TagDef | null {
  if (line.mode !== 'agent') return null
  const configProvider = (line.config?.agentOptions as Record<string, unknown> | undefined)?.provider as string | undefined
  const runningProvider = line.health?.instance?.provider
  if (!configProvider || !runningProvider) return null
  if (configProvider === runningProvider) return null
  return { label: 'restart needed', icon: AlertTriangle, color: 'var(--color-s-warn)', bg: 'var(--s-warn-wash)' }
}
```

Add to the `LineTags` component body and import `AlertTriangle` from lucide-react.

This surfaces the "restart needed" state directly in the dashboard and detail views without the user needing to open the edit modal.

---

## Files to Read First

| File | What's There | Lines of Interest |
|------|-------------|-------------------|
| `console/src/lib/providers.ts` | All provider constants and helpers | Full file (75 lines) |
| `console/src/components/LineTags.tsx` | Existing provider badge implementation | Lines 39–44 (`getProviderTag`) |
| `console/src/pages/LineDetail.tsx` | Main detail page — header, KPI, config panel | 174–184 (header), 907–913 (KPIs), 1007–1048 (config panel) |
| `console/src/pages/Ops.tsx` | Fleet dashboard cards | 140–150 (instance cards) |
| `console/src/pages/SoupKitchen.tsx` | Table view — already uses LineTags | 406 (LineTags usage) |
| `console/src/types.ts` | LineInstance + health types | 32–37 (health.instance) |
| `src/config.ts` | Backend config exports | 230–231 (`agentProvider`, `agentProviderConfig`) |

## API Surface

No new endpoints needed. The only backend change is Task 5 — adding `provider` to the existing health response.

Existing endpoints that return config (already include provider data):
- `GET /api/lines/:name` → `line.config.agentOptions.provider`
- `PATCH /api/lines/:name/config` → accepts `agentOptions.provider` + `agentOptions.providerConfig`
- `GET /health` (per-instance health port) → needs `instance.provider` added

## Design Decisions Already Made (Don't Revisit)

1. **`DEFAULT_PROVIDER_ID` is the single source of truth** for the default provider string — never hardcode `'claude-cli'`
2. **Provider badge hidden for default provider** — only non-default shows a badge
3. **Provider badge shows display name** not raw ID (e.g., "Codex CLI" not "codex-cli")
4. **Restart notice lives in EditConfigModal**, not ConfigStep — ConfigStep doesn't know its hosting context
5. **`getProviderConfigFields()` results are cached** and return stable references — safe to call in render without useMemo in simple cases, but use useMemo in keystroke-hot paths

## Test Coverage

- 57 console tests (9 unit + 48 wiring) — all pass
- 3114 full regression tests — all pass
- Provider badge logic tested: default hidden, non-agent hidden, display name resolution
- Config field generation tested per provider
- State handler no-op guards tested

## Complexity Estimate

| Task | Effort | Risk |
|------|--------|------|
| 1. LineTags in LineDetail header | Trivial — 2 lines | None |
| 2. LineTags in Ops cards | Trivial — 2 lines | None |
| 3. Provider KPI card | Small — 10 lines | Low — conditional label/value |
| 4. Provider config panel row | Small — 10 lines | Low — follows existing pattern |
| 5. Health endpoint + type | Small — 5 lines backend + 1 line type | Low — additive |
| 6. Provider mismatch tag | Medium — 15 lines | Medium — depends on Task 5 |

Tasks 1–4 are independent and can be done in parallel. Task 6 depends on Task 5.
