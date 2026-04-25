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

## Rate Limit Check

Before generating, check if the chat has exceeded the hourly limit. You need the conversation key (chat JID) from the message context.

Use Bash to query the WhatSoup database (parameterized to prevent SQL injection):
```bash
python3 -c "
import sqlite3, time, sys
db = sqlite3.connect(os.path.expanduser('~/.local/share/whatsoup/instances/q/bot.db'))
count = db.execute('SELECT COUNT(*) FROM messages WHERE conversation_key = ? AND timestamp > ? AND content LIKE ? AND is_from_me = 0', (sys.argv[1], int(time.time()) - 3600, '/image%')).fetchone()[0]
print(count)
import os" '<CHAT_JID>'
```

If the count is >= 10, reply: "You've hit your hourly limit (10 images). Try again in an hour." and stop.

## Generate the Image

1. **Send acknowledgment** — reply to the user: "Generating your image..."

2. **Send typing indicator**:
   ```
   send_typing(chatJid, type: 'composing')
   ```

3. **Call OpenAI API** via Bash. IMPORTANT: Pass the prompt via environment variable to prevent injection — NEVER interpolate user text into Python source:
   ```bash
   IMG_PROMPT='<THE_PROMPT>' IMG_MODEL='<MODEL>' IMG_QUALITY='<QUALITY>' python3 << 'PYEOF'
   import base64, json, os, sys, uuid
   from openai import OpenAI

   client = OpenAI()
   prompt = os.environ["IMG_PROMPT"]
   model = os.environ.get("IMG_MODEL", "gpt-image-1-mini")
   quality = os.environ.get("IMG_QUALITY", "low")

   try:
       response = client.images.generate(
           model=model,
           prompt=prompt,
           size="1024x1024",
           quality=quality,
           n=1
       )
       image_b64 = response.data[0].b64_json
       outdir = "/tmp/q-imagegen"
       os.makedirs(outdir, exist_ok=True)
       outpath = os.path.join(outdir, f"{uuid.uuid4().hex}.png")
       with open(outpath, "wb") as f:
           f.write(base64.b64decode(image_b64))
       print(json.dumps({"ok": True, "path": outpath}))
   except Exception as e:
       err = str(e)
       if "content_policy" in err or "safety" in err.lower():
           print(json.dumps({"ok": False, "error": "content_policy"}))
       elif "rate_limit" in err or "429" in err:
           print(json.dumps({"ok": False, "error": "rate_limit"}))
       elif "401" in err or "invalid_api_key" in err:
           print(json.dumps({"ok": False, "error": "auth"}))
       elif "timeout" in err.lower():
           print(json.dumps({"ok": False, "error": "timeout"}))
       else:
           print(json.dumps({"ok": False, "error": "server", "detail": err[:200]}))
           sys.exit(1)
   PYEOF
   ```

4. **Handle the result:**
   - If `ok: true` → send the image via `send_media` with the prompt as caption, then delete the temp file.
   - If `error: content_policy` → reply: "I can't generate that image. Please try a different description."
   - If `error: rate_limit` → reply: "Service is busy. Try again in a moment."
   - If `error: auth` → reply: "Image generation isn't set up. Contact admin."
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

Limit: 10 images per hour per chat.

_Example: /image a cat in a spacesuit floating through a nebula_
```
