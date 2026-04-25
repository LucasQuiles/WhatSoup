# Image Generation & Editing Tools for Q Agent

**Date:** 2026-04-24
**Status:** Approved
**Scope:** Claude Code plugin adding image generation and editing to Q's WhatsApp agent

## Objective

Add image generation (text-to-image) and image editing (resize, compress, crop, convert, AI-powered edits) capabilities to Q via WhatsApp commands. Strict command-only invocation — no ambient or auto-triggered generation.

## Components

### 1. Plugin: `q-image`

```
~/.claude/plugins/q-image/
├── .claude-plugin/
│   └── plugin.json
├── commands/
│   ├── image.md            # /image and /image-hd commands
│   └── image-edit.md       # /image-edit command
├── skills/
│   └── image-editing/
│       └── SKILL.md         # Freeform image editing guidance
└── tools/
    └── image-tools.py       # Pillow CLI wrapper for mechanical ops
```

### 2. `/image` Command — Text-to-Image Generation

**Trigger:** `/image <prompt>` or `/image-hd <prompt>`

**Models:**
| Command | Model | Quality | Cost/image |
|---------|-------|---------|------------|
| `/image` | gpt-image-1-mini | low | $0.005 |
| `/image-hd` | gpt-image-1 | high | $0.167 |

**Output:** 1024x1024 PNG, sent via `send_media` with prompt as caption.

**Flow:**
1. Parse command — extract prompt text after `/image` or `/image-hd`
2. Check rate limit — query SQLite: `SELECT COUNT(*) FROM messages WHERE conversation_key = '{chat_jid}' AND timestamp > {now - 3600} AND content LIKE '/image%' AND is_from_me = 0`. If >= 10, return rate limit error.
3. Send acknowledgment — text message: "Generating your image..."
4. Send typing indicator — `send_typing(chat_jid, 'composing')`
5. Call OpenAI API:
   ```python
   response = client.images.generate(
       model="gpt-image-1-mini",  # or "gpt-image-1" for /image-hd
       prompt=prompt,
       size="1024x1024",
       quality="low",  # or "high" for /image-hd
       n=1
   )
   ```
6. Decode base64 response → save to `/tmp/q-imagegen/{uuid}.png`
7. Send image via `send_media` with prompt as caption
8. Clean up temp file after send

**Help:** `/image help` returns usage text:
```
*/image* — Generate an image

/image <description> — standard quality ($0.005)
/image-hd <description> — high quality ($0.17)
/image help — this message

_Example: /image a cat in a spacesuit floating in space_
```

### 3. `/image-edit` Command — Image Editing

**Trigger:** `/image-edit <operation> [args]`

User sends an image (or references a recent image), then `/image-edit <operation>`.

**Operations:**

| Operation | Tool | Cost | Syntax |
|-----------|------|------|--------|
| `resize <WxH>` | Pillow | Free | `/image-edit resize 1200x630` |
| `compress <quality>` | Pillow | Free | `/image-edit compress 80` (JPEG quality 1-100) |
| `crop <ratio>` | Pillow | Free | `/image-edit crop 16:9` or `/image-edit crop 500x500+100+50` |
| `convert <format>` | Pillow | Free | `/image-edit convert webp` |
| `info` | Pillow | Free | `/image-edit info` (returns dimensions, format, file size) |
| `remove-bg` | OpenAI | ~$0.04 | `/image-edit remove-bg` |
| `ai <prompt>` | OpenAI | ~$0.04+ | `/image-edit ai "make the sky sunset orange"` |

**Image Resolution — How the command finds the image to edit:**
1. If the message contains an attached image → use that image
2. If no attachment → scan the last 20 messages in conversation context for the most recent `[Image: /path]` entry
3. If no image found → return error: "No image found. Send an image first, then use /image-edit."

**AI Edit Flow (via OpenAI):**
```python
response = client.images.edit(
    model="gpt-image-1",
    image=open(source_path, "rb"),
    prompt=edit_prompt,
    size="1024x1024",
    quality="high",
    n=1
)
```

**Help:** `/image-edit help` returns:
```
*/image-edit* — Edit an image

Send an image, then:
/image-edit resize 1200x630
/image-edit compress 80
/image-edit crop 16:9
/image-edit convert webp
/image-edit info
/image-edit remove-bg
/image-edit ai "your edit instructions"

_Resize, compress, crop, convert are free. AI edits cost ~$0.04._
```

### 4. Image Editing Skill

**Purpose:** Guide Q when users send freeform image editing requests (not explicit `/image-edit` commands).

**Trigger phrases in description:** "resize image", "make image smaller", "compress photo", "change image size", "edit this image", "modify this picture", "scale image", "crop photo"

**Skill content teaches Q to:**
- Identify the operation type from natural language
- Map vague requests to specific operations ("make it smaller" → compress + resize)
- Find the image path from `[Image: /path]` in recent messages
- Choose Pillow (free) vs OpenAI (paid) based on operation type
- Execute via `image-tools.py` or OpenAI API
- Send result via `send_media`

### 5. Python Utility: `image-tools.py`

CLI wrapper around Pillow for mechanical image operations. Single entry point, subcommands:

```bash
python3 image-tools.py resize <input> <WxH> <output> [--keep-aspect]
python3 image-tools.py compress <input> <output> <quality:1-100>
python3 image-tools.py crop <input> <output> <spec>  # "16:9" or "500x500+100+50"
python3 image-tools.py convert <input> <output>       # format inferred from output extension
python3 image-tools.py info <input>                    # JSON output: {width, height, format, size_bytes, mode}
```

**Dependencies:** `Pillow>=12.0`, `pillow-heif>=0.18.0`

**Format support:** PNG, JPEG, WEBP, GIF, BMP, TIFF, HEIC/HEIF (via pillow-heif)

**Behavior:**
- `resize` preserves aspect ratio by default (fits within WxH). Use `--stretch` to force exact dimensions.
- `compress` outputs JPEG by default. If input is PNG with transparency, outputs WEBP instead.
- `crop` with ratio (e.g., `16:9`) centers the crop. With explicit coords (`WxH+X+Y`), crops from position.
- `convert` infers target format from output file extension.
- `info` outputs JSON to stdout for easy parsing.
- All operations preserve EXIF orientation metadata.
- Exit code 0 on success, 1 on error with stderr message.

## Error Handling

| Condition | Error Message (WhatsApp) |
|-----------|-------------------------|
| Content policy rejection | "I can't generate that image. Please try a different description." |
| Rate limit (10/hr) | "You've hit your hourly limit (10 images). Try again in an hour." |
| API key missing | "Image generation isn't set up. Contact admin." |
| API timeout (>60s) | "That took too long. Try a simpler prompt." |
| Server error (500/503) | "Service hiccup. Try again in a moment." |
| Unsupported format | "That format isn't supported for editing. Use PNG, JPG, or WEBP." |
| Image too large (>50MB) | "Image is too big. Use something under 50MB." |
| Empty prompt | "What should I generate? Add a description after /image." |
| No image for editing | "No image found. Send an image first, then use /image-edit." |

## Rate Limiting

**Method:** Query WhatSoup SQLite messages table.

```sql
SELECT COUNT(*) FROM messages
WHERE conversation_key = ?
  AND timestamp > (strftime('%s', 'now') - 3600)
  AND content LIKE '/image%'
  AND is_from_me = 0
```

**Limit:** 10 image generation requests per hour per chat. Image editing (Pillow-based) operations are not rate limited.

**Implementation:** The `/image` command checks this count before calling the OpenAI API. If >= 10, return the rate limit error message. No external state needed — the messages table is the source of truth.

## UX Flow

### Generation
```
User: /image a cat in a spacesuit
Q:    "Generating your image..."        ← instant text reply
Q:    [typing indicator: composing]     ← shows "typing..."
      [8-15 seconds pass]
Q:    [sends image with caption]        ← image arrives
```

### Editing (structured)
```
User: [sends image]
User: /image-edit resize 800x600
Q:    [processes via Pillow, <1 second]
Q:    [sends resized image]
```

### Editing (freeform, via skill)
```
User: [sends image]
User: "Can you make this wider and remove the text?"
Q:    [skill activates, identifies: extend + inpaint]
Q:    "Editing your image..."
Q:    [calls OpenAI edit API]
Q:    [sends edited image]
```

## Security

- **Command-only invocation** — no ambient image generation from conversation context
- **OpenAI content filtering** — built-in safety system rejects policy-violating prompts
- **Rate limiting** — 10/hr per chat prevents cost abuse
- **Temp file cleanup** — generated images in `/tmp/q-imagegen/` cleaned after send; downloaded media in `media/tmp/` auto-cleaned at 72h
- **No user-controlled filenames** — all temp files use UUID naming
- **Prompt passthrough** — image prompts go directly to OpenAI API, not interpreted as agent instructions

## Dependencies

| Dependency | Status | Action |
|------------|--------|--------|
| OpenAI API key | Installed (OPENAI_API_KEY env var) | None |
| Pillow 12.1.0 | Installed | None |
| pillow-heif | Not installed | `pip install pillow-heif` |
| libheif | Installed (system packages) | None |
| ImageMagick | Installed | None (fallback only) |
| WhatSoup send_media | Available | None |
| WhatSoup send_typing | Available | None |
| WhatSoup download_media | Available | None |

## File Manifest

| File | Purpose |
|------|---------|
| `~/.claude/plugins/q-image/.claude-plugin/plugin.json` | Plugin metadata |
| `~/.claude/plugins/q-image/commands/image.md` | `/image` and `/image-hd` command |
| `~/.claude/plugins/q-image/commands/image-edit.md` | `/image-edit` command |
| `~/.claude/plugins/q-image/skills/image-editing/SKILL.md` | Freeform image editing skill |
| `~/.claude/plugins/q-image/tools/image-tools.py` | Pillow CLI wrapper |

## Out of Scope

- Multi-provider routing (only OpenAI)
- Video generation
- Batch image generation
- Image storage/gallery
- Style presets or LoRA models
- Background removal as standalone (only via AI edit)
