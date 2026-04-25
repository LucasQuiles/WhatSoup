---
name: image-editing
description: "Use when editing, resizing, compressing, cropping, converting, or modifying images. Triggers on: resize image, make image smaller, compress photo, change image size, edit this image, modify this picture, scale image, crop photo, remove background, change format, image dimensions, make it wider, make it taller, reduce file size, optimize image, image too big, shrink image, enlarge image, upscale image, make transparent, warmer, cooler, add sunglasses, brighter, darker, fix lighting, look professional"
---

# Image Editing Skill

When a user sends an image with a freeform editing request (not using `/image-edit` explicitly), this skill guides you through the process.

## Step 1: Identify the Source Image

Look for `[Image: /path/to/file]` in the current or recent messages. This is the file path on disk.

If no image is found, ask the user to send one first.

## Step 2: Get Image Info First

Before any operation, run info to understand what you're working with:
```bash
python3 ~/.claude/plugins/q-image/tools/image-tools.py info "$SOURCE_IMAGE"
```
This tells you dimensions, format, file size, and color mode — essential for choosing the right operation and parameters.

## Step 3: Interpret the Request

Map natural language to operations:

| User says | Operation | Tool |
|-----------|-----------|------|
| "make it smaller" | resize + compress | Pillow (free) |
| "reduce file size" | compress | Pillow (free) |
| "shrink this" | resize (50% of original) | Pillow (free) |
| "make it 800x600" | resize 800x600 | Pillow (free) |
| "crop to square" | crop 1:1 | Pillow (free) |
| "make it wider" | crop 16:9 or AI extend | Depends on intent |
| "convert to PNG" | convert png | Pillow (free) |
| "what size is this?" | info | Pillow (free) |
| "make transparent" / "transparent background" | remove-bg | OpenAI (~$0.04) |
| "remove the background" | remove-bg | OpenAI (~$0.04) |
| "change the sky to sunset" | ai edit | OpenAI (~$0.04+) |
| "add text saying X" | ai edit | OpenAI (~$0.04+) |
| "remove the watermark" | ai edit | OpenAI (~$0.04+) |
| "make it look vintage" | ai edit | OpenAI (~$0.04+) |
| "warmer" / "cooler" tones | ai edit | OpenAI (~$0.04+) |
| "add sunglasses" | ai edit | OpenAI (~$0.04+) |
| "brighter" / "darker" | ai edit | OpenAI (~$0.04+) |
| "fix the lighting" | ai edit | OpenAI (~$0.04+) |
| "make it look professional" | ai edit | OpenAI (~$0.04+) |
| "upscale" / "enhance" | resize (2x) + ai edit | Combined approach |

### Ambiguity Resolution

When a request is ambiguous:
- **"make it smaller"** — means file size/dimensions, NOT content removal. Use Pillow resize.
- **"make it bigger"** — means dimensions. Use Pillow resize (upscale). If they want more detail, suggest `/image-hd` with a description.
- **"clean it up"** — ask: do they mean remove noise/artifacts (AI edit) or reduce file size (compress)?
- **"fix it"** — ask what specifically needs fixing. Don't guess.
- **"change the color"** — ask: background color? Object color? Color grading? Be specific.

## Step 4: Choose the Right Tool

**Use Pillow (free, instant) for:**
- Resize, scale, dimensions changes
- Compression / quality reduction
- Cropping (ratio or coordinates)
- Format conversion
- Getting image info/metadata

**Use OpenAI API (~$0.04+) for:**
- Content-aware edits (remove objects, change colors, add elements)
- Background removal
- Style changes
- Any edit that requires understanding image content

**When ambiguous:** Default to the cheaper option. If the user says "make it smaller", use Pillow resize, not OpenAI.

### input_fidelity Guidance

For OpenAI edits, choose input detail level:
- **high** (default) — use for: face edits, text changes, fine detail work, small object manipulation
- **low** — use for: sky replacement, broad color grading, style transfer, background changes — faster and cheaper

## Step 5: Enhance AI Edit Prompts

When using OpenAI for edits, enhance the user's terse request into a detailed, specific prompt.

**Structure:** Describe what to change, how to change it, and what to preserve.

**Rules:**
1. **Be explicit about preservation** — always mention what should NOT change.
2. **Describe the desired result**, not just the action.
3. **Mention blending** — edits should look natural, matching existing lighting and style.
4. **Specify quality markers** — "seamless", "photorealistic", "matching the existing style".
5. **Keep it focused** — one clear edit per prompt.

**Enhancement examples:**

| User says | Enhanced prompt |
|-----------|---------------|
| "remove the person" | "Remove the person from the scene completely. Fill the area with a natural continuation of the background, matching perspective, lighting, and texture seamlessly. Preserve all other elements exactly as they are." |
| "make it sunset" | "Transform the sky into a warm golden sunset with orange and pink clouds. Adjust the lighting on all surfaces to match warm sunset illumination with long shadows. Preserve the composition and all foreground elements." |
| "add sunglasses" | "Add stylish dark aviator sunglasses to the person's face, properly positioned on the nose bridge and ears. The sunglasses should have realistic reflections and shadows matching the existing lighting. Preserve all other facial features and the rest of the image." |
| "make it winter" | "Transform the scene into winter: add a layer of fresh white snow on all horizontal surfaces, frost on windows and edges, and an overcast winter sky. Adjust lighting to cool blue-white tones. Preserve the composition and structural elements." |
| "fix the lighting" | "Improve the overall lighting to be well-balanced and natural. Reduce harsh shadows, brighten underexposed areas, and ensure even illumination while maintaining natural contrast. Preserve all content and composition." |
| "make it look professional" | "Enhance this image to look professionally shot: improve color balance, add subtle vignetting, sharpen the subject, ensure proper white balance, and apply a clean, polished look. Preserve the original subject and composition." |

## Step 6: Execute

Use the image-tools.py utility for Pillow operations:
```bash
python3 ~/.claude/plugins/q-image/tools/image-tools.py <operation> <input> <output> [args]
```

For OpenAI edits, use curl:
```bash
mkdir -p /tmp/q-imagegen
export IMG_SOURCE='<SOURCE_IMAGE>'
export EDIT_PROMPT='<ENHANCED_PROMPT>'
export IMG_OUTPATH="/tmp/q-imagegen/$(uuidgen).png"
bash << 'EDITEOF'
set -euo pipefail
OKEY=$(secret-tool lookup service openai)
RESP=$(curl -sf https://api.openai.com/v1/images/edits \
  -H "Authorization: Bearer $OKEY" \
  -F model="gpt-image-1" \
  -F "image=@$IMG_SOURCE" \
  -F prompt="$EDIT_PROMPT" \
  -F size="1024x1024" \
  -F quality="high" \
  -F n="1" \
  -F output_format="b64_json")
python3 -c "
import base64, json, sys, os
data = json.loads(sys.stdin.read())
if 'error' in data:
    print(json.dumps({'ok': False, 'error': data['error'].get('code','server'), 'detail': data['error'].get('message','')[:200]}))
    sys.exit(1)
b64 = data['data'][0]['b64_json']
outpath = os.environ['IMG_OUTPATH']
with open(outpath, 'wb') as f:
    f.write(base64.b64decode(b64))
print(json.dumps({'ok': True, 'path': outpath}))
" <<< "$RESP"
EDITEOF
```

## Step 7: Deliver

1. Save output to `/tmp/q-imagegen/<uuid>.<ext>`
2. Send via `send_media` with a brief caption describing what was done
3. Clean up temp file after send

## Common Workflows

### WhatsApp Optimization
1. Get info -> check current size and dimensions
2. If > 1MB: compress to quality 75 as JPEG
3. If still > 1MB: also resize to max 1280px on longest side
4. If still > 1MB: try quality 60
5. Send result with size comparison in caption

### Social Media
Common platform sizes:

| Platform | Format | Size |
|----------|--------|------|
| Instagram post | square | 1080x1080 |
| Instagram story | portrait | 1080x1920 |
| Instagram reel cover | portrait | 1080x1920 |
| Facebook cover | landscape | 820x312 |
| Facebook post | landscape | 1200x630 |
| Twitter/X header | landscape | 1500x500 |
| Twitter/X post | landscape | 1600x900 |
| LinkedIn banner | landscape | 1584x396 |
| LinkedIn post | landscape | 1200x627 |
| YouTube thumbnail | landscape | 1280x720 |
| TikTok | portrait | 1080x1920 |
| Pinterest | portrait | 1000x1500 |

When a user says "for Instagram" or "for Twitter" etc., use the appropriate dimensions from above. Crop first to the correct ratio, then resize to exact dimensions.

### Web Optimization
1. Convert to WEBP
2. Compress to quality 80
3. Resize if > 2000px on any side
4. Report: original size -> new size, savings percentage

### Profile Picture
1. Crop to 1:1 (center crop)
2. Resize to 512x512 (or platform-specific if mentioned)
3. If remove-bg requested, do that first before crop/resize

### Multi-Step Edits
When a user asks for multiple changes:
1. Plan the order: structural changes first (crop, resize), then format/compression last
2. For AI + Pillow combos: do AI edit first (works best on original quality), then Pillow operations
3. Execute sequentially, each step using the previous output as input
4. Send only the final result with a summary caption
5. Clean up all intermediate temp files
