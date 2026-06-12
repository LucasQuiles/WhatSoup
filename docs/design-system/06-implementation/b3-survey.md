# B3 Pre-Investigation Survey — legacy dialog burn-down (Modal adoption)

Read-only codebase survey (2026-06-12) feeding the future B3 A0 packet. Modal primitive +
useDismissable exist (C2.2); ConfirmDialog and KeyboardShortcutsHelp are the migrated
precedents. Authoritative remaining inventory (grep role="dialog" + c-dialog-backdrop):
EIGHT sites — the register's seven named dialogs plus an inline Inbox SaveContact dialog.

## Dialog inventory

| Dialog | File (console/src/...) | LOC | Escape today | Sizing token | Structure fit | Nested confirms | Difficulty |
|---|---|---|---|---|---|---|---|
| SaveContact (inline) | `pages/Inbox.tsx` ~619–660 | ~42 | NONE (gap) | --panel-confirm | clean header/body/footer; extract to component first | no | easiest |
| RelinkModal | `components/RelinkModal.tsx` | 58 | own handler (non-stacking) | --panel-confirm | header + body only | no | easiest |
| CreateGroupModal | `components/line-detail/CreateGroupModal.tsx` | 151 | own handler | --panel-composer | c-dialog header/body/footer maps 1:1 | no | easy |
| ConfigEditDialog | `components/line-detail/ConfigEditDialog.tsx` | 336 | NONE (gap) | --panel-config-edit | c-dialog maps 1:1; dismissable=false (explicit Save/Cancel) | no | easy-moderate |
| ScheduleComposerModal | `components/line-detail/ScheduleComposerModal.tsx` | 380 | own handler | --panel-composer (95vw wide) | c-dialog maps 1:1; 5 field groups; consumes ChatPicker (B2 overlap) | no | moderate |
| UpdateModal | `components/UpdateModal.tsx` | 456 | own handler | --panel-confirm | 6-phase state machine; per-phase actions (no single footer) | no | moderate-hard |
| GroupDetailModal | `components/line-detail/GroupDetailModal.tsx` | 847 | own handler | --panel-wizard | shell migrable now; INTERNAL TABLIST → Tabs primitive (B1 delivered it); consumes ContactSearchPicker (B2 overlap) | yes (Leave/Revoke confirms — stacking already proven) | hard |
| AddLineWizard | `components/AddLineWizard.tsx` | 393 | NONE; role="dialog" sits on the BACKDROP (non-standard) | --panel-wizard + min/max-h | 5-step stepper + framer-motion transitions + creation side-effect at step 0→1 + exit-confirm-deletes-instance | yes | hardest — needs a Stepper primitive decision first |

Common shape: every one hand-rolls its backdrop + (sometimes) Escape, none has a focus
trap or restoration — exactly what Modal/useDismissable replaces.
**CORRECTED by b3-wave1-investigation.md (verified):** SaveContact DOES have a
document-level Escape handler (Inbox.tsx ~203–208) — the no-Escape gaps are
ConfigEditDialog and AddLineWizard (later waves). And Modal's size classes never consume
the --panel-* tokens (sm/md are literals; tokens-v3 §6.12 supersedes all five dialog
panel tokens with --modal-w-sm/-md/-lg) — the DD-18r SSOT leg STARTS by tokenizing the
Modal size classes, then dialogs adopt `size` and the --panel-* consumption dies.

## Recommended wave order (for the A0 packet to confirm)

1. **B3 wave 1:** SaveContact (extract+migrate) · RelinkModal · CreateGroupModal.
2. **B3 wave 2:** ConfigEditDialog (dismissable=false) · ScheduleComposerModal
   (sequence AFTER B2 if ChatPicker rebuild lands there, else accept double-touch).
3. **B3 wave 3:** UpdateModal (per-phase actions stay in body; Modal shell + dismissal
   only) · GroupDetailModal (shell + Tabs-primitive tablist; nested confirms ride the
   existing overlay stack).
4. **B3 wave 4:** AddLineWizard — blocked on a Stepper primitive/spec decision and the
   step-transition motion question (DD-19 territory); fix the role-on-backdrop defect
   regardless.

## Test impact

Each dialog has a dedicated test file except SaveContact/AddLineWizard (covered via
app.test.tsx) and ContactSearchPicker consumers. Migration assertions to add per dialog:
Escape single-fire via the stack; focus trap + restoration; dismissable semantics
(outside-click yes/no per dialog); aria-labelledby resolution; stacked-confirm LIFO
(GroupDetailModal). Ratchet effect: `soup/no-adhoc-modal` buckets (c-dialog-backdrop +
role=dialog selectors) burn toward zero per migrated file.
