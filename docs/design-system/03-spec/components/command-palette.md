# Command palette — the ⌘K fleet launcher (showcase §17)

A keyboard-first launcher overlay. **v1 is read-only**: fuzzy-switch routes and jump to a
line's detail. No mutations, no confirm dialogs, no line actions (later slices). Opened by the
global `⌘K` / `Ctrl+K` binding (`use-keyboard-shortcuts`), which v1 repurposes from the old
focus-search behaviour.

## Anatomy

Rendered through the **Modal primitive** (the one sanctioned dialog surface — `soup/no-adhoc-modal`):
Modal owns the scrim, shell, border/radius/shadow, focus trap + restoration, background-inert,
stack-aware Escape, scrim outside-click, and exit presence. Inside the shell:

- a **combobox query input** (`TextInput` primitive — satisfies `soup/no-raw-form-control`),
  monospace, full-width;
- a scrollable **listbox** of commands, the single scroll owner.

Two command sources: **Go** (static routes — Kitchen `/`, Inbox `/inbox`, Metrics `/metrics`,
Operator `/operator`, with `1/2/3` kbd hints) and **Jump** (one row per `useLines()` fleet line →
`navigate('/lines/:name')`).

## Conceptual props

| Prop | Meaning |
| ---- | ------- |
| `open` | Controls visibility (parent owns the state; ⌘K sets it). |
| `onClose` | Called on Escape / scrim-click / after a command executes. |

## States

- **Empty query** — all commands (routes first, then lines).
- **Filtering** — fuzzy subsequence match + score (contiguous + word-start bonuses); higher score
  first, input order preserved for ties.
- **No match** — a single non-interactive "No results" row (`role="status"`).
- **Lines loading** — routes render immediately; line rows append when `useLines()` resolves.
- **Active row** — `↑/↓` move it (wrap-around); the row carries `aria-selected` + accent-wash.

## Accessibility

- Dialog: `role="dialog" aria-modal="true"` + `aria-labelledby` (sr-only title) — owned by Modal.
- Input: `role="combobox" aria-expanded aria-controls=<listbox id> aria-autocomplete="list"
  aria-activedescendant=<active option id>`; receives initial focus on open.
- List: `role="listbox"`; rows `role="option" aria-selected`.
- Long line names truncate with `title` so the full value stays discoverable
  (`no-unsafe-truncation`).
- Enter executes the active row; Escape closes (owned by Modal/`useDismissable`).

## Examples / anti-patterns

- **Do** render the overlay through `Modal` and the query through a `FormControl` input.
- **Don't** hand-roll a `role="dialog"` backdrop or a raw `<input>` — both are lint-blocked, and
  the palette would lose focus-trap, background-inert, and stacking.
- **Don't** perform mutations from v1 — it is navigation-only.

## Enforcement hooks

- `soup/no-adhoc-modal` — the palette must use the Modal primitive (no ad-hoc `role="dialog"`).
- `soup/no-raw-form-control` — the query input must be a FormControl primitive.
- `react-hooks/set-state-in-effect` — reset-on-close runs in a handler; the active index is clamped
  during render (no state-setting effects).
- Covered by `tests/console/command-palette.test.tsx` and `tests/console/fuzzy.test.ts`; a11y/role
  contracts are exercised by the browser suite (a11y-contracts, viewport-matrix).
