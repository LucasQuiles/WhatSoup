---
name: image
description: "Generate an image from a text prompt using OpenAI. Use /image <prompt> for standard quality or /image-hd <prompt> for high quality."
argument-hint: "<prompt> or 'help'"
allowed-tools: ["Bash", "Read", "Write", "mcp__whatsoup__send_media", "mcp__whatsoup__send_typing", "mcp__whatsoup__search_chat_messages"]
---

# /image — Text-to-Image Generation

## Parse the Command

The full input text is the command as typed. Parse it:

1. If the input is `/image help` or `/image-hd help` → show the help text below and stop.
2. If the input is `/image` or `/image-hd` with no prompt → reply: "What should I generate? Add a description after /image." and stop.
3. Determine the model:
   - `/image-hd <prompt>` → model: `gpt-image-1`, quality: `high`, cost ~$0.167
   - `/image <prompt>` → model: `gpt-image-1-mini`, quality: `low`, cost ~$0.005
4. Extract the prompt: everything after `/image ` or `/image-hd `.

## Prompt Enhancement

Before sending the prompt to the API, enhance it to produce better results. The user's raw prompt is often terse — your job is to expand it into a rich, specific description while preserving the user's intent.

### Enhancement Rules

1. **Preserve intent** — never change what the user asked for. "A cat" must still be about a cat.
2. **Add specificity** — fill in details the user left vague (lighting, setting, mood, color palette).
3. **Add structure** — describe foreground, midground, background when relevant.
4. **Style anchors** — if no style is implied, default to "photorealistic, high detail". If a style IS implied (cartoon, watercolor, etc.), lean into it.
5. **Lighting** — always specify lighting. Natural light, studio lighting, golden hour, dramatic shadows, etc.
6. **Composition** — mention framing: close-up, wide shot, overhead, eye-level, centered, rule of thirds.
7. **Materials and textures** — when relevant, describe surfaces: glossy, matte, rough, smooth, metallic, organic.
8. **Text handling** — if the user wants text in the image, wrap it in quotes and mention font style/placement.
9. **Length limit** — keep the enhanced prompt under 200 words. Quality over quantity.

### Style Keywords Reference

| Category | Keywords |
|----------|----------|
| Photographic | photorealistic, DSLR, 85mm lens, shallow depth of field, bokeh, film grain, RAW photo |
| Artistic | digital painting, oil painting, watercolor, pencil sketch, vector art, pixel art, studio ghibli style |
| Lighting | golden hour, blue hour, dramatic rim lighting, soft diffused light, neon glow, chiaroscuro, backlit |
| Composition | close-up portrait, wide establishing shot, bird's eye view, macro photography, symmetrical, dutch angle |
| Rendering | octane render, unreal engine, ray tracing, 4K, ultra detailed, sharp focus, cinematic |

### Enhancement Examples

| User Input | Enhanced Prompt |
|-----------|----------------|
| a cat | A fluffy orange tabby cat lounging on a sunlit windowsill, soft afternoon light streaming through sheer curtains, shallow depth of field with bokeh highlights, photorealistic, warm color palette, 85mm portrait lens |
| robot with a solo cup | A humanoid robot with brushed steel plating sitting casually at a house party, holding a red Solo cup, warm indoor lighting with colorful party lights in the background, photorealistic, slight motion blur on dancing figures behind, eye-level shot |
| company logo for TechFlow | A modern minimalist logo design for "TechFlow" on a clean white background, featuring flowing blue gradient lines forming an abstract T shape, sans-serif typography, vector art style, sharp edges, professional corporate aesthetic |
| sunset | A breathtaking ocean sunset with layers of orange, magenta, and deep purple clouds reflected in calm water, silhouette of distant sailboat on the horizon, wide panoramic composition, golden hour photography, high dynamic range |
| a birthday cake | An elaborate three-tier birthday cake with smooth buttercream frosting in pastel rainbow layers, topped with golden sparklers and fresh strawberries, sitting on a marble countertop, soft studio lighting, close-up food photography, shallow depth of field |

### Size Selection

Choose size based on the prompt content:
- **Square (1024x1024)** — default, good for most subjects, portraits, objects
- **Portrait (1024x1536)** — full-body figures, tall buildings, vertical scenes
- **Landscape (1536x1024)** — panoramas, wide scenes, group shots, landscapes

### What NOT to Add

- Negative prompts (the API doesn't support them)
- Specific artist names (ethical concern)
- Celebrities or real people by name
- Overly technical parameters (CFG scale, steps, etc.)

## Rate Limit Check

Before generating, check if the chat has exceeded the hourly limit. You need the conversation key (chat JID) from the message context.

Use Bash to query the WhatSoup database (parameterized to prevent SQL injection):
```bash
python3 -c "
import sqlite3, time, sys, os
db = sqlite3.connect(os.path.expanduser('~/.local/share/whatsoup/instances/q/bot.db'))
count = db.execute('SELECT COUNT(*) FROM messages WHERE conversation_key = ? AND timestamp > ? AND content LIKE ? AND is_from_me = 0', (sys.argv[1], int(time.time()) - 3600, '/image%')).fetchone()[0]
print(count)" '<CHAT_JID>'
```

If the count is >= 10, reply: "You've hit your hourly limit (10 images). Try again in an hour." and stop.

## Generate the Image

1. **Send acknowledgment** — reply to the user: "Generating your image..." (include a brief note about what you enhanced if the prompt changed significantly)

2. **Send typing indicator**:
   ```
   send_typing(chatJid, type: 'composing')
   ```

3. **Call OpenAI API** via Bash using curl. IMPORTANT: Pass the enhanced prompt via environment variable to prevent injection — NEVER interpolate user text into shell commands:
   ```bash
   mkdir -p /tmp/q-imagegen
   export IMG_PROMPT='<ENHANCED_PROMPT>'
   export IMG_MODEL='<MODEL>'
   export IMG_QUALITY='<QUALITY>'
   export IMG_SIZE='<SIZE>'
   export IMG_OUTPATH="/tmp/q-imagegen/$(uuidgen).png"
   bash << 'GENEOF'
   set -euo pipefail
   OKEY=$(secret-tool lookup service openai)
   RESP=$(curl -sf https://api.openai.com/v1/images/generations \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $OKEY" \
     -d "$(python3 -c "
import json, os
print(json.dumps({
    'model': os.environ['IMG_MODEL'],
    'prompt': os.environ['IMG_PROMPT'],
    'size': os.environ.get('IMG_SIZE', '1024x1024'),
    'quality': os.environ['IMG_QUALITY'],
    'n': 1,
    'output_format': 'b64_json'
}))")")
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
   GENEOF
   ```

4. **Handle the result:**
   - If `ok: true` → send the image via `send_media` with the original user prompt as caption, then delete the temp file.
   - If `error: content_policy` → reply: "I can't generate that image. Please try a different description."
   - If `error: rate_limit` → reply: "Service is busy. Try again in a moment."
   - If `error: auth` or `invalid_api_key` → reply: "Image generation isn't set up. Contact admin."
   - If `error: timeout` → reply: "That took too long. Try a simpler prompt."
   - If `error: server` → reply: "Service hiccup. Try again in a moment."

5. **Clean up** — ALWAYS delete the temp file, regardless of whether send succeeded or failed:
   ```bash
   rm -f /tmp/q-imagegen/<file>.png
   ```

## Help Text

When the user sends `/image help`:

```
*Image Generation*

/image <description> — standard quality (~$0.005)
/image-hd <description> — high quality (~$0.17)
/image help — this message

Your prompt is automatically enhanced for better results. A simple "a cat" becomes a rich, detailed scene description. You can be brief or detailed — either works.

Limit: 10 images per hour per chat.

_Tips:_
- _Be specific about style: "watercolor painting of..." or "pixel art of..."_
- _Mention mood/lighting: "dramatic", "warm", "neon-lit"_
- _For text in images: include the exact words you want_
- _For logos: mention style (minimalist, vintage, etc.) and colors_

_Example: /image a cat in a spacesuit floating through a nebula_
```
