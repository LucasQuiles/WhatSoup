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

### compress <quality:1-100>
```bash
python3 ~/.claude/plugins/q-image/tools/image-tools.py compress "$SOURCE_IMAGE" "/tmp/q-imagegen/$(uuidgen).jpg" <quality>
```
Send the output file. Quality 1-100 (higher = better quality, larger file).

### crop <spec>
Spec can be a ratio (`16:9`, `1:1`, `4:3`) or explicit (`WxH+X+Y`).
```bash
python3 ~/.claude/plugins/q-image/tools/image-tools.py crop "$SOURCE_IMAGE" "/tmp/q-imagegen/$(uuidgen).png" "<spec>"
```
Send the output file.

### convert <format>
Format: `png`, `jpg`, `webp`, `gif`
```bash
python3 ~/.claude/plugins/q-image/tools/image-tools.py convert "$SOURCE_IMAGE" "/tmp/q-imagegen/$(uuidgen).<format>"
```
Send the output file.

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

Then call OpenAI. IMPORTANT: Pass source path via environment variable — NEVER interpolate paths into Python source:
```bash
IMG_SOURCE='<SOURCE_IMAGE>' python3 << 'PY'
import base64, json, os, sys, uuid
from openai import OpenAI

client = OpenAI()
source = os.environ["IMG_SOURCE"]

try:
    with open(source, "rb") as f:
        response = client.images.edit(
            model="gpt-image-1",
            image=f,
            prompt="Remove the background completely, make it transparent. Keep the foreground subject exactly as-is.",
            size="1024x1024",
            quality="high",
            n=1
        )
    outdir = "/tmp/q-imagegen"
    os.makedirs(outdir, exist_ok=True)
    outpath = os.path.join(outdir, f"{uuid.uuid4().hex}.png")
    with open(outpath, "wb") as f:
        f.write(base64.b64decode(response.data[0].b64_json))
    print(json.dumps({"ok": True, "path": outpath}))
except Exception as e:
    err = str(e)
    if "content_policy" in err or "safety" in err.lower():
        print(json.dumps({"ok": False, "error": "content_policy"}))
    elif "401" in err:
        print(json.dumps({"ok": False, "error": "auth"}))
    else:
        print(json.dumps({"ok": False, "error": "server", "detail": err[:200]}))
    sys.exit(1)
PY
```
Send the output via `send_media`. Handle errors using the same mapping as `/image`.

### ai "<prompt>"
First send acknowledgment: "Editing your image..." and typing indicator.

Then call OpenAI. IMPORTANT: Pass source path AND edit prompt via environment variables — NEVER interpolate user text into Python source:
```bash
IMG_SOURCE='<SOURCE_IMAGE>' EDIT_PROMPT='<USER_EDIT_PROMPT>' python3 << 'PY'
import base64, json, os, sys, uuid
from openai import OpenAI

client = OpenAI()
source = os.environ["IMG_SOURCE"]
edit_prompt = os.environ["EDIT_PROMPT"]

try:
    with open(source, "rb") as f:
        response = client.images.edit(
            model="gpt-image-1",
            image=f,
            prompt=edit_prompt,
            size="1024x1024",
            quality="high",
            n=1
        )
    outdir = "/tmp/q-imagegen"
    os.makedirs(outdir, exist_ok=True)
    outpath = os.path.join(outdir, f"{uuid.uuid4().hex}.png")
    with open(outpath, "wb") as f:
        f.write(base64.b64decode(response.data[0].b64_json))
    print(json.dumps({"ok": True, "path": outpath}))
except Exception as e:
    err = str(e)
    if "content_policy" in err or "safety" in err.lower():
        print(json.dumps({"ok": False, "error": "content_policy"}))
    elif "401" in err:
        print(json.dumps({"ok": False, "error": "auth"}))
    else:
        print(json.dumps({"ok": False, "error": "server", "detail": err[:200]}))
    sys.exit(1)
PY
```
Send the output via `send_media` with the edit prompt as caption. Handle errors using the same mapping as `/image`.

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
/image-edit resize 1200x630
/image-edit compress 80
/image-edit crop 16:9
/image-edit convert webp
/image-edit info
/image-edit remove-bg
/image-edit ai "your edit instructions"

_Resize, compress, crop, convert, info are free._
_AI edits and remove-bg cost ~$0.04 each._
```
