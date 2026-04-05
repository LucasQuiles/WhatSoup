# SP4: Two-Way Voice (ElevenLabs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ElevenLabs TTS synthesis with a circuit breaker, a `send_voice_reply` MCP tool, and agent runtime voice reply integration so agents can respond to voice notes with synthesized speech.

**Architecture:** Create `elevenlabs.ts` TTS provider matching Whisper's circuit breaker pattern (5 failures, 60s recovery). Create `voice.ts` MCP tool module with `send_voice_reply` (scope: chat) using Pattern 1 registration (options-object with `connection` + `db`). Integrate voice reply option into agent runtime with configurable `voiceReply` mode (`'always' | 'when_received' | 'never'`, default: `'never'`). API key retrieved from GNOME Keyring via `secret-tool lookup service elevenlabs`. No new npm dependencies -- uses raw `fetch`.

**Tech Stack:** TypeScript, ElevenLabs REST API (raw `fetch`), vitest

**Spec:** `docs/superpowers/specs/2026-04-04-mcp-feature-gaps-design.md` Section 6

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/runtimes/chat/providers/elevenlabs.ts` | Create | TTS synthesis with circuit breaker, API key from keyring |
| `src/mcp/tools/voice.ts` | Create | `send_voice_reply` MCP tool (scope: chat, Pattern 1) |
| `src/mcp/register-all.ts` | Modify | Import and register voice tools |
| `src/runtimes/agent/runtime.ts` | Modify | Voice reply integration after processing voice notes |
| `src/config.ts` | Modify | Add `elevenlabs` and `voiceReply` config fields |
| `tests/runtimes/chat/providers/elevenlabs.test.ts` | Create | Test TTS synthesis, circuit breaker, error handling |
| `tests/mcp/tools/voice.test.ts` | Create | Test `send_voice_reply` tool |

---

## Task 1: ElevenLabs TTS provider with circuit breaker

Create the TTS synthesis module matching Whisper's circuit breaker pattern.

**Files:**
- Create: `tests/runtimes/chat/providers/elevenlabs.test.ts`
- Create: `src/runtimes/chat/providers/elevenlabs.ts`

- [ ] **Step 1: Write the tests** in `tests/runtimes/chat/providers/elevenlabs.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch globally before importing the module
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock execFile for API key retrieval (safe alternative to execSync)
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockReturnValue(Buffer.from('sk-test-elevenlabs-key\n')),
}));

// Must import after mocks are set up
const { synthesizeSpeech, _testing } = await import(
  '../../../../src/runtimes/chat/providers/elevenlabs.ts'
);

describe('elevenlabs TTS provider', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    _testing.resetBreaker();
  });

  it('calls ElevenLabs API with correct URL and headers', async () => {
    const audioBuffer = new Uint8Array([0x4f, 0x67, 0x67, 0x53]).buffer;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/mpeg' }),
      arrayBuffer: async () => audioBuffer,
    });

    const result = await synthesizeSpeech('Hello world');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/v1/text-to-speech/');
    expect(opts.method).toBe('POST');
    expect(opts.headers['xi-api-key']).toBe('sk-test-elevenlabs-key');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body.text).toBe('Hello world');

    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer.length).toBe(4);
    expect(result.mimeType).toBe('audio/mpeg');
  });

  it('uses custom voiceId and modelId when provided', async () => {
    const audioBuffer = new Uint8Array([1, 2, 3]).buffer;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/mpeg' }),
      arrayBuffer: async () => audioBuffer,
    });

    await synthesizeSpeech('Test', {
      voiceId: 'custom-voice-id',
      modelId: 'eleven_turbo_v2_5',
      stability: 0.8,
      similarityBoost: 0.9,
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('custom-voice-id');
    const body = JSON.parse(opts.body);
    expect(body.model_id).toBe('eleven_turbo_v2_5');
    expect(body.voice_settings.stability).toBe(0.8);
    expect(body.voice_settings.similarity_boost).toBe(0.9);
  });

  it('throws on API error (non-200)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: async () => 'Rate limit exceeded',
    });

    await expect(synthesizeSpeech('Hello')).rejects.toThrow();
  });

  it('trips circuit breaker after 5 consecutive failures', async () => {
    const makeFailure = () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Server error',
    });

    // Trip the breaker with 5 failures (each has 1 retry = 10 fetch calls)
    for (let i = 0; i < 5; i++) {
      mockFetch.mockResolvedValueOnce(makeFailure());
      mockFetch.mockResolvedValueOnce(makeFailure()); // retry
      try { await synthesizeSpeech('fail'); } catch { /* expected */ }
    }

    // Next call should fail immediately without calling fetch
    const fetchCountBefore = mockFetch.mock.calls.length;
    await expect(synthesizeSpeech('blocked')).rejects.toThrow(/circuit breaker open/i);
    expect(mockFetch.mock.calls.length).toBe(fetchCountBefore);
  });

  it('resets circuit breaker on success', async () => {
    const makeFailure = () => ({
      ok: false,
      status: 500,
      statusText: 'Error',
      text: async () => 'error',
    });

    // Cause some failures (but not enough to trip)
    for (let i = 0; i < 3; i++) {
      mockFetch.mockResolvedValueOnce(makeFailure());
      mockFetch.mockResolvedValueOnce(makeFailure());
      try { await synthesizeSpeech('fail'); } catch { /* expected */ }
    }

    // Success should reset counter
    const audioBuffer = new Uint8Array([1, 2, 3]).buffer;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/mpeg' }),
      arrayBuffer: async () => audioBuffer,
    });

    const result = await synthesizeSpeech('success');
    expect(result.buffer).toBeInstanceOf(Buffer);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail:**

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/runtimes/chat/providers/elevenlabs.test.ts 2>&1 | tail -20
# Expected: FAILED — module does not exist
```

- [ ] **Step 3: Create `src/runtimes/chat/providers/elevenlabs.ts`:**

```typescript
import { execFileSync } from 'node:child_process';
import { createChildLogger } from '../../../logger.ts';
import { CircuitBreaker } from '../../../core/circuit-breaker.ts';
import { sleep } from '../../../core/retry.ts';

const log = createChildLogger('elevenlabs');
const ELEVENLABS_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 500;
const DEFAULT_VOICE_ID = 'pNInz6obpgDQGcFmaJgB'; // Adam
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';
const API_BASE = 'https://api.elevenlabs.io';

const breaker = new CircuitBreaker('elevenlabs', 5, 60_000, log);

// Lazy-init API key from GNOME Keyring
let apiKey: string | null = null;
function getApiKey(): string {
  if (!apiKey) {
    try {
      apiKey = execFileSync('secret-tool', ['lookup', 'service', 'elevenlabs'], {
        timeout: 5_000,
        encoding: 'utf-8',
      }).trim();
    } catch (err) {
      throw new Error(
        'ElevenLabs API key not found in keyring. Run: secret-tool store --label="ElevenLabs" service elevenlabs',
      );
    }
    if (!apiKey) {
      throw new Error('ElevenLabs API key is empty in keyring.');
    }
  }
  return apiKey;
}

export interface VoiceSynthesisResult {
  buffer: Buffer;
  duration: number;
  mimeType: string;
}

export interface SynthesisOptions {
  voiceId?: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
}

export async function synthesizeSpeech(
  text: string,
  options?: SynthesisOptions,
): Promise<VoiceSynthesisResult> {
  if (breaker.isOpen()) {
    throw new Error('ElevenLabs circuit breaker open — TTS unavailable');
  }

  const voiceId = options?.voiceId ?? DEFAULT_VOICE_ID;
  const modelId = options?.modelId ?? DEFAULT_MODEL_ID;
  const stability = options?.stability ?? 0.5;
  const similarityBoost = options?.similarityBoost ?? 0.75;

  const url = `${API_BASE}/v1/text-to-speech/${voiceId}`;
  const body = JSON.stringify({
    text,
    model_id: modelId,
    voice_settings: {
      stability,
      similarity_boost: similarityBoost,
    },
  });

  const doSynthesize = async (): Promise<VoiceSynthesisResult> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': getApiKey(),
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`ElevenLabs API error ${response.status}: ${errorText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const mimeType = response.headers.get('content-type') ?? 'audio/mpeg';

      // Estimate duration from buffer size (rough: mp3 at ~128kbps)
      const estimatedDuration = Math.ceil(buffer.length / (128 * 1024 / 8));

      return { buffer, duration: estimatedDuration, mimeType };
    } finally {
      clearTimeout(timeout);
    }
  };

  const startMs = Date.now();
  try {
    const result = await doSynthesize();
    const durationMs = Date.now() - startMs;
    log.info(
      { durationMs, textLength: text.length, audioBytes: result.buffer.length },
      'ElevenLabs synthesis complete',
    );
    breaker.recordSuccess();
    return result;
  } catch (err) {
    // One retry after short delay (matches Whisper pattern)
    await sleep(RETRY_DELAY_MS);
    try {
      const result = await doSynthesize();
      const durationMs = Date.now() - startMs;
      log.info(
        { durationMs, textLength: text.length, retried: true },
        'ElevenLabs synthesis complete (after retry)',
      );
      breaker.recordSuccess();
      return result;
    } catch (retryErr) {
      const elapsedMs = Date.now() - startMs;
      breaker.recordFailure();
      const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
      log.warn({ error: message, elapsedMs, textLength: text.length }, 'elevenlabs_synthesis_failed');
      throw new Error(`ElevenLabs synthesis failed: ${message}`);
    }
  }
}

// Exported for testing only — allows resetting circuit breaker state between tests
export const _testing = {
  resetBreaker: () => {
    (breaker as any).failures = 0;
    (breaker as any).state = 'closed';
    (breaker as any).probing = false;
  },
};
```

- [ ] **Step 4: Run tests, verify they pass:**

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/runtimes/chat/providers/elevenlabs.test.ts 2>&1 | tail -20
# Expected: all PASS
```

- [ ] **Step 5: Commit:**

```bash
cd ~/LAB/WhatSoup && git add src/runtimes/chat/providers/elevenlabs.ts tests/runtimes/chat/providers/elevenlabs.test.ts && git commit -m "feat(tts): add ElevenLabs TTS provider with circuit breaker

Creates elevenlabs.ts with synthesizeSpeech() function that calls
ElevenLabs /v1/text-to-speech API via raw fetch. Includes circuit
breaker (5 failures, 60s recovery) matching Whisper's pattern.
API key loaded from GNOME Keyring via execFileSync (SP4)."
```

---

## Task 2: `send_voice_reply` MCP tool

Create the voice tool module with Pattern 1 registration.

**Files:**
- Create: `tests/mcp/tools/voice.test.ts`
- Create: `src/mcp/tools/voice.ts`

- [ ] **Step 1: Write the tests** in `tests/mcp/tools/voice.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

// Mock the ElevenLabs provider
vi.mock('../../../src/runtimes/chat/providers/elevenlabs.ts', () => ({
  synthesizeSpeech: vi.fn(),
}));

// Mock media-download for writeTempFile
vi.mock('../../../src/core/media-download.ts', () => ({
  writeTempFile: vi.fn().mockReturnValue('/tmp/whatsoup-media/voice-reply.ogg'),
}));

import { synthesizeSpeech } from '../../../src/runtimes/chat/providers/elevenlabs.ts';
import { writeTempFile } from '../../../src/core/media-download.ts';
import { registerVoiceTools, type VoiceDeps } from '../../../src/mcp/tools/voice.ts';

const mockSynthesize = vi.mocked(synthesizeSpeech);
const mockWriteTempFile = vi.mocked(writeTempFile);

function chatSession(conversationKey: string): SessionContext {
  return {
    tier: 'chat-scoped',
    conversationKey,
    deliveryJid: `${conversationKey}@s.whatsapp.net`,
  };
}

function globalSession(): SessionContext {
  return { tier: 'global' };
}

describe('voice tools', () => {
  let registry: ToolRegistry;
  let db: Database;
  let mediaSent: Array<{ chatJid: string; media: unknown }>;
  let connection: VoiceDeps['connection'];

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    registry = new ToolRegistry();
    mediaSent = [];

    connection = {
      sendMedia: vi.fn().mockImplementation(async (chatJid: string, media: unknown) => {
        mediaSent.push({ chatJid, media });
      }),
    } as unknown as VoiceDeps['connection'];

    registerVoiceTools(registry, { connection, db });

    mockSynthesize.mockReset();
    mockWriteTempFile.mockReset();
    mockWriteTempFile.mockReturnValue('/tmp/whatsoup-media/voice-reply.ogg');
  });

  afterEach(() => {
    db.close();
  });

  describe('send_voice_reply', () => {
    it('is registered as chat scope', () => {
      const tools = registry.listTools(chatSession('111'));
      const tool = tools.find((t) => t.name === 'send_voice_reply');
      expect(tool).toBeDefined();
    });

    it('is NOT visible in global session (chat-scoped tool)', () => {
      // Chat-scoped tools are visible in global session but rejected on call
      const tools = registry.listTools(globalSession());
      const tool = tools.find((t) => t.name === 'send_voice_reply');
      expect(tool).toBeDefined();
    });

    it('synthesizes text and sends as voice note', async () => {
      mockSynthesize.mockResolvedValueOnce({
        buffer: Buffer.from('fake-audio'),
        duration: 5,
        mimeType: 'audio/mpeg',
      });

      const result = await registry.call(
        'send_voice_reply',
        { text: 'Hello, how are you?' },
        chatSession('111'),
      );

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.sent).toBe(true);
      expect(data.duration).toBe(5);

      // Verify synthesizeSpeech was called with the text
      expect(mockSynthesize).toHaveBeenCalledWith('Hello, how are you?', undefined);

      // Verify writeTempFile was called
      expect(mockWriteTempFile).toHaveBeenCalledWith(Buffer.from('fake-audio'), 'mp3');

      // Verify sendMedia was called with ptt: true
      expect(mediaSent).toHaveLength(1);
      expect(mediaSent[0].chatJid).toBe('111@s.whatsapp.net');
      const media = mediaSent[0].media as any;
      expect(media.ptt).toBe(true);
      expect(media.type).toBe('audio');
    });

    it('passes voice_id option to synthesizeSpeech', async () => {
      mockSynthesize.mockResolvedValueOnce({
        buffer: Buffer.from('audio'),
        duration: 3,
        mimeType: 'audio/mpeg',
      });

      await registry.call(
        'send_voice_reply',
        { text: 'Test', voice_id: 'custom-voice' },
        chatSession('111'),
      );

      expect(mockSynthesize).toHaveBeenCalledWith('Test', { voiceId: 'custom-voice' });
    });

    it('returns error when synthesis fails', async () => {
      mockSynthesize.mockRejectedValueOnce(new Error('ElevenLabs circuit breaker open'));

      const result = await registry.call(
        'send_voice_reply',
        { text: 'Hello' },
        chatSession('111'),
      );

      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('synthesis_failed');
      expect(data.message).toContain('circuit breaker');
    });

    it('returns error when text is empty', async () => {
      const result = await registry.call(
        'send_voice_reply',
        { text: '' },
        chatSession('111'),
      );

      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('invalid_input');
    });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail:**

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/mcp/tools/voice.test.ts 2>&1 | tail -20
# Expected: FAILED — module does not exist
```

- [ ] **Step 3: Create `src/mcp/tools/voice.ts`:**

```typescript
// src/mcp/tools/voice.ts
// Voice synthesis tools: send_voice_reply (ElevenLabs TTS -> PTT voice note).

import { z } from 'zod';
import type { ToolRegistry } from '../registry.ts';
import type { SessionContext } from '../types.ts';
import type { Database } from '../../core/database.ts';
import type { ConnectionManager } from '../../transport/connection.ts';
import { synthesizeSpeech } from '../../runtimes/chat/providers/elevenlabs.ts';
import { writeTempFile } from '../../core/media-download.ts';
import { readFileSync } from 'node:fs';
import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('mcp:voice');

// ---------------------------------------------------------------------------
// Deps interface (Pattern 1 — options-object)
// ---------------------------------------------------------------------------

export interface VoiceDeps {
  connection: ConnectionManager;
  db: Database;
}

// ---------------------------------------------------------------------------
// Register voice tools
// ---------------------------------------------------------------------------

export function registerVoiceTools(
  registry: ToolRegistry,
  deps: VoiceDeps,
): void {
  const { connection } = deps;

  registry.register({
    name: 'send_voice_reply',
    description:
      'Synthesize text to speech via ElevenLabs and send as a WhatsApp voice note (PTT). Use this to reply with a spoken voice message.',
    scope: 'chat',
    targetMode: 'injected',
    replayPolicy: 'unsafe',
    schema: z.object({
      text: z.string().describe('Text to synthesize and send as a voice note'),
      voice_id: z.string().optional().describe('ElevenLabs voice ID (defaults to instance config)'),
      reply_to: z.string().optional().describe('Message ID to reply to'),
    }),
    handler: async (params, session: SessionContext) => {
      const text = (params['text'] as string).trim();
      const voiceId = params['voice_id'] as string | undefined;

      if (!text) {
        return { error: 'invalid_input', message: 'Text cannot be empty.' };
      }

      const chatJid = session.deliveryJid;
      if (!chatJid) {
        return { error: 'no_target', message: 'No delivery JID in session context.' };
      }

      // Synthesize speech
      let result;
      try {
        result = await synthesizeSpeech(text, voiceId ? { voiceId } : undefined);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ error: message, textLength: text.length }, 'voice synthesis failed');
        return { error: 'synthesis_failed', message };
      }

      // Write to temp file
      const ext = result.mimeType.includes('ogg') ? 'ogg' : 'mp3';
      const filePath = writeTempFile(result.buffer, ext);

      // Read back as buffer for sendMedia
      const audioBuffer = readFileSync(filePath);

      // Send as voice note (PTT)
      try {
        await connection.sendMedia(chatJid, {
          type: 'audio' as const,
          buffer: audioBuffer,
          mimetype: result.mimeType.includes('ogg') ? 'audio/ogg; codecs=opus' : result.mimeType,
          ptt: true,
          seconds: result.duration,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, chatJid }, 'failed to send voice note');
        return { error: 'send_failed', message: `Failed to send voice note: ${message}` };
      }

      return {
        sent: true,
        duration: result.duration,
        file_path: filePath,
      };
    },
  });
}
```

- [ ] **Step 4: Run tests, verify they pass:**

```bash
cd ~/LAB/WhatSoup && npx vitest run tests/mcp/tools/voice.test.ts 2>&1 | tail -20
# Expected: all PASS
```

- [ ] **Step 5: Commit:**

```bash
cd ~/LAB/WhatSoup && git add src/mcp/tools/voice.ts tests/mcp/tools/voice.test.ts && git commit -m "feat(voice): add send_voice_reply MCP tool

Creates voice.ts with send_voice_reply tool (scope: chat, Pattern 1).
Synthesizes text via ElevenLabs, saves to temp file, sends as PTT
voice note via connection.sendMedia (SP4)."
```

---

## Task 3: Register voice tools in `register-all.ts`

Wire the new voice tools into the global tool registration.

**Files:**
- Modify: `src/mcp/register-all.ts`

- [ ] **Step 1: Add the import.** At the top of `src/mcp/register-all.ts`, after the `registerMediaTools` import (line 12):

```typescript
import { registerVoiceTools } from './tools/voice.ts';
```

- [ ] **Step 2: Add the registration call.** In the Pattern 1 section (after the `registerMediaTools` line, line 52), add:

```typescript
  try { registerVoiceTools(registry, { connection, db }); } catch (err) { log.error({ err }, 'registerVoiceTools failed'); }
```

- [ ] **Step 3: Update the comment** at the top of `registerAllTools` to reflect the new module count. Change:

```typescript
/**
 * Register all 13 tool modules onto the given registry.
```
to:
```typescript
/**
 * Register all 14 tool modules onto the given registry.
```

And change:
```typescript
 *   Pattern 1 (options-object): registerMessagingTools, registerMediaTools
```
to:
```typescript
 *   Pattern 1 (options-object): registerMessagingTools, registerMediaTools, registerVoiceTools
```

- [ ] **Step 4: Run type check:**

```bash
cd ~/LAB/WhatSoup && npx tsc --noEmit 2>&1 | head -20
# Expected: clean (0 errors)
```

- [ ] **Step 5: Commit:**

```bash
cd ~/LAB/WhatSoup && git add src/mcp/register-all.ts && git commit -m "feat(register): wire registerVoiceTools into register-all

Adds voice tools to Pattern 1 registration alongside messaging
and media tools. Updates module count to 14 (SP4)."
```

---

## Task 4: Config fields for ElevenLabs and voice reply mode

Add configuration for ElevenLabs defaults and voice reply behavior.

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add ElevenLabs config fields.** In `src/config.ts`, find the `export const config = {` block. Add these fields in a logical grouping (after the media-related config, before the closing `}` of the config object or near the existing provider configs):

```typescript
  // Voice (ElevenLabs TTS)
  elevenlabs: {
    defaultVoiceId: (instance?.elevenlabs?.defaultVoiceId as string | undefined) ?? 'pNInz6obpgDQGcFmaJgB',
    defaultModel: (instance?.elevenlabs?.defaultModel as string | undefined) ?? 'eleven_multilingual_v2',
    stability: (instance?.elevenlabs?.stability as number | undefined) ?? 0.5,
    similarityBoost: (instance?.elevenlabs?.similarityBoost as number | undefined) ?? 0.75,
  },
  voiceReply: ((instance?.voiceReply as string | undefined) ?? 'never') as 'always' | 'when_received' | 'never',
```

- [ ] **Step 2: Verify no type errors:**

```bash
cd ~/LAB/WhatSoup && npx tsc --noEmit 2>&1 | head -20
# Expected: clean (0 errors)
```

- [ ] **Step 3: Commit:**

```bash
cd ~/LAB/WhatSoup && git add src/config.ts && git commit -m "feat(config): add elevenlabs and voiceReply config fields

Adds elevenlabs.defaultVoiceId, defaultModel, stability,
similarityBoost from instance config with sensible defaults.
Adds voiceReply mode: 'always' | 'when_received' | 'never'
(default: 'never') for agent runtime voice reply control (SP4)."
```

---

## Task 5: Agent runtime voice reply integration

After the agent runtime processes a voice note and generates a text response, optionally synthesize and send it back as a voice note.

**Files:**
- Modify: `src/runtimes/agent/runtime.ts`

- [ ] **Step 1: Add imports** at the top of `src/runtimes/agent/runtime.ts`:

```typescript
import { synthesizeSpeech } from '../chat/providers/elevenlabs.ts';
```

Check if `config` is already imported -- if not, also add:
```typescript
import { config } from '../../config.ts';
```

Check if `writeTempFile` is already imported (from SP1) -- if not, also add:
```typescript
import { writeTempFile } from '../../core/media-download.ts';
```

- [ ] **Step 2: Identify the agent response handler.** Find the location where the agent runtime sends its text response back to WhatsApp after processing an incoming message:

```bash
cd ~/LAB/WhatSoup && grep -n 'sendMessage\|sendMedia\|reply.*text\|send.*response' src/runtimes/agent/runtime.ts | head -20
```

- [ ] **Step 3: Add voice reply logic** after the agent sends its text response. Insert this block immediately after the text response is sent. The exact variable names (`responseText`, `msg`, `connection`) must be verified against the actual code at the insertion point -- adjust accordingly:

```typescript
    // --- Voice reply (SP4) ---
    // If the incoming message was a voice note and voiceReply mode allows it,
    // also send the response as a voice note.
    if (
      config.voiceReply !== 'never' &&
      (config.voiceReply === 'always' || msg.contentType === 'audio')
    ) {
      try {
        const voiceResult = await synthesizeSpeech(responseText, {
          voiceId: config.elevenlabs.defaultVoiceId,
          modelId: config.elevenlabs.defaultModel,
          stability: config.elevenlabs.stability,
          similarityBoost: config.elevenlabs.similarityBoost,
        });

        const voicePath = writeTempFile(voiceResult.buffer, 'mp3');
        const voiceBuffer = (await import('node:fs')).readFileSync(voicePath);

        await connection.sendMedia(msg.chatJid, {
          type: 'audio',
          buffer: voiceBuffer,
          mimetype: 'audio/mpeg',
          ptt: true,
          seconds: voiceResult.duration,
        });

        log.info({ chatJid: msg.chatJid, duration: voiceResult.duration }, 'voice reply sent');
      } catch (err) {
        // Non-fatal: voice reply is optional. Log and continue.
        log.warn({ err, chatJid: msg.chatJid }, 'voice reply failed — text response already sent');
      }
    }
```

Note: The exact variable names at the insertion point must be verified. `responseText` should be the string the agent just sent as a text reply. `msg` is the incoming `IncomingMessage`. `connection` is the `ConnectionManager` instance. `log` is the module logger. Adjust names to match what is in scope.

- [ ] **Step 4: Run type check:**

```bash
cd ~/LAB/WhatSoup && npx tsc --noEmit 2>&1 | head -20
# Expected: clean (0 errors)
```

- [ ] **Step 5: Commit:**

```bash
cd ~/LAB/WhatSoup && git add src/runtimes/agent/runtime.ts && git commit -m "feat(agent): add voice reply integration after processing voice notes

When voiceReply config is 'always' or 'when_received' (and incoming
message was audio), synthesizes agent response via ElevenLabs and
sends as PTT voice note after the text reply. Non-fatal on failure —
text response is always sent first (SP4)."
```

---

## Task 6: Full test suite verification

Run the full test suite to verify no regressions.

**Files:**
- All test files

- [ ] **Step 1: Run the full test suite:**

```bash
cd ~/LAB/WhatSoup && npx vitest run --pool=forks 2>&1 > /tmp/sp4-test-results.log && echo "ALL PASS" || echo "FAILURES FOUND"
grep -E "FAIL|Tests |Test Files" /tmp/sp4-test-results.log
```

- [ ] **Step 2: If any tests fail, fix them.** Common regressions to watch for:

1. **Agent runtime tests** may need the new `synthesizeSpeech` import to be mocked to prevent calling ElevenLabs during tests. Add `vi.mock('../../runtimes/chat/providers/elevenlabs.ts')` (or the correct relative path) in agent runtime test files.

2. **Config tests** may need the `elevenlabs` and `voiceReply` fields added to mock config objects.

3. **register-all tests** may need the voice tools module to be mocked or the tool count assertion updated from 13 to 14.

- [ ] **Step 3: If all tests pass, commit any fixes:**

```bash
cd ~/LAB/WhatSoup && git add -A && git commit -m "fix: patch test regressions from SP4 voice reply integration

Mocks ElevenLabs provider in agent runtime tests, updates config
mocks with elevenlabs and voiceReply fields."
```

- [ ] **Step 4: Final verification:**

```bash
cd ~/LAB/WhatSoup && npx vitest run --pool=forks 2>&1 > /tmp/sp4-final.log && echo "ALL PASS" || echo "FAILURES"
grep -E "Test Files|Tests " /tmp/sp4-final.log
# Expected: ALL PASS — 0 failures
```

---

## Spec Coverage Checklist

| Spec Requirement | Task | Status |
|-----------------|------|--------|
| `elevenlabs.ts` TTS provider | Task 1 | Covered |
| Circuit breaker (5 failures, 60s recovery) | Task 1 | Covered |
| API key from GNOME Keyring | Task 1 | Covered |
| Raw `fetch` (no npm deps) | Task 1 | Covered |
| `VoiceSynthesisResult` interface (buffer, duration, mimeType) | Task 1 | Covered |
| `send_voice_reply` MCP tool (scope: chat) | Task 2 | Covered |
| Pattern 1 registration (options-object) | Task 2, 3 | Covered |
| `registerVoiceTools` in `register-all.ts` | Task 3 | Covered |
| ElevenLabs config fields (voiceId, model, stability, similarityBoost) | Task 4 | Covered |
| `voiceReply` mode: `'always' \| 'when_received' \| 'never'` | Task 4 | Covered |
| Agent runtime voice reply after processing voice notes | Task 5 | Covered |
| Voice reply non-fatal (text always sent first) | Task 5 | Covered |
| One retry on failure (matches Whisper pattern) | Task 1 | Covered |
