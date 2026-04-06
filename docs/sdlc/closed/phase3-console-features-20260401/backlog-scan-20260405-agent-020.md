# Backlog Scan: Phase 3 Console Features

Date: 2026-04-05
Agent task: `020`
Scope: reviewed `state.md`, `implementation-plan.md`, `console/src/**`, plus backend sanity checks in `src/fleet/**` where frontend behavior depends on payload fields or routes.

## Conclusion

The SDLC state file still shows all 10 beads as pending, but the codebase does not. Current status is:

- DONE: B08, B09, B10
- PARTIAL: B01, B02, B03, B04, B05, B06
- PENDING: B07

## Bead Status

| Bead | Status | Evidence | Notes |
| --- | --- | --- | --- |
| B01 Inline image thumbnails | PARTIAL | `console/src/components/MessageContent.tsx:58-79`, `console/src/types.ts:80-89`, `src/fleet/db-reader.ts:160-175`, `src/fleet/routes/data.ts:170-194` | Thumbnail rendering exists and `rawMessage` is plumbed end to end, but the planned click-to-open-full-image behavior is not implemented. |
| B02 Audio message indicator | PARTIAL | `console/src/components/MessageContent.tsx:82-100` | Audio metadata parsing, PTT detection, and `M:SS` display exist. Planned waveform placeholder and shared `formatDuration()` helper are missing. |
| B03 Document file card | PARTIAL | `console/src/components/MessageContent.tsx:102-124` | Document parsing and basic filename/size display exist. Planned caption rendering, extension badge styling, and token-colored extension treatment are missing. `formatBytes()` was added locally instead of in `text-utils.ts`. |
| B04 Video thumbnail | PARTIAL | `console/src/components/MessageContent.tsx:126-171` | Film icon, thumbnail extraction, duration/GIF badge are present. Planned centered play overlay is missing. |
| B05 Cursor pagination | PARTIAL | `console/src/lib/api.ts:96-100`, `console/src/pages/LineDetail.tsx:1491-1518`, `console/src/pages/LineDetail.tsx:1580-1604`, `src/fleet/routes/data.ts:170-177` | Load-older flow is wired and uses `before_pk`. Missing pieces from plan: no hook-level pagination state in `useMessages`, no explicit scroll preservation after prepending, and end-of-list detection is only `older.length === 0` rather than the planned short-page cutoff. |
| B06 Contact management | PARTIAL | `console/src/components/MessageBubble.tsx:124-137`, `console/src/pages/LineDetail.tsx:1609-1615`, search for `toolCall|SaveContactDialog` in `console/src` and `src/fleet` returned no implementation hits | UI affordance exists: incoming raw-JID messages show a save-contact icon. Actual contact save flow is still placeholder-only via toast; no dialog, no `api.toolCall()`, and no backend tool-proxy route were found. |
| B07 Message search | PENDING | `console/src/hooks/use-fleet.ts:40-47`, `console/src/pages/LineDetail.tsx:1692-1747`, search for `searchMessages|useSearch|<mark>` in `console/src` and `src/fleet` returned no implementation hits | No search input, no search hook, no result replacement UI, no highlight rendering, and no backend search endpoint were found. |
| B08 Config editor | DONE | `console/src/pages/LineDetail.tsx:402-771`, `console/src/lib/api.ts:141-146`, `console/src/pages/LineDetail.tsx:1030-1039`, `console/src/pages/LineDetail.tsx:1093-1100`, `console/src/pages/LineDetail.tsx:1171-1177` | Config editor dialog is implemented, type-aware, save is wired to `PATCH /config`, warning banner exists, and the feature is wired from the line detail UI. Minor deviation: `adminPhones` is still editable instead of excluded. |
| B09 Mode switching | DONE | `console/src/pages/LineDetail.tsx:774-900`, `console/src/pages/LineDetail.tsx:1102-1108`, `console/src/lib/api.ts:120-146` | Mode switch dialog with three options, descriptions, restart warning, config patch, restart call, and UI wiring is implemented. |
| B10 Stop instance | DONE | `console/src/lib/api.ts:123-124`, `console/src/pages/LineDetail.tsx:1110-1116`, `console/src/pages/LineDetail.tsx:1147-1168`, `src/fleet/routes/ops.ts:97-136`, `src/fleet/index.ts:60-62`, `src/fleet/index.ts:120-122` | Stop action is fully wired in both console and backend, with confirm dialog and API route. |

## Summary

The plan has materially progressed past the state file:

- Rich media support landed in a simplified form.
- Pagination landed in a workable but not plan-complete form.
- Contact management is still a placeholder workflow.
- Message search does not appear to have started.
- Instance operations are mostly complete, especially config edit, mode switch, and stop.
