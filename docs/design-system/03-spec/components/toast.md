# Toast — Sonner-pattern restraint for operator-caused outcomes

v3.0.0-draft · G2-locked direction · pending G3

Locked source: v2.html toast block; research-digest §g (Sonner: steal the motion model, skin to
tokens; toasts never for ambient fleet events).

## Anatomy

```
toast-stack (fixed bottom-right, --sp-5 inset, grid gap --sp-2, z 110, aria-live polite)
└─ toast (--surface-overlay, 1px --border-subtle, --r-3, --shadow-overlay,
          min 280px / max 380px width tokens, padding --sp-3 --sp-4, --type-body)
   ├─ leading status shape (badge.md) when tone is set
   ├─ message (strong names in --type-body-st)
   └─ optional single action (--type-label, --accent, 24px target)
```

Tone edge: ok/crit add a 2px inset left edge in the channel solid (composited into the shadow).

## Scope law (restraint)

Toasts confirm **operator-caused outcomes only** ("Line billing created and linked."). Ambient
fleet events — status changes, reconnects, errors the operator didn't just cause — belong to the
activity feed and the attention metric, never to toasts. No toast spam: one toast per action;
queued stack caps at 3 visible (oldest collapses).

## Conceptual props

`tone` (neutral/ok/crit) · `message` · `action` ({label, onClick}) · `duration` (default 4000ms;
sticky for crit-with-action).

## States & motion budget

- enter: fade + 8px rise, `--dur-base` `--ease-enter`
- exit: fade, `--dur-fast` `--ease-exit` (auto-dismiss or swipe); swipe-dismiss may inherit gesture
  velocity (the sanctioned spring exception, motion.md §2)
- hover: pauses the auto-dismiss timer
- focus-visible: action button takes the standard ring; the stack is reachable via F6/landmark
  navigation, not a focus trap
- selected/disabled/loading/error: n/a (a failing action re-toasts with crit tone + remedy)
- reduced-motion: appear/disappear instantly; auto-dismiss timing unchanged

## Accessibility

Stack is `aria-live="polite"` (crit tone escalates to `assertive`); toasts are not the sole record
— anything important also lands in the feed/log; action labels are self-contained ("View line");
auto-dismiss never removes the only path to an outcome.

## Examples / anti-patterns

- Do: wizard completion toast with View action; "Marked 12 read."
- Don't: toasts for degraded/reconnect events (feed territory); richColors-style library defaults
  bypassing channel tokens; stacking unbounded toasts; toast-only error reporting; top-center
  placement (the stack is bottom-right, one position console-wide).

## Migration notes

Adopt the Sonner library (or equivalent) at implementation time, skinned entirely with semantic
tokens; legacy `--toast-max-w` re-values to 380px (tokens-v3 §6.12); audit existing toast call
sites against the scope law and demote ambient ones to the feed.

## Enforcement hooks

`toast-tokens-only` (no library default colors), toast-scope review lane (operator-caused only),
single-stack rule.
