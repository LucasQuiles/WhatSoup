---
name: image-coach
description: "Enhance an image prompt and explain what was improved — without generating. Use /image-coach <prompt> to learn prompt engineering."
argument-hint: "<prompt> or 'help'"
allowed-tools: ["Bash", "Read"]
---

# /image-coach — Prompt Enhancement Coach

Enhances a user's image prompt and explains what was added, without generating an image. Zero cost — purely educational.

## Parse the Command

1. If input is `/image-coach help` → show help text below and stop.
2. If input is `/image-coach` with no prompt → reply: "What prompt should I enhance? Add a description after /image-coach." and stop.
3. Extract the raw prompt: everything after `/image-coach `.

## Enhance the Prompt

Apply the SAME enhancement rules as the /image command:

1. **Preserve the user's core intent exactly.** Never change what they asked for.
2. **Add specificity where the user was vague.** Fill in concrete visual details.
3. **Add structure.** Organize as: Scene/Background → Subject → Details → Style → Lighting → Composition.
4. **Add a style anchor** if none provided:
   - People/portraits → "professional photography, 35mm film, shallow depth of field"
   - Objects/products → "studio product photography, clean lighting, subtle shadow"
   - Scenes/landscapes → "cinematic wide shot, volumetric lighting, rich color grading"
   - Cartoons/fun → "digital illustration, clean lines, vibrant colors"
   - Abstract/artistic → "digital art, dramatic contrast, bold composition"
5. **Add lighting** if none specified.
6. **Add composition** if none specified.
7. **Specify materials and textures** over generic quality words.
8. **For text in images:** Put literal text in quotes, spell tricky words letter-by-letter.
9. **Keep it under 500 words.**

## Build the Breakdown

After enhancing, categorize every addition you made into these categories:

- 🎨 **Style** — artistic/photographic style, medium, rendering approach
- 💡 **Lighting** — light source, direction, color temperature, mood
- 📐 **Composition** — framing, angle, perspective, layout
- 🔍 **Details** — textures, materials, specific visual elements added
- 🎭 **Mood** — atmosphere, emotion, tone (if added)
- ✏️ **Text** — typography guidance (only if the prompt includes text)

Only include categories where you actually added something. Don't force all categories.

## Format the Response

Reply with this format:

```
*Your prompt enhanced:*

"<the full enhanced prompt>"

*What I added:*
🎨 *Style:* <what style was added and why>
💡 *Lighting:* <what lighting was added and why>
📐 *Composition:* <what framing/angle was added and why>
🔍 *Details:* <what specific details were filled in>

*To generate:*
`/image <paste enhanced prompt>`
`/image-hd <paste enhanced prompt>`

_Or modify the enhanced prompt first — it's yours to tweak._
```

Use WhatsApp formatting: *bold* for headers, _italic_ for the closing tip, backtick for commands.

## Examples

### Input: `/image-coach a cat`

```
*Your prompt enhanced:*

"A photorealistic close-up photograph of a domestic tabby cat with striking green eyes, sitting on a sunlit windowsill. Soft natural light from the left, shallow depth of field with bokeh from houseplants in the background. Shot on 85mm lens, warm color palette."

*What I added:*
🎨 *Style:* Photorealistic photography with 85mm lens look — gives portraits a natural, flattering perspective
💡 *Lighting:* Soft natural window light from the left — creates gentle shadows and warm tones
📐 *Composition:* Close-up framing with shallow depth of field — draws focus to the subject, blurs distractions
🔍 *Details:* Tabby breed, green eyes, windowsill setting, houseplant bokeh — specificity produces sharper results than generic descriptions

*To generate:*
`/image <paste enhanced prompt>`
`/image-hd <paste enhanced prompt>`

_Or modify the enhanced prompt first — it's yours to tweak._
```

### Input: `/image-coach company logo for TechFlow`

```
*Your prompt enhanced:*

"A clean, modern logo design for a company called 'TECHFLOW'. Minimalist geometric shapes suggesting flowing data or liquid technology. Gradient from deep blue to electric cyan. Centered on a pure white background with ample negative space. Professional vector style, sharp edges, scalable design."

*What I added:*
🎨 *Style:* Minimalist vector style — logos need clean lines and sharp edges to scale across media
📐 *Composition:* Centered with negative space — essential for logo versatility on different backgrounds
🔍 *Details:* Geometric shapes suggesting flow, blue-to-cyan gradient — connects the name "TechFlow" to visual metaphor
✏️ *Text:* "TECHFLOW" in caps — clearer rendering in image generation models

*To generate:*
`/image <paste enhanced prompt>`
`/image-hd <paste enhanced prompt>`

_Or modify the enhanced prompt first — it's yours to tweak._
```

## Help Text

When user sends `/image-coach help`:

```
*Prompt Coach*

/image-coach <description> — enhance and explain a prompt without generating
/image-coach help — this message

Shows you exactly how your prompt would be enhanced, with a breakdown of what was added and why. Free — no image is generated.

Use it to learn prompt engineering, then generate with /image or /image-hd.

_Example: /image-coach a sunset over mountains_
_Example: /image-coach logo for a coffee brand called BeanDream_
```
