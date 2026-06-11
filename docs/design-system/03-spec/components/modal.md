# Modal — one dialog anatomy, one dismiss contract, one scrim

v3.0.0-draft · G2-locked direction · pending G3

Resolves P1-2 (11 dialog surfaces, 9 Escape copies, 0 focus traps). Locked source: v2.html modal
spec + overlay stage.

## Anatomy

```
scrim (fixed, --scrim)
└─ modal shell (--surface-overlay, 1px --border-subtle, --r-3, --shadow-overlay)
   ├─ head: title (--type-heading) + close X (24px hit) — padding --sp-4 --sp-5, hairline bottom
   ├─ [optional step strip — wizard only]
   ├─ body: padding --sp-5, grid gap --sp-4
   └─ foot: right-aligned actions (gap --sp-2), padding --sp-3 --sp-5, hairline top;
      split variant for note + actions
```

Width prop: sm `min(480px, calc(100% - 32px))` · md 560px · lg 720px (wizard). Max-height 85vh,
body scrolls. Modals are reserved for **interrupting decisions** — confirmation, auth/QR, the
wizard; browsing detail belongs to drawer/page (interaction-patterns §7).

## Conceptual props

`size` (sm/md/lg) · `title` · `onClose` · `dismissable` (outside-click; off for destructive
confirms) · `initialFocus` · footer action slots.

## States

- open (enter): anchored top-center, fade + 8px rise + scale 0.985, `--dur-base` `--ease-enter`;
  scrim fades linear in parallel
- close (exit): `--dur-fast` `--ease-exit` — **faster out than in**; scrim out linear fast
- focus-visible: ring on internal controls; the shell itself takes `tabindex="-1"` initial focus
  when no better target exists
- loading (async confirm): confirm button takes the Button loading state; modal stays interactive
  for cancel until commit
- error: inline GOV.UK field errors or a body error block with remedy — never a bare failure
- disabled/hover/selected: per contained components
- reduced-motion: scrim and shell appear/disappear instantly (the v2 JS pattern: skip exit
  animation entirely)
- stacking: modal-over-modal allowed one level deep (confirm over detail); Escape closes exactly
  the top layer (single-fire, interaction-patterns §2)

## Accessibility

`role="dialog"` + `aria-modal="true"` + `aria-labelledby` (title id); focus trap (Tab cycle);
restore focus to opener on close; destructive action never default-focused; close X carries
`aria-label`; scrim click honors `dismissable`; background content inert.

## Token references (both themes)

`--surface-overlay`, `--border-subtle`, `--border-hairline`, `--r-3`, `--shadow-overlay`,
`--scrim`, `--dur-base`/`--dur-fast`, `--ease-enter`/`--ease-exit`, spacing tokens. Dark elevates
by surface lightness; light by `--shadow-overlay` — no theme branches in the component.

## Examples / anti-patterns

- Do: "Stop line 'sales'?" — title as the question, consequence + preservation copy in body,
  Cancel ghost + danger action in foot.
- Don't: re-roll a shell with raised-surface + border combos; Escape handlers per dialog; modals
  for object browsing; nested scroll areas inside the body other than the body itself; more than
  one open confirm.

## Migration notes

Migrate all 11 dialog surfaces (component-inventory modal count) onto this shell + the shared
`useDismissable` hook; delete `c-dialog-body` or adopt it as the body slot (it currently has 0
consumers); fix the GroupDetailModal + ConfirmDialog double-close (single-fire Escape); the 5
legacy width tokens collapse to 3 sizes (tokens-v3 §6.12); KeyboardShortcutsHelp finally honors
its own "Esc to close" copy.

## Enforcement hooks

`modal-via-primitive` (no ad-hoc `position: fixed` dialog shells), `modal-must-restore-focus`,
`dismissable-contract`, scrim single source (`--scrim` is the only backdrop fill).
