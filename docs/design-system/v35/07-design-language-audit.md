# 07 — Design Language Audit (verified on origin/main 2026-07-21)

The current language, as-built. v3.5 inherits or overrides per the interview below.

## Color

**Dark theme — "warm wood"** (hue ~70°, chroma ≤0.012; warmth from neutrals, not chroma):
surfaces `#1B1610` base / `#231D15` raised / `#2E261B` overlay / `#14110C` inset ·
inks `#F2EBDC` cream / `#BEB29C` / `#897E6B` · hairlines `#352C20`/`#463A2B`/`#574A38` (opaque).

**Light theme — "warm bone/paper"** (designed, not inverted): `#FBF6EC` base / `#ECE3D2`
inset · inks `#221C12` / `#524833`.

**Accent (single, locked):** electric blue `#6BA6FF`, fg `#0A0E14`, hover `#85B6FF`.

**Status:** ok `#5BD97B` · warn `#F5B54A` · crit `#F4736F` (wash 12%, border 36% color-mix).
**Mode channels:** passive teal `#3BD6B0` (also the brand tick — "heritage") · chat cyan
`#45C9E8` · agent violet `#A78BFA`.
**Avatar hues:** 8 × `hsl(H,45%,34%)` + fixed white ink (AA-verified all themes).

## Type

Display **Bricolage Grotesque** 800 (nameplate only, −0.06em) · body **Hanken Grotesk** ·
data/mono **IBM Plex Mono**. Closed ramp, `--type-display` 700 26/32 at top. Self-hosted.

## Shape & texture

Radii 4/6/8px · 1px opaque hairlines · 4px spacing grid · status shapes disc/diamond/square/
outline 8px · teal tick 8×8 r1 · glass limited to chrome+scrim · **no gradients, glow,
illustration, mascots** (forbidden treatments).

## Motion

One ambient loop (ok-breathing 2400ms) · no crit-blink · reduced-motion = instant (removed,
not shortened) · standard ease `[0.22,1,0.36,1]`.

## Read

The identity is a **"warm paper instrument"**: cream-on-walnut dark, bone light, hairline
precision, one electric-blue voice, grotesque triad. Distinctive vs generic slate-gray SaaS.
Already close to the owner's "clean, soothing, subtle" brief — the warmth IS the soothing.

## Interview — v3.5 design language (answers pending)

| # | Question | Rec |
|---|---|---|
| L1 | Keep warm wood/paper ramps + cream inks as v3.5 foundation? | keep — strongest asset |
| L2 | Keep `#6BA6FF` single action accent? | keep |
| L3 | Per-agent identity hues from the existing 8-hue avatar palette (assigned at hatch)? | yes — lawful color expansion |
| L4 | Two shape registers: console 4/6/8 + dense; journey/hatch/splash softer 8/12/16 + spacious? | yes |
| L5 | Soft diffuse shadows on overlay tier (dark theme currently flat+hairlines)? | subtle, overlays only |
| L6 | Channel glyph style: filled monochrome silhouettes vs lucide-stroke? | filled silhouettes |
| L7 | Imagery: console stays no-illustration; journey/splash may use abstract glyph-geometry (no scenes/mascots)? | allow abstract only |
| L8 | Keep Bricolage/Hanken/Plex triad? | keep |
| L9 | Hero theme for splash: dark-warm hero, light alternate? | dark-warm |
| L10 | Hatch moment: one-time accent light-sweep, no new hues? | yes |
| L11 | 2–3 reference products whose feel to approach (or avoid)? | open |
