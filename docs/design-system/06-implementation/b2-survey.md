# B2 Pre-Investigation Survey — pickers and inputs (DD-12..16)

Read-only codebase survey (2026-06-12) feeding the future B2 A0 packet. Facts verified
against the live tree at the time of C2.3 acceptance + B1 in flight. Not a plan; the B2
investigation packet supersedes this when written.

## Component facts

| Component | File | Behavior today | WAI fit / gaps | Callers | Tests |
|---|---|---|---|---|---|
| LinePicker (DD-12) | `console/src/components/LinePicker.tsx` | trigger button + absolute dropdown; Escape closes; document mousedown outside-close; NO arrow keys/type-ahead; 2 variants (toolbar/compact) | readonly combobox; missing Down/Up/Enter contract; hand-rolled dismissal (select.md bans — must move to useDismissable/Popover) | Ops, Inbox | `line-picker.test.tsx` (open/close/selection/outside/Escape/cleanup) |
| TagInput (DD-13) | `console/src/components/TagInput.tsx` | input + inline span pills; Enter adds, Backspace-on-empty removes last, blur adds; validate/normalize/dedupe props | pills are raw spans, remove button has NO aria-label (the DD-13 gap); should render via Pill variant=removable | ConfigStep, IdentityStep, ConfigEditDialog | `tag-input.test.tsx` (entry/trim/dedupe/validate/remove/Backspace/blur) |
| CardSelector (DD-14) | `console/src/components/CardSelector.tsx` | button grid styled as cards; selected = color wash + border | radiogroup semantics absent (no role=radiogroup/radio, no aria-checked) | ConfigStep, IdentityStep | `card-selector.test.tsx` |
| Segmented (DD-15) | ToolbarTimeRange in `primitives/Toolbar.tsx` | canonical seg (role=group + aria-pressed exactly-one) — **currently ORPHANED: zero production callers** (Fleet omitted time-range per C2.3 C-2; chart range pills still FilterPill-based) | correct toggle-group pattern | none yet | `primitives-toolbar.test.tsx` |
| Search-picker family (DD-16) | `shared/ChatPicker.tsx`, `shared/ContactSearchPicker.tsx`, `ContactSearch.tsx` | ChatPicker: auto-search single-select, labeled clear; ContactSearchPicker: 300ms debounce multi-select w/ LABELED remove chips; ContactSearch: manual "Go" trigger, **ORPHAN — zero production callers** | all three readonly comboboxes lacking dropdown keyboard nav; all hand-roll dismissal | ScheduleComposerModal (ChatPicker); GroupDetailModal + CreateGroupModal (ContactSearchPicker); none (ContactSearch) | chat-picker, contact-search tests; ContactSearchPicker UNTESTED |

Also adjacent: three ad-hoc tablists (ConfigStep, ModelAuthStep, GroupDetailModal) now
have the Tabs primitive (B1) as their migration target — ConfigStep/ModelAuthStep are
wizard surfaces (B2 or B3 scope decision at packet time); GroupDetailModal's is B3.

## Spec anchors

- `03-spec/components/select.md`: native select default; custom select ONLY for rich
  content; custom = Popover primitive + useDismissable (hand-rolled outside-click/Escape
  banned); option rows 28px; Down/Up/Enter/Escape contract; migration list names
  LinePicker/ChatPicker/ContactSearchPicker explicitly. NOTE: a **Popover primitive does
  not exist yet** — it is net-new B2 work (build on useDismissable like Drawer did).
- `03-spec/components/input.md`: ONE SearchInput component (inline re-implementations
  banned); field kit promotion from `wizard/form-primitives.tsx` to `components/form/`
  (DUP-12); error aria wiring; disabled = dashed border.
- `03-spec/components/pill.md`: removable Pill is the TagInput chip target (labeled
  remove built-in, 24px hit floor).

## Shape of the B2 slice (candidate, for the A0 packet to confirm)

1. Popover primitive (net-new, useDismissable-based) + keyboard option-list contract.
2. LinePicker rebuilt on it (combobox keyboard contract; both variants).
3. ChatPicker + ContactSearchPicker rebuilt on it; **delete orphan ContactSearch**
   (+ its test) per the register's expiration condition.
4. TagInput chips → Pill removable variant (closes the unlabeled-remove gap).
5. CardSelector → radiogroup semantics (role/aria-checked/arrow keys).
6. DD-15: adopt ToolbarTimeRange for the chart range pills (its first real caller) or
   extract a standalone SegmentedControl if the toolbar coupling doesn't fit — decide in
   packet.
7. ContactSearchPicker gets its missing test file.

Risks for the packet: ScheduleComposerModal/GroupDetailModal/CreateGroupModal consume
the pickers AND are B3 migration targets — sequence B2 pickers before B3 dialog shells
or accept double-touch; form-primitives promotion (input.md DUP-12) may be its own
sub-slice to keep B2 reviewable.
