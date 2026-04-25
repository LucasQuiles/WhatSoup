# q-image Plugin

Image generation and editing plugin for WhatSoup agent-mode instances. Provides `/image` and `/image-edit` slash commands over WhatsApp, powered by OpenAI's image models and Pillow for local operations.

## What It Does

- **Text-to-image generation** via OpenAI gpt-image-1 / gpt-image-1-mini models
- **Local image editing** via Pillow (resize, compress, crop, convert, info) -- free and instant
- **AI-powered image editing** via OpenAI (background removal, content-aware edits, style changes)
- **Freeform editing skill** that interprets natural language image requests

## Commands

### `/image <prompt>`

Generate a standard-quality image from a text description.

```
/image a cat in a spacesuit floating through a nebula
```

### `/image-hd <prompt>`

Generate a high-quality image from a text description.

```
/image-hd photorealistic mountain landscape at golden hour
```

### `/image-edit <operation> [args]`

Edit an image. Send an image first, then use one of these operations:

| Operation | Example | Cost |
|-----------|---------|------|
| `resize <WxH>` | `/image-edit resize 1200x630` | Free |
| `compress <quality>` | `/image-edit compress 80` | Free |
| `crop <ratio or WxH+X+Y>` | `/image-edit crop 16:9` | Free |
| `convert <format>` | `/image-edit convert webp` | Free |
| `info` | `/image-edit info` | Free |
| `remove-bg` | `/image-edit remove-bg` | ~$0.04 |
| `ai "<instructions>"` | `/image-edit ai "make the sky orange"` | ~$0.04 |

All commands support `/image-edit help` for inline usage reference.

## Cost Model

| Command | Model | Cost per image |
|---------|-------|---------------|
| `/image` | gpt-image-1-mini | ~$0.005 |
| `/image-hd` | gpt-image-1 | ~$0.17 |
| `/image-edit ai` | gpt-image-1 (edit) | ~$0.04 |
| `/image-edit remove-bg` | gpt-image-1 (edit) | ~$0.04 |
| Pillow operations | Local (resize, compress, crop, convert, info) | Free |

## Rate Limiting

- **10 image generation requests per hour per chat**
- Checked by querying the WhatSoup SQLite messages table for `/image` commands in the last hour
- Pillow-based editing operations (resize, compress, crop, convert, info) are not rate limited

## Dependencies

| Package | Required | Purpose |
|---------|----------|---------|
| `openai` | Yes | Image generation and AI editing API |
| `Pillow` (>=12.0) | Yes | Local image manipulation |
| `pillow-heif` (>=0.18.0) | Optional | HEIC/HEIF format support |

The OpenAI API key must be available as the `OPENAI_API_KEY` environment variable.

## Security

- **Command-only invocation** -- images are only generated when explicitly requested via `/image` or `/image-hd`; no ambient generation from conversation context
- **Prompt injection prevention** -- user prompts are passed via environment variables, never interpolated into Python source code
- **Content policy filtering** -- OpenAI's built-in safety system rejects policy-violating prompts, with clear error messages returned to the user
- **Temp file cleanup** -- all generated images use UUID filenames in `/tmp/q-imagegen/` and are deleted after sending, regardless of success or failure
- **No user-controlled filenames** -- prevents path traversal attacks

## Installation

This plugin is auto-loaded by Claude Code agent-mode instances when placed in the plugins directory. No manual installation steps are required beyond ensuring the dependencies are available in the Python environment.

Plugin structure:

```
plugins/q-image/
├── .claude-plugin/
│   └── plugin.json           # Plugin metadata
├── commands/
│   ├── image.md              # /image and /image-hd commands
│   └── image-edit.md         # /image-edit command
├── skills/
│   └── image-editing/
│       └── SKILL.md          # Freeform image editing skill
├── tools/
│   └── image-tools.py        # Pillow CLI wrapper
└── README.md                 # This file
```
