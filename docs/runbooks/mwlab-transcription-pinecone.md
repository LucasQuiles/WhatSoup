# mwlab Transcription and Pinecone Setup

## Pinecone key in the dedicated keychain

Store or update the Pinecone key in the mwlab dedicated keychain:

```bash
security add-generic-password -U \
  -k ~/.config/mwlab-secrets.keychain-db \
  -a mw \
  -s pinecone \
  -w 'pcsk_...'
```

Verify wrapper injection without printing the secret:

```bash
~/.local/bin/with-pinecone-env python3 - <<'PY'
import os
print('PINECONE_ENV_OK' if os.environ.get('PINECONE_API_KEY') else 'PINECONE_ENV_MISSING')
PY
```

## Launch agent wrapper

Keep `/Users/mw/.local/bin/with-pinecone-env` as the first `ProgramArguments` entry in `~/Library/LaunchAgents/com.whatsoup.mw-bot.plist`.

Reload after edits:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.whatsoup.mw-bot.plist >/dev/null 2>&1 || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.whatsoup.mw-bot.plist
```

## Instance config

`~/.config/whatsoup/instances/mw-bot/config.json` should keep:

```json
"pineconeIndex": "mw-mind"
```

Leave `pineconeAllowedIndexes` absent until `mw-mind` has a defined schema and should be exposed through `knowledge_search`.

## Local transcription bootstrap

Run from the deployment worktree:

```bash
cd ~/LAB/WhatSoup/.worktrees/docker
bash scripts/install-transcription-deps.sh
```

This installs:
- Homebrew `ffmpeg`
- Homebrew `whisper-cpp`
- Homebrew `python@3.12`
- dedicated venv at `~/.local/share/whatsoup/transcription-venv`
- faster-whisper cache under `~/.local/share/whatsoup/models/faster-whisper`
- whisper.cpp model at `~/.local/share/whatsoup/models/whisper.cpp/ggml-small.bin`

## Open item

OpenAI L1 transcription is still pending live verification on mwlab because `OPENAI_API_KEY` is not configured there yet.
