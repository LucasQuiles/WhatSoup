# 17 — Settings IA Spec (WS4.7)

Settings is a **form register** surface inside the operator chrome: global rail + section
nav + content column. Form register = airy rows, direct-edit controls, one danger area.

## 1. Information architecture

| Section | Contents | Control vocabulary |
|---|---|---|
| Workspace | workspace name (input) · admin identity (read-only) · appearance (3-swatch, synced to live theme) · export all data (neutral) · reduced motion (toggle) | input, swatch-select, toggle, sm button |
| Channels | per-channel link state + relink entry (IA reserve, R2-2) | link rows, state pills |
| Agent defaults | default brain + fallback chain, default grant level for new lines | selects, radio |
| Notifications | per-channel rules (browser push · webhook · email digest), attention-only vs all-events | toggles, edit buttons, fixed-width control zone |
| API tokens | token list (name · scopes · created) + rotate/revoke + dashed add row | sm ghost (rotate), danger-outline (revoke) |
| Danger zone | Reset workspace only — irreversible, crit frame, 2 confirmations | danger-outline + confirmation modal |

Rules: every nav item must resolve to a rendered section (wave-4b law — no phantom nav).
Danger zone contains **only irreversible actions**; safe operations (export) live as
neutral rows in their natural section (severity-semantics law).

## 2. Layout

Global rail (212px) → section nav (190px, accent-wash selection + inset bar) → content
column (max 1080px, 28px gutter). All sections compose at 1440×900 without dangling
content (wave-4 fit law); longer sections scroll internally, never the page.

## 3. Control states

| Control | States |
|---|---|
| Toggle | on = accent track + knob right; off = neutral track + inset hairline + knob left (both positions shape-visible) |
| Swatch select | selected = accent border + outer ring; unselected = hairline; labeled under each swatch |
| Input | inset fill, t1 text, focus = accent border (runtime state) |
| Read-only value | plain text, no field chrome (mutability is communicated by chrome, not color) |
| Destructive | crit outline family at rest (text + border), never filled-crit, never neutral |

## 4. Content rules

1. Section header + one-line desc per section (uniform pattern).
2. Metadata/helper copy is always mono t3, one demoted step below its row label.
3. Identifiers masked (mask law) — tokens show scope + created date, never the secret.
4. Trailing control slots track a single right column per panel (alignment law).
5. Appearance swatch selection follows the live theme (synced, not static).

## 5. Acceptance gate

- [ ] Nav items == rendered sections (1:1).
- [ ] Danger zone holds irreversibles only; export lives in Workspace as neutral.
- [ ] All rows compose at 1440×900 exactly (Chromium-measured).
- [ ] Toggles shape-visible in both states; destructive = crit-outline at rest.
- [ ] Swatch selection syncs with live theme; labels under every swatch.
