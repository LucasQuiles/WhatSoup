# Twilio Transport Stage 2: Webhook Inbound + Recorded Voice — Implementation Plan

**Status:** completed — shipped as PR #736 (squash `c93ea0fc`, merged 2026-06-12).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Execution prerequisite:** a clean dedicated worktree on branch `feat/twilio-voice-webhook` off main `3d11897d`.
> **Design spec:** `docs/specs/2026-06-10-twilio-transport-design.md` §3 (D3), §4, §5, §14 — stage 2 scope: webhook inbound + signature validation, recorded voice (voicemail → transcript), `contract/voice.ts`. Live voice AI stays deferred.
> **Intended repo home:** `docs/superpowers/plans/2026-06-11-twilio-voice-webhook.md` (committed at T0).

**Goal:** Unlock `inboundMode: 'webhook'` (signature-validated, transport-owned HTTP listener) and add recorded-voice support: inbound calls get a voicemail TwiML response, and completed transcriptions arrive as `InboundMessage`s carrying a `'voice'` attachment plus transcript text; `placeCall` ships behind a new `VoiceCapableTransport` contract.

**Architecture:** A new `TwilioWebhookServer` (own `node:http` listener — the health server is localhost-bound with a closed route switch, verified `src/core/health.ts:139,679-682`) validates `X-Twilio-Signature` (HMAC-SHA1 via the SDK's `validateRequest`) and translates Twilio POSTs into the adapter's existing single-emitter pipeline through a new `handleInboundRecord` seam extracted from the poll loop (dedupe/ordering preserved). Voice is config-gated: inbound call → `VoiceResponse` say+record(transcribe) → transcription callback → `InboundMessage{text: transcript, attachments:[{kind:'voice',…}]}`. The bridge learns to map voice attachments (today it drops attachments and hardcodes `contentType:'text'`, `connection-bridge.ts:58-76`).

**Tech Stack:** TypeScript/ESM, Node `node:http`, Vitest `--pool=forks`, twilio@6.0.2 (`webhooks.validateRequest`, `twiml/VoiceResponse`, `calls.create`), keyring via `src/lib/keyring.ts`.

**⚠️ External contract caution:** Twilio's webhook POST body field names (`MessageSid`, `From`, `To`, `Body`, `NumMedia`; `CallSid`, `CallStatus`; `TranscriptionText`, `TranscriptionStatus`, `RecordingSid`, `RecordingUrl`) are **not typed in the SDK** (verified absent from twilio@6.0.2). Tasks below code against these names tolerantly (missing field → typed 400/skip, never crash) and T12 requires re-verifying them against Twilio's REST docs before live use. They are the one fact source this plan could not pin from the repo.

**Hygiene (pre-commit guard enforces):** no `Phase <digit>` strings (use "stage N"), no operator-local home paths, no high-entropy fake SIDs (use `AC`+32 zeros / `MG`+32 zeros), placeholder phones `+1555…`, WhatsApp JIDs only `1555…@s.whatsapp.net` / `1111111…@lid`. Test-file edits must be complete balanced `describe` blocks (hook parses fragments). Evidence per task in `.tmup-artifacts/twilio-voice/TNN-<slug>/report.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/transport/contract/voice.ts` (new) | `VoiceCapableTransport` + `CallRef`/`PlaceCallOptions` — contract only |
| `src/transport/twilio/types.ts` (modify) | `TwilioWebhookConfig` + voice fields on `TwilioSmsConfig`, defaults |
| `src/transport/twilio/webhook-payloads.ts` (new) | Tolerant parsers: Twilio POST form bodies → typed records (pure, no I/O) |
| `src/transport/twilio/webhook-server.ts` (new) | `node:http` listener, signature validation, route dispatch, TwiML responses |
| `src/transport/twilio/port.ts` (modify) | `placeCall` added to `TwilioSmsPort` |
| `src/transport/twilio/testing/mock-port.ts` (modify) | mock `placeCall` |
| `src/transport/twilio/twilio-port.ts` (modify) | SDK `calls.create` impl |
| `src/transport/twilio/adapter.ts` (modify) | `handleInboundRecord` seam; webhook mode (no poll loop); voice message build; `VoiceCapableTransport` impl; `'voice-notes'` NOT claimed (no sendVoiceNote) |
| `src/transport/twilio/connection-bridge.ts` (modify) | voice attachment → `contentType:'audio'`; webhook server lifecycle |
| `src/core/agent-config-validator.ts` (modify) | unlock `webhook`, validate webhook/voice fields, coherence rule |
| `src/config.ts` (modify) | resolve new fields |
| `docs/runbooks/twilio-transport.md` + `docs/configuration.md` (modify) | claims flip — PR-discipline co-update |

---

### Task T0: Preflight + plan docs commit

- [ ] **Step 1:** In the worktree, confirm clean state: `git status --short` → empty; `git log --oneline -1` → `3d11897d`.
- [ ] **Step 2:** Copy this plan to `docs/superpowers/plans/2026-06-11-twilio-voice-webhook.md`. `git add -f docs/superpowers/plans/2026-06-11-twilio-voice-webhook.md` (path is gitignored).
- [ ] **Step 3:** `npm run typecheck:all` → exit 0. Commit: `git commit -m "docs: twilio stage 2 voice + webhook plan"`.

---

### Task T1: Voice contract (`contract/voice.ts`)

**Files:** Create `src/transport/contract/voice.ts`; Test `tests/transport/voice-contract.test.ts`.

- [ ] **Step 1: Failing test**
```typescript
// tests/transport/voice-contract.test.ts
import { describe, it, expect } from 'vitest';
import { isVoiceCallCapable } from '../../src/transport/contract/voice.ts';
import { MinimalTextAdapter } from '../../src/transport/testing/minimal-text.ts';

describe('voice contract', () => {
  it('isVoiceCallCapable is false for adapters without the marker', () => {
    expect(isVoiceCallCapable(new MinimalTextAdapter())).toBe(false);
  });
});
```
- [ ] **Step 2:** `npx vitest run --pool=forks tests/transport/voice-contract.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** — mirror `extensions.ts` style (read it first: `src/transport/contract/extensions.ts:18-20,71-72`):
```typescript
// src/transport/contract/voice.ts
import type { ConversationRef } from '../../core/transport-refs.ts';
import type { TransportAdapter } from './adapter.ts';

/** Reference to a placed call (provider call SID). */
export interface CallRef {
  readonly id: string;
  readonly status: 'queued' | 'ringing' | 'in-progress' | 'completed' | 'busy' | 'failed' | 'no-answer' | 'canceled';
}

export interface PlaceCallOptions {
  /** TwiML to execute when answered; the transport supplies a default voicemail prompt when omitted. */
  readonly twiml?: string;
  readonly correlationId?: string;
}

/**
 * Optional capability: transports that can place outbound voice calls.
 * Distinct from SupportsVoiceNotes (sending audio MEDIA over chat);
 * this is telephony. Queried structurally, not via ExtensionName.
 */
export interface VoiceCapableTransport {
  placeCall(target: ConversationRef, opts?: PlaceCallOptions): Promise<CallRef>;
}

export const isVoiceCallCapable = (
  a: TransportAdapter,
): a is TransportAdapter & VoiceCapableTransport =>
  typeof (a as Partial<VoiceCapableTransport>).placeCall === 'function';
```
- [ ] **Step 4:** Test passes; `npm run typecheck:all` clean.
- [ ] **Step 5:** Commit `feat(transport): voice call contract`.

---

### Task T2: Config types — webhook + voice fields

**Files:** Modify `src/transport/twilio/types.ts`; Test `tests/transport/twilio/types.test.ts`.

- [ ] **Step 1: Failing test** (append a complete describe block):
```typescript
describe('webhook + voice config defaults', () => {
  it('webhook defaults are absent until configured; voice defaults off', () => {
    expect(DEFAULT_TWILIO_SMS.voice).toEqual({ enabled: false, voicemailMaxLengthSec: 120 });
  });
});
```
(Also extend the existing defaults import line.)
- [ ] **Step 2:** Run → FAIL (`voice` undefined).
- [ ] **Step 3: Implement** in `types.ts` — extend interface + defaults (keep `Pick<>` typing pattern already used):
```typescript
export interface TwilioWebhookConfig {
  /** Public base URL Twilio calls (signature is computed over the FULL public URL). */
  readonly publicBaseUrl: string;        // e.g. 'https://example.ngrok.app'
  readonly listenPort: number;           // dedicated listener; NOT the health port
  readonly listenAddress?: string;       // default '127.0.0.1' — operator fronts with a proxy/tunnel
}

export interface TwilioVoiceConfig {
  readonly enabled: boolean;             // voicemail flow + placeCall
  readonly voicemailGreeting?: string;   // <Say> text; default in webhook-server
  readonly voicemailMaxLengthSec: number;
}

export interface TwilioSmsConfig {
  // … existing fields unchanged …
  readonly webhook?: TwilioWebhookConfig;  // required iff inboundMode === 'webhook'
  readonly voice?: TwilioVoiceConfig;
}

export const DEFAULT_TWILIO_VOICE: TwilioVoiceConfig = Object.freeze({
  enabled: false,
  voicemailMaxLengthSec: 120,
});
// add `voice: DEFAULT_TWILIO_VOICE` into DEFAULT_TWILIO_SMS and widen its Pick<> accordingly
```
- [ ] **Step 4:** Tests + `typecheck:all` pass. **Step 5:** Commit `feat(twilio): webhook + voice config types`.

---

### Task T3: Tolerant webhook payload parsers

**Files:** Create `src/transport/twilio/webhook-payloads.ts`; Test `tests/transport/twilio/webhook-payloads.test.ts`.

Pure functions, no I/O. Input: `Record<string, string>` (parsed form body). Output: typed record or a typed parse failure — **never throw on missing fields** (fail-closed at the route layer).

- [ ] **Step 1: Failing tests**
```typescript
// tests/transport/twilio/webhook-payloads.test.ts
import { describe, it, expect } from 'vitest';
import { parseInboundSmsWebhook, parseTranscriptionCallback } from '../../../src/transport/twilio/webhook-payloads.ts';

describe('parseInboundSmsWebhook', () => {
  it('maps a complete body to an InboundSms-shaped record', () => {
    const r = parseInboundSmsWebhook({
      MessageSid: 'SM00000000000000000000000000000000',
      From: '+15551230001', To: '+15559990000', Body: 'hello',
    }, new Date('2026-06-11T00:00:00Z'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record).toMatchObject({
        sid: 'SM00000000000000000000000000000000',
        from: '+15551230001', to: '+15559990000', body: 'hello', fromMe: false,
      });
    }
  });
  it('rejects a body missing MessageSid with a named reason (no throw)', () => {
    const r = parseInboundSmsWebhook({ From: '+15551230001', To: '+15559990000', Body: 'x' }, new Date());
    expect(r).toEqual({ ok: false, reason: 'missing MessageSid' });
  });
});

describe('parseTranscriptionCallback', () => {
  it('maps a completed transcription', () => {
    const r = parseTranscriptionCallback({
      TranscriptionText: 'call me back', TranscriptionStatus: 'completed',
      RecordingSid: 'RE00000000000000000000000000000000',
      RecordingUrl: 'https://api.twilio.com/recording-media',
      CallSid: 'CA00000000000000000000000000000000',
      From: '+15551230001', To: '+15559990000',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.transcript.text).toBe('call me back');
  });
  it('reports failed transcription status as ok:false with reason', () => {
    const r = parseTranscriptionCallback({ TranscriptionStatus: 'failed', RecordingSid: 'RE0', CallSid: 'CA0', From: '+1', To: '+2' });
    expect(r).toEqual({ ok: false, reason: 'transcription status failed' });
  });
});
```
- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3: Implement**
```typescript
// src/transport/twilio/webhook-payloads.ts
// ⚠️ Field names (MessageSid, From, …) are Twilio's external webhook contract —
// NOT typed in the SDK. Verify against Twilio REST docs before live use (plan T12).
import type { InboundSms } from './port.ts';

export type ParseResult<T> = { ok: true } & T | { ok: false; reason: string };

export function parseInboundSmsWebhook(
  body: Record<string, string>,
  receivedAt: Date,
): ParseResult<{ record: InboundSms }> {
  for (const f of ['MessageSid', 'From', 'To'] as const) {
    if (!body[f]) return { ok: false, reason: `missing ${f}` };
  }
  return {
    ok: true,
    record: {
      sid: body.MessageSid, from: body.From, to: body.To,
      body: body.Body ?? '', sentAt: receivedAt, fromMe: false,
      status: body.SmsStatus,
    },
  };
}

export interface TranscriptDelivery {
  readonly text: string;
  readonly recordingSid: string;
  readonly recordingUrl?: string;
  readonly callSid: string;
  readonly from: string;
  readonly to: string;
}

export function parseTranscriptionCallback(
  body: Record<string, string>,
): ParseResult<{ transcript: TranscriptDelivery }> {
  if (body.TranscriptionStatus !== 'completed') {
    return { ok: false, reason: `transcription status ${body.TranscriptionStatus ?? 'missing'}` };
  }
  for (const f of ['RecordingSid', 'CallSid', 'From', 'To'] as const) {
    if (!body[f]) return { ok: false, reason: `missing ${f}` };
  }
  return {
    ok: true,
    transcript: {
      text: body.TranscriptionText ?? '',
      recordingSid: body.RecordingSid, recordingUrl: body.RecordingUrl,
      callSid: body.CallSid, from: body.From, to: body.To,
    },
  };
}
```
- [ ] **Step 4:** Tests + typecheck pass. **Step 5:** Commit `feat(twilio): tolerant webhook payload parsers`.

---

### Task T4: Adapter `handleInboundRecord` seam (refactor, behavior-preserving)

**Files:** Modify `src/transport/twilio/adapter.ts`; Test: existing `tests/transport/twilio/adapter-inbound.test.ts` must stay green, plus one new test.

Extract the per-record body of `pollOnceInner`'s loop (dedupe `seen` check/add, cursor is poll-only, `buildInboundMessage`, `safeEmit`) into a public method the webhook server can call:

- [ ] **Step 1: Failing test** (append complete block to `adapter-inbound.test.ts`):
```typescript
describe('TwilioSmsAdapter handleInboundRecord (webhook push seam)', () => {
  it('emits exactly once for a record pushed twice (shared SID dedupe with polling)', async () => {
    vi.useFakeTimers({ now: 0 });
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeConfig({ pollIntervalMs: 0 }), port);
    const got: InboundMessage[] = [];
    adapter.on('message', (m) => got.push(m));
    await adapter.connect();

    const rec = { sid: 'SMwh1', from: '+15551230001', to: '+15559990000', body: 'via webhook', sentAt: new Date(5), fromMe: false };
    adapter.handleInboundRecord(rec);
    adapter.handleInboundRecord(rec);
    expect(got).toHaveLength(1);
    expect(got[0].text).toBe('via webhook');
    await adapter.disconnect();
  });
});
```
- [ ] **Step 2:** Run → FAIL (`handleInboundRecord` missing).
- [ ] **Step 3: Implement** — inside the existing batch loop in `pollOnceInner`, replace the per-record block with a call to the new method (cursor tracking stays in `pollOnceInner`):
```typescript
  /**
   * Process one provider record through the shared dedupe + emit pipeline.
   * Used by the poll loop AND (stage 2) the webhook push path, so both
   * modes share one `seen` set and one emitter. Returns true if emitted.
   */
  handleInboundRecord(record: InboundSms): boolean {
    if (this.disposed) return false;
    if (this.seen.has(record.sid)) return false;
    this.seen.add(record.sid);
    const msg = this.buildInboundMessage(record);
    this.safeEmit(this.listeners.message, msg);
    return true;
  }
```
(`pollOnceInner` keeps its own `maxSentAt` cursor logic; eviction trim stays post-batch in `pollOnceInner` — add the same trim after webhook pushes inside `handleInboundRecord` when `seen.size > DEDUPE_CAP`: copy the existing `for…break` trim loop.)
- [ ] **Step 4:** New test passes AND the full inbound suite stays green: `npx vitest run --pool=forks tests/transport/twilio/` → all pass; `typecheck:all` clean.
- [ ] **Step 5:** Commit `refactor(twilio): extract shared inbound record pipeline for webhook push`.

---

### Task T5: `placeCall` through the port

**Files:** Modify `src/transport/twilio/port.ts`, `testing/mock-port.ts`, `twilio-port.ts`, `adapter.ts`; Tests `tests/transport/twilio/mock-port.test.ts`, `twilio-port.test.ts`, new `adapter-voice.test.ts`.

- [ ] **Step 1: Failing tests**
```typescript
// append to tests/transport/twilio/mock-port.test.ts
describe('placeCall', () => {
  it('records the call and returns a CA-prefixed sid with queued status', async () => {
    const port = new MockTwilioSmsPort();
    const ref = await port.placeCall({ to: '+15551230001', from: '+15559990000', twiml: '<Response/>' });
    expect(ref.sid).toMatch(/^CA/);
    expect(ref.status).toBe('queued');
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0].to).toBe('+15551230001');
  });
});
```
```typescript
// tests/transport/twilio/adapter-voice.test.ts (new file)
import { describe, it, expect } from 'vitest';
import { TwilioSmsAdapter } from '../../../src/transport/twilio/adapter.ts';
import { MockTwilioSmsPort } from '../../../src/transport/twilio/testing/mock-port.ts';
import { makeTwilioConfig } from './helpers.ts';
import { isVoiceCallCapable } from '../../../src/transport/contract/voice.ts';
import { makeChannelId } from '../../../src/core/transport-refs.ts';

describe('TwilioSmsAdapter voice capability', () => {
  it('is voice-call capable and delegates placeCall to the port', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(
      makeTwilioConfig({ voice: { enabled: true, voicemailMaxLengthSec: 120 } }), port);
    await adapter.connect();
    expect(isVoiceCallCapable(adapter)).toBe(true);
    const ref = await adapter.placeCall(
      { channel: makeChannelId('sms', 'ml-bot'), id: '+15551230001' });
    expect(ref.id).toMatch(/^CA/);
    expect(port.calls[0]).toMatchObject({ to: '+15551230001', from: '+15559990000' });
  });

  it('placeCall rejects with typed error when voice is disabled', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(makeTwilioConfig(), port); // voice default off
    await adapter.connect();
    await expect(
      adapter.placeCall({ channel: makeChannelId('sms', 'ml-bot'), id: '+15551230001' }),
    ).rejects.toThrow(/voice is not enabled/);
  });
});
```
- [ ] **Step 2:** Run both → FAIL.
- [ ] **Step 3: Implement**
  - `port.ts`: add to interface (+ doc): `placeCall(args: PlaceCallArgs): Promise<{ sid: string; status: string }>;` with `export interface PlaceCallArgs { readonly to: string; readonly from?: string; readonly twiml: string; readonly statusCallback?: string; }`
  - `mock-port.ts`: `readonly calls: PlaceCallArgs[] = [];` + `failNextCall(err)` one-shot (mirror existing helpers); `placeCall` pushes and returns `{ sid: 'CA' + String(++this.callCounter).padStart(6, '0'), status: 'queued' }`.
  - `twilio-port.ts`: extend `TwilioClientLike` with `calls: { create(params: { to: string; from?: string; twiml?: string; statusCallback?: string }): Promise<{ sid: string; status: string }> }` (verified surface: `call.d.ts:47-122`); implement with the same `scrubAndRethrow` wrapping as `sendSms`.
  - `adapter.ts`: `implements TransportAdapter, VoiceCapableTransport`; `placeCall(target, opts?)`: validate connected + E.164 (reuse `E164_RE`) + `this.voice.enabled` (else throw `UnsupportedCapabilityError` from contract errors with message containing `voice is not enabled`); default TwiML when `opts?.twiml` absent: `'<Response><Say>This line is text-first. Please leave a message.</Say></Response>'`; map port errors via `mapPortError`; return `{ id: sid, status }` as `CallRef`.
- [ ] **Step 4:** All three suites + `typecheck:all` green. **Step 5:** Commit `feat(twilio): placeCall via port and voice-capable adapter`.

---

### Task T6: Webhook server — signature validation core

**Files:** Create `src/transport/twilio/webhook-server.ts`; Test `tests/transport/twilio/webhook-server.test.ts`.

The server takes injected deps (testable without keyring/network): `{ getAuthToken: () => string | null; onSms: (r: InboundSms) => void; onTranscript: (t: TranscriptDelivery) => void; voice: TwilioVoiceConfig; publicBaseUrl: string }`. Use the SDK's real `validateRequest(authToken, signatureHeader, url, params)` (verified `lib/webhooks/webhooks.d.ts:79`) — the URL passed MUST be `publicBaseUrl + req.url`, not the local address.

- [ ] **Step 1: Failing tests** — drive a REAL listener on an ephemeral port; compute valid signatures with the SDK's own `getExpectedTwilioSignature` (this tests our wiring, not Twilio's crypto):
```typescript
// tests/transport/twilio/webhook-server.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { getExpectedTwilioSignature } from 'twilio/lib/webhooks/webhooks.js';
import { TwilioWebhookServer } from '../../../src/transport/twilio/webhook-server.ts';
import type { InboundSms } from '../../../src/transport/twilio/port.ts';

const TOKEN = 'test-webhook-token-0000';
const PUBLIC = 'https://example.test';

function makeServer(over: Partial<ConstructorParameters<typeof TwilioWebhookServer>[0]> = {}) {
  const smsRecords: InboundSms[] = [];
  const server = new TwilioWebhookServer({
    getAuthToken: () => TOKEN,
    publicBaseUrl: PUBLIC,
    listenPort: 0, // ephemeral
    listenAddress: '127.0.0.1',
    voice: { enabled: false, voicemailMaxLengthSec: 120 },
    onSms: (r) => smsRecords.push(r),
    onTranscript: () => {},
    ...over,
  });
  return { server, smsRecords };
}

async function post(port: number, path: string, params: Record<string, string>, sig?: string) {
  const body = new URLSearchParams(params).toString();
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(sig !== undefined ? { 'x-twilio-signature': sig } : {}),
    },
    body,
  });
}

let active: { stop(): Promise<void> } | null = null;
afterEach(async () => { await active?.stop(); active = null; });

describe('TwilioWebhookServer signature gate', () => {
  it('accepts a correctly signed inbound SMS and forwards it to onSms', async () => {
    const { server, smsRecords } = makeServer();
    const port = await server.start(); active = server;
    const params = { MessageSid: 'SM00000000000000000000000000000000', From: '+15551230001', To: '+15559990000', Body: 'hi' };
    const sig = getExpectedTwilioSignature(TOKEN, `${PUBLIC}/twilio/sms`, params);
    const res = await post(port, '/twilio/sms', params, sig);
    expect(res.status).toBe(204);
    expect(smsRecords).toHaveLength(1);
    expect(smsRecords[0].body).toBe('hi');
  });

  it('rejects a bad signature with 403 and forwards nothing', async () => {
    const { server, smsRecords } = makeServer();
    const port = await server.start(); active = server;
    const res = await post(port, '/twilio/sms', { MessageSid: 'SM1', From: '+1', To: '+2', Body: 'x' }, 'bogus');
    expect(res.status).toBe(403);
    expect(smsRecords).toHaveLength(0);
  });

  it('rejects a missing signature header with 403 (fail closed)', async () => {
    const { server, smsRecords } = makeServer();
    const port = await server.start(); active = server;
    const res = await post(port, '/twilio/sms', { MessageSid: 'SM1', From: '+1', To: '+2', Body: 'x' });
    expect(res.status).toBe(403);
    expect(smsRecords).toHaveLength(0);
  });

  it('fails closed with 503 when the auth token is unavailable', async () => {
    const { server, smsRecords } = makeServer({ getAuthToken: () => null });
    const port = await server.start(); active = server;
    const res = await post(port, '/twilio/sms', { MessageSid: 'SM1', From: '+1', To: '+2', Body: 'x' }, 'anything');
    expect(res.status).toBe(503);
    expect(smsRecords).toHaveLength(0);
  });

  it('returns 404 for unknown paths and 405 for GET on known paths', async () => {
    const { server } = makeServer();
    const port = await server.start(); active = server;
    expect((await post(port, '/nope', {})).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/twilio/sms`)).status).toBe(405);
  });
});
```
- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3: Implement** `TwilioWebhookServer`:
  - `node:http` `createServer`; `start(): Promise<number>` resolves the bound port (`server.address()`); `stop(): Promise<void>` closes and waits.
  - Request handling: only POST on known routes (else 404/405); read body with a **64 KiB cap** (destroy + 413 over cap); parse with `new URLSearchParams(body)` → `Record<string,string>`.
  - Signature gate order: token via `getAuthToken()` — `null` → 503; missing/invalid `x-twilio-signature` vs `validateRequest(token, sig, publicBaseUrl + req.url, params)` → 403. Log rejections through `createChildLogger('twilio-webhook')` (no body contents, no token).
  - Route `/twilio/sms`: `parseInboundSmsWebhook` → `ok` ? `onSms(record)` + 204 : 400 with reason (reason names the field only).
  - Stage 2 routes for voice land in T7 (this task ships sms route + gate only).
- [ ] **Step 4:** All 5 tests pass; full twilio suite green; `typecheck:all` clean.
- [ ] **Step 5:** Commit `feat(twilio): signature-validated webhook server (sms inbound)`.

---

### Task T7: Voice webhook routes — voicemail TwiML + transcription delivery

**Files:** Modify `src/transport/twilio/webhook-server.ts`; Test: append to `tests/transport/twilio/webhook-server.test.ts`.

- [ ] **Step 1: Failing tests** (complete block; reuse `makeServer`/`post` helpers):
```typescript
describe('TwilioWebhookServer voice routes', () => {
  it('answers an inbound call with say+record TwiML when voice is enabled', async () => {
    const { server } = makeServer({ voice: { enabled: true, voicemailMaxLengthSec: 90, voicemailGreeting: 'Leave a message.' } });
    const port = await server.start(); active = server;
    const params = { CallSid: 'CA00000000000000000000000000000000', From: '+15551230001', To: '+15559990000' };
    const sig = getExpectedTwilioSignature(TOKEN, `${PUBLIC}/twilio/voice`, params);
    const res = await post(port, '/twilio/voice', params, sig);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/xml');
    const xml = await res.text();
    expect(xml).toContain('<Say>Leave a message.</Say>');
    expect(xml).toContain('transcribeCallback="https://example.test/twilio/voice/transcription"');
    expect(xml).toContain('maxLength="90"');
  });

  it('rejects an inbound call with TwiML <Reject> when voice is disabled', async () => {
    const { server } = makeServer(); // voice disabled
    const port = await server.start(); active = server;
    const params = { CallSid: 'CA1', From: '+15551230001', To: '+15559990000' };
    const sig = getExpectedTwilioSignature(TOKEN, `${PUBLIC}/twilio/voice`, params);
    const res = await post(port, '/twilio/voice', params, sig);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<Reject');
  });

  it('forwards a completed transcription to onTranscript', async () => {
    const transcripts: unknown[] = [];
    const { server } = makeServer({
      voice: { enabled: true, voicemailMaxLengthSec: 120 },
      onTranscript: (t) => transcripts.push(t),
    });
    const port = await server.start(); active = server;
    const params = {
      TranscriptionText: 'call me back', TranscriptionStatus: 'completed',
      RecordingSid: 'RE00000000000000000000000000000000',
      RecordingUrl: 'https://api.twilio.test/media', CallSid: 'CA2',
      From: '+15551230001', To: '+15559990000',
    };
    const sig = getExpectedTwilioSignature(TOKEN, `${PUBLIC}/twilio/voice/transcription`, params);
    const res = await post(port, '/twilio/voice/transcription', params, sig);
    expect(res.status).toBe(204);
    expect(transcripts).toHaveLength(1);
  });

  it('acknowledges failed transcription with 204 but forwards nothing', async () => {
    const transcripts: unknown[] = [];
    const { server } = makeServer({ voice: { enabled: true, voicemailMaxLengthSec: 120 }, onTranscript: (t) => transcripts.push(t) });
    const port = await server.start(); active = server;
    const params = { TranscriptionStatus: 'failed', RecordingSid: 'RE1', CallSid: 'CA3', From: '+1', To: '+2' };
    const sig = getExpectedTwilioSignature(TOKEN, `${PUBLIC}/twilio/voice/transcription`, params);
    const res = await post(port, '/twilio/voice/transcription', params, sig);
    expect(res.status).toBe(204);
    expect(transcripts).toHaveLength(0);
  });
});
```
- [ ] **Step 2:** Run → FAIL (routes missing).
- [ ] **Step 3: Implement** — routes `/twilio/voice` and `/twilio/voice/transcription` behind the same signature gate:
  - `/twilio/voice`: build TwiML with the SDK's real builder (verified `lib/twiml/VoiceResponse.d.ts`): `new VoiceResponse()`; if voice disabled → `vr.reject()`; else `vr.say(greeting ?? DEFAULT_GREETING)` + `vr.record({ transcribe: true, transcribeCallback: `${publicBaseUrl}/twilio/voice/transcription`, maxLength: voice.voicemailMaxLengthSec, playBeep: true })`; respond `200 text/xml` with `vr.toString()`.
  - `/twilio/voice/transcription`: `parseTranscriptionCallback` → `ok` ? `onTranscript(t)` : log reason; **always 204** (Twilio retries non-2xx; a failed transcription is not our error).
- [ ] **Step 4:** All webhook tests green; `typecheck:all` clean. **Step 5:** Commit `feat(twilio): voicemail twiml + transcription webhook routes`.

---

### Task T8: Adapter webhook mode + voice message construction

**Files:** Modify `src/transport/twilio/adapter.ts`; Tests: append to `adapter-voice.test.ts` + `adapter-inbound.test.ts`.

- [ ] **Step 1: Failing tests**
```typescript
// append to tests/transport/twilio/adapter-voice.test.ts
describe('TwilioSmsAdapter voicemail transcript ingestion', () => {
  it('handleTranscript emits an InboundMessage with voice attachment + transcript text', async () => {
    const port = new MockTwilioSmsPort();
    const adapter = new TwilioSmsAdapter(
      makeTwilioConfig({ voice: { enabled: true, voicemailMaxLengthSec: 120 } }), port);
    const got: InboundMessage[] = [];
    adapter.on('message', (m) => got.push(m));
    await adapter.connect();

    adapter.handleTranscript({
      text: 'call me back', recordingSid: 'RE00000000000000000000000000000000',
      recordingUrl: 'https://api.twilio.test/media', callSid: 'CA9',
      from: '+15551230001', to: '+15559990000',
    });
    expect(got).toHaveLength(1);
    expect(got[0].text).toBe('call me back');
    expect(got[0].attachments).toEqual([
      { id: 'RE00000000000000000000000000000000', kind: 'voice', mime: 'audio/mpeg' },
    ]);
    expect(got[0].inboundEventKey).toBe('RE00000000000000000000000000000000');
    expect(got[0].fromMe).toBe(false);
    // dedupe by recording sid
    adapter.handleTranscript({ text: 'call me back', recordingSid: 'RE00000000000000000000000000000000', callSid: 'CA9', from: '+15551230001', to: '+15559990000' });
    expect(got).toHaveLength(1);
    await adapter.disconnect();
  });
});
```
```typescript
// append to tests/transport/twilio/adapter-inbound.test.ts
describe('TwilioSmsAdapter webhook mode', () => {
  it('does not start the poll loop when inboundMode is webhook', async () => {
    vi.useFakeTimers({ now: 0 });
    const port = new MockTwilioSmsPort();
    let listCalls = 0;
    port.listInboundSince = async () => { listCalls++; return []; };
    const adapter = new TwilioSmsAdapter(
      makeConfig({ inboundMode: 'webhook', pollIntervalMs: 15000 }), port);
    await adapter.connect();
    await vi.advanceTimersByTimeAsync(60000);
    expect(listCalls).toBe(0);
    await adapter.disconnect();
  });
});
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** in `adapter.ts`:
  - Store `inboundMode` from config; in `connect()` gate the poll-loop start with `if (this.inboundMode === 'poll' && this.pollIntervalMs > 0)`.
  - `handleTranscript(t: TranscriptDelivery): boolean` — dedupe on `t.recordingSid` via the shared `seen` set, then build and `safeEmit`:
```typescript
  handleTranscript(t: TranscriptDelivery): boolean {
    if (this.disposed || this.seen.has(t.recordingSid)) return false;
    this.seen.add(t.recordingSid);
    const peer = t.from;
    this.safeEmit(this.listeners.message, {
      ref: { channel: this.channelId, conversation: peer, id: t.recordingSid },
      conversation: { channel: this.channelId, id: peer },
      sender: { channel: this.channelId, id: peer },
      fromMe: false,
      text: t.text.trim().length > 0 ? t.text : null,
      attachments: [{ id: t.recordingSid, kind: 'voice', mime: 'audio/mpeg' }],
      timestamp: new Date(),
      inboundEventKey: t.recordingSid,
      transportTimestamp: new Date(),
      ingestSeq: ++this.ingestSeq,
    });
    return true;
  }
```
  (`AttachmentRef` shape verified `contract/events.ts:4-10`; `mediaUrl` is intentionally NOT stored in the ref — `AttachmentRef.id` is the recording SID; fetching media is out of stage-2 scope and documented.)
- [ ] **Step 4:** All adapter suites green; typecheck clean. **Step 5:** Commit `feat(twilio): webhook mode gating + voicemail transcript ingestion`.

---

### Task T9: Bridge — voice attachments + webhook server lifecycle

**Files:** Modify `src/transport/twilio/connection-bridge.ts`, `src/transport/factory.ts`; Tests: append to `connection-bridge.test.ts`, `factory.test.ts`.

- [ ] **Step 1: Failing tests**
```typescript
// append to tests/transport/twilio/connection-bridge.test.ts
describe('TwilioConnection voice message mapping', () => {
  it('maps a voice-attachment InboundMessage to contentType audio with transcript content', async () => {
    vi.useFakeTimers({ now: 0 });
    const { bridge, adapter } = makeBridge({ voice: { enabled: true, voicemailMaxLengthSec: 120 } });
    const received: IncomingMessage[] = [];
    bridge.onMessage = (m) => received.push(m);
    await bridge.connect();
    adapter.handleTranscript({
      text: 'voicemail words', recordingSid: 'RE00000000000000000000000000000001',
      callSid: 'CA1', from: '+15551230001', to: '+15559990000',
    });
    expect(received).toHaveLength(1);
    expect(received[0].contentType).toBe('audio');
    expect(received[0].content).toBe('voicemail words');
    expect(received[0].chatJid).toBe('+15551230001@sms');
    expect(received[0].isResponseWorthy).toBe(true);
    bridge.shutdown();
  });
});
```
- [ ] **Step 2:** Run → FAIL (`contentType` still `'text'`).
- [ ] **Step 3: Implement**
  - `contractToIncoming`: `const voice = msg.attachments.find((a) => a.kind === 'voice'); contentType: voice ? 'audio' : 'text'` and keep `content: msg.text` (transcript). `isResponseWorthy` stays text-derived (a transcript IS text).
  - Bridge constructor accepts the optional `TwilioWebhookServer`; `connect()` starts it after the adapter connects (`onSms: (r) => adapter.handleInboundRecord(r)`, `onTranscript: (t) => adapter.handleTranscript(t)`); `shutdown()` stops it. Factory (`src/transport/factory.ts`) constructs the server only when `twilioConfig.inboundMode === 'webhook'`, wiring `getAuthToken` to a keyring thunk `() => lookupCredential(twilioConfig.authTokenService)`.
  - Factory test: webhook-mode config → bridge carries a server (expose nothing new publicly; assert behaviorally — `connect()` on a webhook-mode bridge binds the configured ephemeral port; use `listenPort: 0` + a `getBoundPort()` accessor on the bridge for ops/tests).
- [ ] **Step 4:** Suites green; typecheck clean. **Step 5:** Commit `feat(twilio): bridge voice mapping + webhook server lifecycle`.

---

### Task T10: Config validation + loader unlock

**Files:** Modify `src/core/agent-config-validator.ts`, `src/config.ts`; Tests: append to `tests/core/agent-config-validator-transport.test.ts`, `tests/config.twilio.test.ts`.

- [ ] **Step 1: Failing tests** (complete blocks):
```typescript
describe('validateInstanceConfig — webhook inbound (stage 2 unlock)', () => {
  it('accepts inboundMode webhook with a complete webhook block', () => {
    const raw = baseRaw({ transport: 'twilio', twilioConfig: validTwilioConfig({
      inboundMode: 'webhook',
      webhook: { publicBaseUrl: 'https://relay.example.test', listenPort: 8443 },
    }) });
    expect(validateInstanceConfig(raw, ctx())).toBeNull();
  });
  it('rejects webhook mode without a webhook block, naming the field', () => {
    const raw = baseRaw({ transport: 'twilio', twilioConfig: validTwilioConfig({ inboundMode: 'webhook' }) });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.field).toBe('twilioConfig.webhook');
  });
  it('rejects a non-https publicBaseUrl', () => {
    const raw = baseRaw({ transport: 'twilio', twilioConfig: validTwilioConfig({
      inboundMode: 'webhook', webhook: { publicBaseUrl: 'http://insecure.example', listenPort: 8443 },
    }) });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.webhook.publicBaseUrl');
  });
  it('rejects voice.enabled with poll mode (coherence rule, exact remediation)', () => {
    const raw = baseRaw({ transport: 'twilio', twilioConfig: validTwilioConfig({
      voice: { enabled: true, voicemailMaxLengthSec: 120 },
    }) });
    const err = validateInstanceConfig(raw, ctx());
    expect(err?.message).toBe("voice requires inboundMode:'webhook' (transcription arrives via webhook callbacks)");
  });
  it('rejects webhook block when inboundMode is poll (fail closed)', () => {
    const raw = baseRaw({ transport: 'twilio', twilioConfig: validTwilioConfig({
      webhook: { publicBaseUrl: 'https://x.example', listenPort: 8443 },
    }) });
    expect(validateInstanceConfig(raw, ctx())?.field).toBe('twilioConfig.webhook');
  });
});
```
- [ ] **Step 2:** Run → FAIL (webhook still rejected by the stage-1 block).
- [ ] **Step 3: Implement** in the validator (replacing the stage-1 `inboundMode` block at `agent-config-validator.ts:626-641`):
  - `inboundMode` ∈ {'poll','webhook'} (unknown → existing message updated: `"twilioConfig.inboundMode must be 'poll' or 'webhook'"`).
  - webhook mode ⇒ `webhook` object required: `publicBaseUrl` must parse as URL with `https:` protocol and no trailing `/` requirement (normalize by stripping trailing `/` in the LOADER, validate shape here); `listenPort` integer 1-65535 and **must differ from `healthPort`** when both set; `listenAddress` optional string.
  - poll mode ⇒ `webhook` block rejected (fail closed, mirrors twilioConfig-without-twilio).
  - `voice` optional object: `enabled` boolean; `voicemailMaxLengthSec` integer [5, 600]; `voicemailGreeting` ≤ 500 chars; **coherence**: `voice.enabled && inboundMode !== 'webhook'` → exact message above (spec §5 rule).
  - `src/config.ts` `resolveTwilioSmsConfig`: pass through `webhook` (normalize trailing slash) and `voice` (merge `DEFAULT_TWILIO_VOICE`).
- [ ] **Step 4:** Validator + config suites green (existing stage-1 tests for the OLD rejection message must be UPDATED in the same commit — they pin `"webhook inbound is not yet supported"`); typecheck clean.
- [ ] **Step 5:** Commit `feat(config): unlock webhook inbound mode with voice coherence rules`.

---

### Task T11: Docs co-update (PR discipline)

**Files:** Modify `docs/runbooks/twilio-transport.md`, `docs/configuration.md`, `docs/specs/2026-06-10-twilio-transport-design.md` (§14: move webhook+voice from deferred to delivered), regen work-index.

- [ ] **Step 1:** Grep for now-stale claims: `grep -n "webhook" docs/runbooks/twilio-transport.md docs/configuration.md` — every "webhook … later stages / not yet supported / rejected" line must flip. Update: Current limitations (remove webhook/voice entries; ADD: "voicemail media is referenced by recording SID; audio fetch/download is not implemented", "live conversational voice remains deferred", "webhook listener binds 127.0.0.1 by default — operators MUST front it with an HTTPS proxy/tunnel matching publicBaseUrl, and Twilio signature validation depends on publicBaseUrl matching exactly"), new "Webhook mode" section (config example with fake values, signature gate semantics, 403/503 fail-closed table, port-collision rule), new "Voicemail" section (TwiML flow diagram, transcription callback path, dedupe by RecordingSid, transcript-as-text semantics).
- [ ] **Step 2:** `docs/configuration.md`: add `webhook.*` + `voice.*` field rows mirroring the existing table style; update the `inboundMode` row.
- [ ] **Step 3:** `npm run work-index:regen`; `npm run guard:doc-drift && npm run guard:repo` → pass.
- [ ] **Step 4:** Commit `docs: webhook + voicemail operator documentation`.

---

### Task T12: Final verification

- [ ] **Step 1:** Full battery: `npm run typecheck && npm run typecheck:all && npm run verify:push:branch` → all pass (note: `tests/core/mcp-launcher.test.ts` fails on Node-26 dev hosts only — known env skew, passes on pinned 24.x CI).
- [ ] **Step 2:** Full suite: `npx vitest run --pool=forks --fileParallelism=false` → only the known env-skew failure.
- [ ] **Step 3:** Runtime smoke at the real entrypoint (mirror the stage-1 verification recipe): isolated `XDG_*` root, instance config with `inboundMode:'webhook'` + webhook block + nonexistent keyring service → process must fail loud with the typed auth error (or, if `verifyCredentials` is reached first, the same stage-1 behavior); a SECOND config with bad webhook config (missing publicBaseUrl) must be rejected at validation with the exact field. Capture both outputs in evidence.
- [ ] **Step 4:** **External-contract verification gate (blocking for live use, not for merge):** re-verify the webhook POST field names (`MessageSid/From/To/Body`, `CallSid`, `TranscriptionText/TranscriptionStatus/RecordingSid/RecordingUrl`) against Twilio's current REST documentation and record the doc URLs + retrieved field lists in the task evidence. If any differ, fix `webhook-payloads.ts` + tests in this branch before merge.
- [ ] **Step 5:** Report: branch, commit list, diffstat, suite results, deferred items. **Local until push/PR is approved.**

---

## Deferred from stage 2 (document, do not build)
- Voicemail **audio download** (RecordingUrl fetch, storage, media pipeline) — transcript text only for now.
- Live conversational voice (ConversationRelay/wss) — spec-deferred.
- `SupportsVoiceNotes` / `'voice-notes'` extension (sending audio) — NOT claimed by the adapter; `extensions` stays empty.
- Outbound-status webhooks (delivery receipts) — echo path remains the confirmation mechanism.
- Stage 3 enforcement envelope (unchanged).

## Self-Review (performed)
1. **Spec coverage:** D3 webhook mode ✓ (T6/T8/T10), signature validation ✓ (T6), `webhookUrl`-equivalent config ✓ (T2/T10 as `webhook.publicBaseUrl`), recorded voice + transcription ✓ (T7/T8), `contract/voice.ts` + `VoiceCapableTransport` ✓ (T1/T5), coherence rule with exact remediation ✓ (T10), docs ✓ (T11). Gap check: spec's `inbound-poll.ts` split is NOT done — poll stays in the adapter (justified: T4's shared-seam refactor achieves the testability goal with less churn; noted as a deviation).
2. **Placeholder scan:** no TBDs; every code step has code; external Twilio POST shapes explicitly flagged with a verification gate (T12.4) rather than hidden.
3. **Type consistency:** `TranscriptDelivery` (T3) consumed by T7/T8/T9; `handleInboundRecord`/`handleTranscript` names consistent across T4/T8/T9; `PlaceCallArgs`/`CallRef` consistent T1/T5; `TwilioWebhookConfig` field names consistent T2/T6/T10.
