---
name: image-edit
description: "Edit an image — resize, compress, crop, convert, get info, or apply AI edits. Send an image first, then use /image-edit <operation>."
argument-hint: "<operation> [args] or 'help'"
allowed-tools: ["Bash", "Read", "Write", "mcp__whatsoup__send_media", "mcp__whatsoup__send_typing", "mcp__whatsoup__download_media"]
---

# /image-edit — Image Editing

## Parse the Command

1. If input is `/image-edit help` → show help text below and stop.
2. Parse operation and args from the input after `/image-edit `.

## Find the Source Image

The user should have sent an image before this command. Find it:

1. **Check current message** — if the current message has an attached image (indicated by `[Image: /path/to/file]` in the message text), use that path.
2. **Check recent messages** — scan backward through the conversation context for the most recent `[Image: /path/to/file]` entry. The path is the file on disk.
3. **No image found** → reply: "No image found. Send an image first, then use /image-edit." and stop.

Store the image path as `SOURCE_IMAGE`.

## Execute the Operation

The image-tools.py script is at: `~/.claude/plugins/q-image/tools/image-tools.py`

### resize <WxH>
```bash
python3 ~/.claude/plugins/q-image/tools/image-tools.py resize "$SOURCE_IMAGE" "<W>x<H>" "/tmp/q-imagegen/$(uuidgen).png"
```
Send the output file via `send_media`. Default preserves aspect ratio. Add `--stretch` for exact dimensions.

**Smart defaults** — if no size given:
- Photos > 4000px: resize to 2048px on longest side
- Photos > 2000px: resize to 1024px on longest side
- Otherwise: resize to 50% of original

### compress <quality:1-100>
```bash
python3 ~/.claude/plugins/q-image/tools/image-tools.py compress "$SOURCE_IMAGE" "/tmp/q-imagegen/$(uuidgen).jpg" <quality>
```
Send the output file. Quality 1-100 (higher = better quality, larger file).

**Smart defaults** — if no quality given:
- Files > 5MB: quality 60
- Files > 1MB: quality 75
- Otherwise: quality 85

### crop <spec>
Spec can be a ratio (`16:9`, `1:1`, `4:3`) or explicit (`WxH+X+Y`).
```bash
python3 ~/.claude/plugins/q-image/tools/image-tools.py crop "$SOURCE_IMAGE" "/tmp/q-imagegen/$(uuidgen).png" "<spec>"
```
Send the output file.

**Common presets:**

| Preset | Ratio | Use case |
|--------|-------|----------|
| square | 1:1 | Profile pics, Instagram |
| portrait | 3:4 | Mobile wallpaper, Pinterest |
| landscape | 16:9 | Desktop wallpaper, YouTube |
| story | 9:16 | Instagram/TikTok stories |
| banner | 3:1 | Website banners, Twitter header |

### convert <format>
Format: `png`, `jpg`, `webp`, `gif`
```bash
python3 ~/.claude/plugins/q-image/tools/image-tools.py convert "$SOURCE_IMAGE" "/tmp/q-imagegen/$(uuidgen).<format>"
```
Send the output file.

**Format guidance:**
- `png` — lossless, supports transparency, larger files
- `jpg` — lossy, no transparency, smallest for photos
- `webp` — best of both worlds, smallest with good quality, wide browser support
- `gif` — only for simple graphics, limited to 256 colors

### info
```bash
python3 ~/.claude/plugins/q-image/tools/image-tools.py info "$SOURCE_IMAGE"
```
Reply with the JSON output formatted as a readable message:
```
*Image Info*
Dimensions: 1920 x 1080
Format: JPEG
Size: 245 KB
Color mode: RGB
```

### remove-bg
First send acknowledgment: "Editing your image..." and typing indicator.

Then call OpenAI via curl. IMPORTANT: Pass source path via environment variable:
```bash
mkdir -p /tmp/q-imagegen
export IMG_SOURCE='<SOURCE_IMAGE>'
export IMG_OUTPATH="/tmp/q-imagegen/$(uuidgen).png"
bash << 'EDITEOF'
set -euo pipefail
OKEY=$(secret-tool lookup service openai)
RESP=$(curl -sf https://api.openai.com/v1/images/edits \
  -H "Authorization: Bearer $OKEY" \
  -F model="gpt-image-1" \
  -F "image=@$IMG_SOURCE" \
  -F prompt="Remove the background completely and make it fully transparent. Keep the foreground subject perfectly intact — preserve all edges, hair, fine details, and semi-transparent areas. The result should have a clean alpha channel with no background remnants. Note: some white areas at image edges are a known API behavior and may appear." \
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
Send the output via `send_media`. Handle errors using the same mapping as `/image`.

### ai "<prompt>"
First send acknowledgment: "Editing your image..." and typing indicator.

#### AI Edit Prompt Enhancement

Before sending the edit prompt to the API, enhance it for better results. The same principles as image generation apply, but adapted for edits:

**Structure:** Describe what to change, how to change it, and what to preserve.

**Rules:**
1. **Be explicit about preservation** — always mention what should NOT change.
2. **Describe the desired result**, not just the action ("make the sky a vibrant sunset with orange and pink clouds" vs "change sky").
3. **Mention blending** — edits should look natural, matching existing lighting and style.
4. **Specify quality markers** — "seamless", "photorealistic", "matching the existing style".
5. **Keep it focused** — one clear edit per prompt produces better results than multiple changes.

**Enhancement examples:**

| User says | Enhanced prompt |
|-----------|---------------|
| "remove the person" | "Remove the person from the scene completely. Fill the area with a natural continuation of the background, matching perspective, lighting, and texture seamlessly. Preserve all other elements exactly as they are." |
| "make it sunset" | "Transform the sky into a warm golden sunset with orange and pink clouds. Adjust the lighting on all surfaces to match warm sunset illumination with long shadows. Preserve the composition and all foreground elements." |
| "add sunglasses" | "Add stylish dark aviator sunglasses to the person's face, properly positioned on the nose bridge and ears. The sunglasses should have realistic reflections and shadows matching the existing lighting. Preserve all other facial features and the rest of the image." |
| "make it winter" | "Transform the scene into winter: add a layer of fresh white snow on all horizontal surfaces, frost on windows and edges, visible breath if people are present, and an overcast winter sky. Adjust lighting to cool blue-white tones. Preserve the composition and structural elements." |
| "fix the lighting" | "Improve the overall lighting to be well-balanced and natural. Reduce harsh shadows, brighten underexposed areas, and ensure even illumination across the scene while maintaining natural contrast. Preserve all content and composition." |
| "make it look professional" | "Enhance this image to look professionally shot: improve color balance, add subtle vignetting, sharpen the subject, ensure proper white balance, and apply a clean, polished look. Preserve the original subject and composition." |

#### input_fidelity Guidance

For AI edits, consider image detail level:
- Use `high` input_fidelity (default) for edits requiring precise detail (face edits, text, fine patterns)
- Use `low` input_fidelity for broad edits (sky replacement, color grading, style changes) — faster and cheaper

Then call OpenAI via curl. IMPORTANT: Pass source path AND enhanced edit prompt via environment variables:
```bash
mkdir -p /tmp/q-imagegen
export IMG_SOURCE='<SOURCE_IMAGE>'
export EDIT_PROMPT='<ENHANCED_EDIT_PROMPT>'
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
Send the output via `send_media` with the original user edit request as caption. Handle errors using the same mapping as `/image`.

## Multi-Step Edits

When a user requests multiple edits (e.g., "resize to 800x600 and convert to webp"), execute them sequentially:
1. Run the first operation, saving to a temp file
2. Use that temp file as input for the next operation
3. Send only the final result
4. Clean up all intermediate files

## Error Handling

- If image-tools.py exits with code 1, read stderr for the error message and reply to the user.
- If OpenAI API fails, use the same error mapping as the /image command.
- If the source image format is unsupported, reply: "That format isn't supported for editing. Use PNG, JPG, or WEBP."
- If the source image is > 50MB, reply: "Image is too big. Use something under 50MB."

## Clean Up

ALWAYS delete the temp file, regardless of whether send succeeded or failed:
```bash
rm -f /tmp/q-imagegen/<output_file>
```

## Help Text

When user sends `/image-edit help`:

```
*Image Editing*

Send an image, then:

*Free operations:*
/image-edit resize 1200x630
/image-edit compress 80
/image-edit crop 16:9
/image-edit convert webp
/image-edit info

*AI operations (~$0.04 each):*
/image-edit remove-bg
/image-edit ai "your edit instructions"

Smart defaults — just say "resize" or "compress" without args and reasonable defaults are applied based on the image.

AI edit prompts are automatically enhanced for better results. "remove the person" becomes a detailed instruction about seamless background fill.

_Crop presets: square, portrait, landscape, story, banner_
_Formats: png, jpg, webp, gif_
```
