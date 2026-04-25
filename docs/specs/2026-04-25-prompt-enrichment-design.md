# Prompt Enrichment System — Design Spec

**Date:** 2026-04-25
**Plugin:** q-image (Claude Code plugin)
**Status:** Implemented

## Overview

A two-layer prompt enrichment system for the q-image plugin that makes prompt enhancement transparent and educational. Layer 1 shows users what happened; Layer 2 teaches them why.

## Layer 1: Show-and-Go (Transparent Enhancement)

**File:** `plugins/q-image/commands/image.md`

When a user generates an image via `/image` or `/image-hd`, the system already enhances their prompt before sending it to the API. This layer makes that enhancement visible.

**Behavior change:** After sending the generated image, send a follow-up text message:

```
_Enhanced prompt: "<the enhanced prompt that was sent to the API>"_
```

- Sent as a regular text message (not media), after the image
- Uses WhatsApp italic formatting (underscore wrapping)
- Shows the exact prompt that produced the image
- Users can copy/modify it for future generations

**Cost:** Zero — no additional API calls. The enhanced prompt already exists in the generation flow.

## Layer 2: Prompt Coach (Educational Breakdown)

**File:** `plugins/q-image/commands/image-coach.md`

A standalone command (`/image-coach <prompt>`) that enhances a prompt and returns a categorized breakdown of what was added and why — without generating an image.

**Behavior:**
1. User sends `/image-coach a cat`
2. System enhances the prompt using the same rules as `/image`
3. System categorizes every addition into breakdown categories
4. System returns the enhanced prompt + breakdown + ready-to-use `/image` commands

**Cost:** Zero — no image generation API calls. Purely LLM reasoning.

## File Changes

| File | Change |
|------|--------|
| `plugins/q-image/commands/image.md` | Added enhanced prompt display after image send in "Handle the result" step |
| `plugins/q-image/commands/image-coach.md` | New file — `/image-coach` command |

## Enhancement Rules (Shared Reference)

Both layers use the same enhancement rules:

1. **Preserve intent** — never change what the user asked for
2. **Add specificity** — fill in concrete visual details where vague
3. **Add structure** — Scene/Background → Subject → Details → Style → Lighting → Composition
4. **Style anchors** — context-appropriate defaults:
   - People/portraits → professional photography, 35mm film, shallow depth of field
   - Objects/products → studio product photography, clean lighting, subtle shadow
   - Scenes/landscapes → cinematic wide shot, volumetric lighting, rich color grading
   - Cartoons/fun → digital illustration, clean lines, vibrant colors
   - Abstract/artistic → digital art, dramatic contrast, bold composition
5. **Lighting** — always specify if not present
6. **Composition** — always specify if not present
7. **Materials/textures** — prefer over generic quality words
8. **Text handling** — quotes around literal text, spell tricky words letter-by-letter
9. **Length limit** — under 500 words (coach) / under 200 words (generation)

## Breakdown Categories

Used by `/image-coach` to categorize additions:

| Category | Scope |
|----------|-------|
| 🎨 Style | Artistic/photographic style, medium, rendering approach |
| 💡 Lighting | Light source, direction, color temperature, mood |
| 📐 Composition | Framing, angle, perspective, layout |
| 🔍 Details | Textures, materials, specific visual elements |
| 🎭 Mood | Atmosphere, emotion, tone |
| ✏️ Text | Typography guidance (only when prompt includes text) |

Only categories where additions were actually made are included — no forced padding.
