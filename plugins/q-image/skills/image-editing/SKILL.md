---
name: image-editing
description: "Use when editing, resizing, compressing, cropping, converting, or modifying images. Triggers on: resize image, make image smaller, compress photo, change image size, edit this image, modify this picture, scale image, crop photo, remove background, change format, image dimensions, make it wider, make it taller, reduce file size, optimize image, image too big, shrink image, enlarge image, upscale image"
---

# Image Editing Skill

When a user sends an image with a freeform editing request (not using `/image-edit` explicitly), this skill guides you through the process.

## Step 1: Identify the Source Image

Look for `[Image: /path/to/file]` in the current or recent messages. This is the file path on disk.

If no image is found, ask the user to send one first.

## Step 2: Interpret the Request

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
| "remove the background" | remove-bg | OpenAI (~$0.04) |
| "change the sky to sunset" | ai edit | OpenAI (~$0.04+) |
| "add text saying X" | ai edit | OpenAI (~$0.04+) |
| "remove the watermark" | ai edit | OpenAI (~$0.04+) |
| "make it look vintage" | ai edit | OpenAI (~$0.04+) |

## Step 3: Choose the Right Tool

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

## Step 4: Execute

Use the image-tools.py utility for Pillow operations:
```bash
python3 ~/.claude/plugins/q-image/tools/image-tools.py <operation> <input> <output> [args]
```

For OpenAI edits, call the API:
```python
from openai import OpenAI
client = OpenAI()
response = client.images.edit(
    model="gpt-image-1",
    image=open(source_path, "rb"),
    prompt="<edit instruction>",
    size="1024x1024",
    quality="high",
    n=1
)
```

## Step 5: Deliver

1. Save output to `/tmp/q-imagegen/<uuid>.<ext>`
2. Send via `send_media` with a brief caption describing what was done
3. Clean up temp file after send

## Common Workflows

### "Make this smaller for WhatsApp"
1. Get info -> check current size
2. If > 1MB: compress to quality 75 as JPEG
3. If still > 1MB: also resize to max 1280px on longest side
4. Send result

### "Resize for social media"
Common sizes:
- Instagram post: 1080x1080
- Instagram story: 1080x1920
- Facebook cover: 820x312
- Twitter header: 1500x500
- LinkedIn banner: 1584x396
- YouTube thumbnail: 1280x720

### "Optimize for web"
1. Convert to WEBP
2. Compress to quality 80
3. Resize if > 2000px on any side
4. Report: original size -> new size, savings percentage
