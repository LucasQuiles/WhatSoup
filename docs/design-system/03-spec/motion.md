# Motion — the semantic motion system: durations, easings, budget, and the reduced-motion contract

v3.0.0-draft · G2-locked direction · pending G3

Token values live in `tokens-v3.md` §2.5. Sources: v2.html (locked, incl. annotations motion
table), research-digest §g + signal 10, seed-2 (easing pair, off-and-instant), decision-log
(crit-blink rejected; ambient budget = ok-breathing only).

## 1. Duration tokens

| Band | Token | Value | Spent on |
|---|---|---|---|
| instant | none — absence of transition | 0 | tabs, sort, theme swap, mode switch, focus/validation feedback, **every keyboard-initiated and operator-caused state change** |
| fast | `--dur-fast` | 120ms | hover washes, reveal-label, chevron rotation, press feedback; **modal exit** |
| base | `--dur-base` | 180ms | modal/toast/popover entry, feed arrival; **drawer exit** |
| slow | `--dur-slow` | 280ms | drawer entry — the single largest spatial move |
| ambient | (loop, not a transition token) | ≥ 1500ms; ok-breathing fixed at 2400ms | liveness loops only — see §8 |

Closed set. A new duration is a spec change. Hardcoded time literals in CSS/TSX are lint findings
(the legacy 0.12s/0.25s strays — P3-6 — die here).

## 2. Easing law

| Token | Curve | Use |
|---|---|---|
| `--ease-enter` | `cubic-bezier(0.2, 0, 0, 1)` | everything arriving — decelerate into place |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | everything leaving — accelerate away |
| `--ease-linear` | `linear` | opacity-only fades; spinner rotation (the sole rotational use) |

**Exits are faster than entrances** — law, not preference: modal 180 in / 120 out; drawer 280 in /
180 out; toast 180 in / 120 out. Springs are permitted only where a gesture hands off velocity
(toast swipe-dismiss, future drawer drag); zero bounce otherwise.

## 3. Property allowlist + waiver process

Animations may touch **`transform` and `opacity` only** (compositor-only; no layout-triggering
animation — no width/height/top/left/margin/padding tweens). Color transitions
(background-color/border-color/color) are additionally sanctioned at `--dur-fast` for hover/press
washes only, since they repaint without layout.

Waiver process: any other property requires a named waiver **in this file** — a table row stating
property, component, reason, and expiry. Current waivers: the reveal-label mechanic animates
`max-width` (Button spec) — granted because the affected box is a ≤120px leaf with no layout
siblings; expiry: revisit if profiling shows jank. No other waivers exist.

## 4. Structural-vs-decorative boundary

Every animation must classify as one of: **enter/exit**, **reposition/resize**, **feedback**
(hover/press), **ambient liveness**, or **loading choreography**. Unclassifiable animation is
decorative and rejected. Motion exists to confirm state, indicate liveness, and preserve spatial
continuity — never to entertain ("mechanical calm").

## 5. Anchored overlay rules

- **Popover/menu**: fade + scale from ~0.96 anchored at its trigger edge, `--dur-fast`–`--dur-base`
  in, fast out.
- **Modal**: fade + slight scale (0.985) + 8px rise, anchored top-center, 180 in / 120 out; scrim
  fades linear in parallel.
- **Drawer**: `translateX` (100% → 0) + scrim fade, 280 in / 180 out, anchored to the frame edge
  it belongs to. **No background scaling** (Vaul theatric rejected) — the fleet context behind the
  drawer stays visually stable.
- Table inline-expand **snaps** (instant) rather than slides.

## 6. Loading choreography

- Loaders (skeleton or spinner) appear only after a **150–200ms delay** — fast responses must
  never flash a loader.
- Skeleton shimmer is opacity-only pulse (1200ms, linear, alternate), mirrors the geometry of the
  loading content, and holds a static tone under reduced motion.
- Spinner rotation (800ms) is the **only** sanctioned `linear` rotation.
- Prefer optimistic/instant updates where the fleet API allows.

## 7. Instant feedback law

Focus rings, hover ink, press states, and validation errors render **instantly** — no transition
on focus or error appearance. Feedback latency is trust in an ops console. **Error shake and any
attention animation are banned**; errors use color + icon + text (GOV.UK pattern,
interaction-patterns.md).

## 8. Ambient budget law

The system's entire ambient-motion budget is **one loop**: the ok-disc breathing halo, 2400ms,
ease-enter, on live online indicators. A's crit-blink was evaluated and **rejected** at G2 —
critical states are carried by shape + color + label + position, not by motion. Adding any second
ambient loop requires a G-gate decision, not a PR. The typing ellipsis (1400ms steps) is classified
loading-choreography (scoped to an active conversation), not ambient, and stops under
reduced motion.

## 9. Reduced/no-motion contract — off-and-instant

Under `prefers-reduced-motion: reduce`, **every animation and transition is removed, not
shortened**: the breathing halo and typing dots stop (static shape + color + label remain), the
skeleton holds a static tone, drawer/modal/toast appear and disappear in place, scroll-behavior is
auto. Implementation: global kill via the media query plus per-component checks for JS-driven
timing (the v2 modal demo pattern).

**No information may exist only in motion.** Liveness, status, arrival, and progress all have
static renderings (shape law, labels, counts, timestamps).

**WCAG 2.2.2 console-level control**: independent of OS settings, the console ships a persistent
"pause live motion" control covering the activity feed auto-update and ambient indicators (the v2
feed's Pause action is this control's seed). Auto-updating surfaces (feed, log tail) expose
pause/resume; paused state is visibly labeled.

## 10. Performance constraints

Compositor-only discipline (§3); `will-change` only against measured jank, never prophylactically;
animations must not block the next operator action (no input-locking transitions); virtualized
surfaces (logs) do not animate row recycling.

## 11. Expressive-motion zones

- **Forbidden**: all dense/decision surfaces — Fleet, Ops, tables, logs, toolbars, drawer, modals,
  forms, Inbox. Near-zero ornamental motion in data-dense surfaces (seed-4).
- **Rare brand moments** (e.g. wizard completion) may exceed the bands only with **explicit spec
  sanction**: a named entry added to this file via version bump, with duration, surface, and
  frequency cap. None are currently sanctioned; Rive-class animated assets remain rejected for v3.

## 12. Migration notes

Legacy `--ease` (73 refs) splits into the enter/exit pair by direction; `--dur-fast/norm/slow`
re-value to 120/180/280; hardcoded literals (P3-6) tokenize; `msg-slide-in`, `animate-breathe*`,
`animate-shimmer`, `typing-dot` re-derive from this spec's bands (breathe keeps 2400ms; shimmer
becomes the §6 pulse). Keyboard actions that currently animate lose their transitions.

## 13. Enforcement hooks

`animated-property-allowlist`, `duration-easing-tokens-only`, `motion-needs-reduced-variant`,
`no-second-ambient-loop` (animation-iteration-count infinite outside the breathe keyframes), and
the reduced-motion lane in the visual QA matrix.
