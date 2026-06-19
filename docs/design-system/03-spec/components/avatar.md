# Avatar — the identity primitive (`role="img"`, shape-coded presence)

v3.0.0-draft · G2-locked direction · pending G3

Identity at a glance: a circular disc carrying an image, initials, or a deterministic
identity hue, with an optional presence indicator. Ships as two components —
`Avatar` (one disc) and `AvatarStack` (overlapping group capped with a `+N` chip).
Resolves DD-43 (the primitive the showcase §20 specimen marked "tokens shipped,
component never built" — it is built now) and DD-44 (the AA-contrast hue refinement,
below). Renders the `.soup-av` / `.soup-av-stack` family.

## Anatomy

```
Avatar  span.soup-av[role="img"] (disc; border-radius 50%; --avatar-sm 32 / --avatar-md 36;
        inset --bw hairline ring; --avatar-ink initials ink)
├─ EITHER img.soup-av__img (object-fit cover; alt="" — the disc owns the name; onError → initials)
│  OR    span[aria-hidden] initials (1–2 letters from name; '?' fallback)
└─ span.soup-av__presence[aria-hidden] (dot, bottom-right; SHAPE-coded — see Presence)

AvatarStack  span.soup-av-stack[role="group"] (overlapping discs, −--sp-2 margin,
        surface ring between; caps at `max` with a soup-av--more "+N" mono chip)
```

The presence dot and the inner image/initials are `aria-hidden`; the disc's
`role="img"` + `aria-label` is the single accessible name (identity, plus the
presence word when set).

## Conceptual props

**Avatar:** `name` (string, required — drives initials, hue, and label) · `size?`
(`'sm'`|`'md'`, default `'md'`) · `variant?` (`'hue'`|`'neutral'`, default `'neutral'`) ·
`src?` (string — image, falls back to initials on error) · `presence?`
(`'online'`|`'away'`|`'offline'`) · `aria-label?` (string — overrides the
presence-augmented default) · `className?`.

**AvatarStack:** `names` (string[], stacking order) · `max?` (number, default 3 —
render N then collapse the rest to `+N`) · `size?` · `variant?` (default `'hue'`) ·
`aria-label?` (default `"<n> members"`) · `className?`.

`variant='hue'` is suppressed when an image renders (the photo is the identity).
Hue is the one inline style the primitive emits — `background: var(--avatar-hue-<i>)`
where `i = avatarHueIndex(name)` — because the per-identity token is chosen at
runtime; it is still token-only, never a raw colour.

## The 8-hue identity palette (F-ID-1) and the DD-44 AA refinement

The identity palette is **8 muted hues** (`--avatar-hue-0..7`), assigned
deterministically from `name`, used **only** for identity — never for status, mode,
or provider meaning (those own their own channels; reusing them here would collide
with the colour-as-meaning law).

Showcase → token mapping (a deliberate divergence, not drift): the showcase §20
swatch lists muted **hex** values (`#5C7A8C` …`#8C6B5C`). The console palette is the
**DD-44 resolution** of that intent — programmatic `hsl(H, 45%, 34%)` for
`H ∈ {0,45,…,315}` with a fixed `--avatar-ink: #fff`. Lightness is pinned at 34%
(not ~55%) so white initials clear **AA contrast in both themes** with a single,
theme-independent ink. The hue *family* matches the showcase; the exact channel
values are the AA-correct refinement and are the canonical source.

## States / presence

Presence is encoded by **shape + ring-style, never colour alone** (§12 shape law) so
it survives `forced-colors` and colour-blind viewers, and is announced as a word in
the accessible name:

- **online** — filled disc (`--status-ok-solid`).
- **away** — hollow ring (`--status-warn-solid` inset ring on a surface dot).
- **offline** — *smaller* hollow ring (`--text-3` inset), distinct in size as well as fill.
- **no presence** — no dot rendered.
- **neutral variant** — muted disc (`--text-3` wash), no identity hue (the chat-list shape).
- **image error** — silently falls back to initials (no recovery within a mounted row).
- **overflow chip** — `soup-av--more`, mono `+N`, muted surface.

## Accessibility

The disc is `role="img"` with an `aria-label` that conveys identity and, when a
presence is set, the presence word (`"<name>, online"`) — screen readers never depend
on the ring colour. The `<img>` uses `alt=""` and the initials/presence spans are
`aria-hidden`, so the disc is announced exactly once. `AvatarStack` is a
`role="group"` with a member-count label; the `+N` chip is its own `role="img"`
labelled `"<n> more"`. No focus/keyboard contract — Avatar is presentational; an
interactive avatar (row link, menu trigger) is owned by the enclosing control, not
this primitive.

## Examples / anti-patterns

- **Do**: chat-list row identity (`variant='neutral'` initials); group/contact identity
  (`variant='hue'`); a presence-bearing contact disc; a group header with
  `<AvatarStack names=… max=3 />`.
- **Don't**: encode presence with colour only (drop the shape → fails §12 and
  forced-colors); pull a status/mode/provider colour for the identity hue (cross-channel
  collision); render initials text without the `role="img"` wrapper (loses the single
  accessible name); hand-roll an overlapping avatar row instead of `AvatarStack`; make
  the disc itself focusable/clickable (wrap it in the owning control instead).

## Enforcement hooks

- **hue-channel separation** (review-level): `--avatar-hue-*` is identity-only; a review
  check should reject any `--avatar-hue-*` reference outside the Avatar primitive and any
  status/mode/provider token used as an avatar background. No dedicated shadow rule yet —
  candidate enforcement.
- **AA contrast** (active): the DD-44 `hsl(…,34%)` + `--avatar-ink #fff` pairing is covered
  by the contrast-matrix guard (`check-contrast-matrix.mjs`); the empty-scan guard keeps it
  fail-closed.
- **shape-coded presence** (pending G3): "presence never colour-alone" + "disc announced
  once" want a `tests/console` behavioural suite asserting the shape classes and the
  `aria-label` presence word — none exists for Avatar yet. That suite is the G3 gate.
