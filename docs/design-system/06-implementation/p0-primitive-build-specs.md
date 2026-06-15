# P0 primitive build specs — Avatar · Menu · Accordion (DD-43 / DD-44)

Scoping for the three P0 primitives whose showcase specimens are locked (§20 Avatar, §22 Menu, §21 Accordion).
Mirrors `card-primitive-build-spec.md`: API + migration + enforcement ratchet + the a11y requirements the
critique waves surfaced. Proposals only — the builds are product changes to land carefully (explicit-path, no
push), and Avatar's token edit is blocked until the orphaned `tokens.primitive.css` WIP is reconciled.

---

## 1 · Avatar (visual target: §20; carries the DD-44 fix)
**Gap:** hand-rolled in **6 files** — `ChatListItem` (neutral `bg-d5` + initials), `GroupCard`/`GroupDetailModal`
(hued via `groups-utils.avatarColor`), `AccessTab`, `Inbox`, `ActiveHoursHeatmap`. Tokens `--avatar-sm 32`/
`--avatar-md 36` + the 8-hue palette already shipped; only the component is missing.

**API**
```ts
interface AvatarProps {
  name: string                         // for initials (getInitials) + the REQUIRED accessible name
  seed?: string                        // group/contact id → deterministic hue (groups-utils.avatarColor)
  variant?: 'neutral' | 'hued'         // neutral = chat list (--surface tint); hued = group/contact identity
  size?: 'sm' | 'md'                   // --avatar-sm 32 / --avatar-md 36 (the two shipped tokens)
  src?: string                         // image; falls back to initials, then a neutral glyph
  presence?: 'online' | 'away' | 'offline'   // shape-differentiated, not colour-only (see a11y)
}
```
**DD-44 fix baked in (decided, computed):** hued fills must be **`hsl(H,45%,34%)`** (not L55) with a **fixed white
ink** for initials (not `--t1`) — clears WCAG AA 4.5:1 for all 8 hues × 2 themes (min 4.76; current 1.78). This
requires the token edit in `tokens.primitive.css` (blocked on the orphaned-WIP reconcile) + a fixed
`--avatar-ink:#fff` (or literal) on the initials, replacing `text-t1` in GroupCard/GroupDetailModal.

**a11y requirements (from the §20 critique):**
- Presence pairs **shape + colour** (online filled · away hollow ring · offline small/hollow), survives
  forced-colors; and carries a **text equivalent** (`aria-label`/visually-hidden), never a colour-only dot.
- The avatar is decorative; the **full name travels in an adjacent label** / `aria-label` — hue is never the sole
  identity signal.

**Migration:** replace the 6 hand-rolls with `<Avatar variant=… size=… />`. **Enforcement:** the existing
`icon-size-ramp`-style discipline + a frozen-inventory guard "avatar dimensions must come from `--avatar-sm/md`,
no raw px" (a real categorical pattern — verified no live drift today, so it pins zero and prevents regression
once the component lands).

---

## 2 · Menu (visual target: §22; greenfield — no existing consumer)
**Gap:** **no `role="menu"` anywhere** today; row actions + bulk actions don't exist. The Menu is a thin
`role="menu"` variant of the existing **Popover** primitive (reuse its keyboard contract + `useDismissable`).

**API**
```ts
interface MenuProps {
  trigger: ReactNode                   // sets aria-haspopup="menu" + aria-expanded
  items: MenuItem[]                     // sections via {label} dividers
}
type MenuItem =
  | { kind:'action', label, icon?, shortcut?, onSelect, destructive?:boolean }   // destructive → ConfirmDialog
  | { kind:'checkbox', label, checked, onToggle }                                // role=menuitemcheckbox + aria-checked
  | { kind:'radio', label, checked, group, onSelect }                            // role=menuitemradio + aria-checked
  | { kind:'section', label }                                                    // mono section header
```
**a11y requirements (from the §22 critique — hard contract, the recurring "cheque" defect):**
- Roving-focus `role="menu"` / `role="menuitem"`; Esc dismiss; **focus restores to the trigger**.
- **Disabled-with-reason must use `aria-describedby` to a real node AND stay focusable (`aria-disabled`), never
  `title`-only.** (Mirrors §11 Button's "disabled stays in tab order".)
- Checkable items are `menuitemcheckbox`/`menuitemradio` + `aria-checked` — the ✓ is presentation over that, not
  a substitute. The check uses `--accent`, never a status channel.
- Destructive items route through ConfirmDialog (Confirmation law), never fire inline.

**Migration:** greenfield — first consumers are Fleet/Inbox row context-menus + the bulk-action bar. **Enforcement:**
none needed up front (no recipe to ratchet); add `no-raw-role-menu` (hand-rolled `role="menu"` outside the
primitive) once a second consumer appears, like the tabpanel guard.

---

## 3 · Accordion (visual target: §21; the progressive-disclosure principle)
**Gap:** no disclosure primitive — the genuine target is **`ScheduledMessageRow`'s inline `useState` toggle** (and
future expand-rows). *Not* the Popover-backed pickers (`LinePicker`/`ChatPicker`/`ContactSearchPicker`) or table
sort — those are Popover/Table's domain; do not migrate them here.

**API**
```ts
interface AccordionProps {
  items: { id, summary:ReactNode, content:ReactNode, defaultOpen?:boolean }[]
  type?: 'single' | 'multi'            // single = one open at a time
}
```
Built on native `<details>`/`<summary>` semantics (or a controlled equivalent): one focus recipe on the summary
(`:focus-visible` outline), a chevron that **rotates on open and is removed (not shortened) under reduced-motion**
(`@media (prefers-reduced-motion:reduce)`), hairline dividers, the lit-from-above inset edge.

**a11y:** native `<details>` gives the disclosure semantics for free; if controlled, the summary is a `button` with
`aria-expanded` + `aria-controls` to the panel id. **Migration:** ScheduledMessageRow's hand-rolled toggle →
`<Accordion>`. **Enforcement:** a frozen-inventory guard "no hand-rolled `aria-expanded` disclosure toggle outside
the Accordion primitive" once it lands (pins ScheduledMessageRow's current pattern, fails on new).

---

## Build order & gating
Avatar first (cheapest — paid tokens, 6 mechanical migrations, carries the DD-44 a11y fix) → Menu (greenfield,
highest leverage: unlocks row/bulk actions) → Accordion (closes the progressive-disclosure principle gap). All
three are **product builds requiring owner approval** + the `tokens.primitive.css` reconcile (Avatar). Specimens
are the locked visual targets; these specs are the implementation contract.
