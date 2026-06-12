# Twilio SMS Transport (Stage 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Execution prerequisite:** a CLEAN dedicated branch/worktree off latest main. Do NOT execute against a dirty shared checkout.
> **Design spec:** [`docs/specs/2026-06-10-twilio-transport-design.md`](../../specs/2026-06-10-twilio-transport-design.md) — read it (especially §0 grounding corrections) before implementing any task.

**Goal:** Add an optional, config-gated Twilio **SMS** transport to WhatSoup as a second real `TransportAdapter` (peer to Baileys), with config-first schema/validation/loading and a network-free testable adapter.

**Architecture:** New `ChannelKind 'sms'`; a `TwilioSmsAdapter implements TransportAdapter` that talks to Twilio through a narrow `TwilioSmsPort` (real SDK impl + in-memory mock), mirroring `MinimalTextAdapter`. Inbound via polling (Stage 1) mapped to the rich `InboundMessage`. Selected by an exhaustive transport switch. Voice and enforcement rules are separate plans.

**Tech Stack:** TypeScript/ESM, Node 24 (`--experimental-strip-types`), Vitest (`--pool=forks`), Zod, Pino, the `twilio` npm SDK (new approved dependency), macOS Keychain / secret-tool via `src/lib/keyring.ts`.

**Decisions locked from spec open questions:** Q1 → use the official `twilio` SDK behind a port (add to approved-API allowlist in Stage 3). Q2 → voicemail transcription is Stage 2 (not here). Q3 → inbound webhook routes are Stage 2; Stage 1 is **poll-only**.

---

### Task 1: Add `'sms'` to the channel model

**Files:**
- Modify: `src/core/transport-refs.ts` (the `ChannelKind` union + the `kind` cast comment)
- Test: `tests/core/transport-refs.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// tests/core/transport-refs.test.ts  (add to existing file; create if absent)
import { describe, it, expect } from 'vitest';
import { makeChannelId, kindOf, accountOf } from '../../src/core/transport-refs.ts';

describe('sms channel kind', () => {
  it('constructs and parses an sms channel id', () => {
    const id = makeChannelId('sms', 'ml-bot');
    expect(id).toBe('sms:ml-bot');
    expect(kindOf(id)).toBe('sms');
    expect(accountOf(id)).toBe('ml-bot');
  });
});
```

- [ ] **Step 2: Run it; expect FAIL** — `npx vitest run --pool=forks tests/core/transport-refs.test.ts` → fails: `'sms'` not assignable to `ChannelKind`.

- [ ] **Step 3: Implement** — in `src/core/transport-refs.ts`, change the union to:
```typescript
export type ChannelKind =
  | 'whatsapp'
  | 'telegram'
  | 'sms';
  // future: 'imessage' | 'signal' | 'discord'
```

- [ ] **Step 4: Run it; expect PASS.** Also run `npm run typecheck` — fix any newly-non-exhaustive `switch (kind)` the compiler flags (this is the point of the closed union; add an `'sms'` arm or a safe default per each site’s existing convention — read each flagged file before editing).

- [ ] **Step 5: Commit** — `git add src/core/transport-refs.ts tests/core/transport-refs.test.ts && git commit -m "feat(transport): add 'sms' channel kind"`

---

### Task 2: Transport registry (the provider-pattern mirror)

**Files:**
- Create: `src/transport/registry.ts`
- Test: `tests/transport/registry.test.ts`

- [ ] **Step 1: Failing test**
```typescript
// tests/transport/registry.test.ts
import { describe, it, expect } from 'vitest';
import { TRANSPORT_IDS, isTransportId } from '../../src/transport/registry.ts';

describe('transport registry', () => {
  it('is a frozen closed set including baileys and twilio', () => {
    expect([...TRANSPORT_IDS]).toEqual(['baileys', 'twilio']);
    expect(Object.isFrozen(TRANSPORT_IDS)).toBe(true);
    expect(isTransportId('twilio')).toBe(true);
    expect(isTransportId('nope')).toBe(false);
  });
});
```

- [ ] **Step 2: Run; expect FAIL** (module missing).

- [ ] **Step 3: Implement** `src/transport/registry.ts`:
```typescript
// src/transport/registry.ts
export const TRANSPORT_IDS = Object.freeze(['baileys', 'twilio'] as const);
export type TransportId = (typeof TRANSPORT_IDS)[number];

export function isTransportId(v: unknown): v is TransportId {
  return typeof v === 'string' && (TRANSPORT_IDS as readonly string[]).includes(v);
}

export function assertNeverTransport(v: never, ctx: string): never {
  throw new Error(`unhandled transport in ${ctx}: ${String(v)}`);
}
```

- [ ] **Step 4: Run; expect PASS.** `npm run typecheck`.

- [ ] **Step 5: Commit** — `git add -- src/transport/registry.ts tests/transport/registry.test.ts && git commit -m "feat(transport): add transport id registry"`

---

### Task 3: Twilio config types + defaults

**Files:**
- Create: `src/transport/twilio/types.ts`
- Test: `tests/transport/twilio/types.test.ts`

- [ ] **Step 1: Failing test**
```typescript
// tests/transport/twilio/types.test.ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_TWILIO_SMS } from '../../../src/transport/twilio/types.ts';

describe('twilio config defaults', () => {
  it('defaults to poll inbound and conservative rate limit', () => {
    expect(DEFAULT_TWILIO_SMS.inboundMode).toBe('poll');
    expect(DEFAULT_TWILIO_SMS.pollIntervalMs).toBeGreaterThanOrEqual(5000);
    expect(DEFAULT_TWILIO_SMS.rateLimit.smsPerMinute).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run; expect FAIL.**

- [ ] **Step 3: Implement** `src/transport/twilio/types.ts`:
```typescript
// src/transport/twilio/types.ts
export type TwilioInboundMode = 'poll' | 'webhook';

export interface TwilioSmsConfig {
  readonly account: string;            // channel account segment (a-z0-9-), e.g. 'ml-bot'
  readonly accountSid: string;         // AC… (validated AC[0-9a-f]{32})
  readonly authTokenService: string;   // keyring service name (never an inline token)
  readonly phoneNumber: string;        // E.164 sender (or use messagingServiceSid)
  readonly messagingServiceSid?: string; // MG… preferred sender if present
  readonly inboundMode: TwilioInboundMode; // Stage 1 supports 'poll' only
  readonly pollIntervalMs: number;
  readonly rateLimit: { readonly smsPerMinute: number };
}

export const DEFAULT_TWILIO_SMS = Object.freeze({
  inboundMode: 'poll' as TwilioInboundMode,
  pollIntervalMs: 15000,
  rateLimit: Object.freeze({ smsPerMinute: 30 }),
});
```

- [ ] **Step 4: Run; expect PASS.** `npm run typecheck`.
- [ ] **Step 5: Commit** — `git add -- src/transport/twilio/types.ts tests/transport/twilio/types.test.ts && git commit -m "feat(twilio): config types + defaults"`

---

### Task 4: The `TwilioSmsPort` boundary + in-memory mock

**Files:**
- Create: `src/transport/twilio/port.ts`
- Create: `src/transport/twilio/testing/mock-port.ts`
- Test: `tests/transport/twilio/mock-port.test.ts`

Rationale: the adapter depends on a narrow port (not the `twilio` SDK shape), so it’s unit-testable without network and the SDK stays isolated to one file.

- [ ] **Step 1: Failing test**
```typescript
// tests/transport/twilio/mock-port.test.ts
import { describe, it, expect } from 'vitest';
import { MockTwilioSmsPort } from '../../../src/transport/twilio/testing/mock-port.ts';

describe('MockTwilioSmsPort', () => {
  it('records sends and surfaces injected inbound', async () => {
    const port = new MockTwilioSmsPort();
    await port.verifyCredentials();
    const { sid } = await port.sendSms({ to: '+15551230000', from: '+15559990000', body: 'hi' });
    expect(sid).toMatch(/^SM/);
    port.injectInbound({ sid: 'SMin1', from: '+15551230000', to: '+15559990000', body: 'yo', sentAt: new Date() });
    const since = new Date(0);
    const got = await port.listInboundSince(since);
    expect(got).toHaveLength(1);
    expect(got[0].body).toBe('yo');
  });
});
```

- [ ] **Step 2: Run; expect FAIL.**

- [ ] **Step 3: Implement** `src/transport/twilio/port.ts`:
```typescript
// src/transport/twilio/port.ts — the only seam the adapter knows about
export interface SendSmsArgs {
  readonly to: string;
  readonly from?: string;
  readonly messagingServiceSid?: string;
  readonly body: string;
}
export interface InboundSms {
  readonly sid: string;
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly sentAt: Date;
}
export interface TwilioSmsPort {
  verifyCredentials(): Promise<void>;          // throws on bad creds
  sendSms(args: SendSmsArgs): Promise<{ sid: string }>;
  listInboundSince(since: Date): Promise<readonly InboundSms[]>;
}
```
Then `src/transport/twilio/testing/mock-port.ts`:
```typescript
// src/transport/twilio/testing/mock-port.ts
import type { InboundSms, SendSmsArgs, TwilioSmsPort } from '../port.ts';

export class MockTwilioSmsPort implements TwilioSmsPort {
  readonly sent: SendSmsArgs[] = [];
  private inbound: InboundSms[] = [];
  private n = 0;
  credsOk = true;

  async verifyCredentials(): Promise<void> {
    if (!this.credsOk) throw new Error('invalid twilio credentials');
  }
  async sendSms(args: SendSmsArgs): Promise<{ sid: string }> {
    this.sent.push(args);
    return { sid: 'SM' + String(++this.n).padStart(6, '0') };
  }
  async listInboundSince(since: Date): Promise<readonly InboundSms[]> {
    return this.inbound.filter((m) => m.sentAt >= since);
  }
  injectInbound(m: InboundSms): void { this.inbound.push(m); }
}
```

- [ ] **Step 4: Run; expect PASS.** `npm run typecheck`.
- [ ] **Step 5: Commit** — `git add -- src/transport/twilio/port.ts src/transport/twilio/testing/mock-port.ts tests/transport/twilio/mock-port.test.ts && git commit -m "feat(twilio): SMS port boundary + mock"`

---

### Task 5: `TwilioSmsAdapter implements TransportAdapter` (send path)

**Files:**
- Create: `src/transport/twilio/adapter.ts`
- Test: `tests/transport/twilio/adapter.send.test.ts`

> Before writing: open `src/transport/testing/minimal-text.ts` and `src/transport/contract/index.ts` to copy the exact `Capabilities` shape, `on()` overload form, `makeSubscription`, and error-payload shape; open `src/transport/contract/commands.ts` for `SendTextOptions`.

- [ ] **Step 1: Failing test**
```typescript
// tests/transport/twilio/adapter.send.test.ts
import { describe, it, expect } from 'vitest';
import { makeChannelId } from '../../../src/core/transport-refs.ts';
import { TwilioSmsAdapter } from '../../../src/transport/twilio/adapter.ts';
import { MockTwilioSmsPort } from '../../../src/transport/twilio/testing/mock-port.ts';

describe('TwilioSmsAdapter send', () => {
  it('connects and sends an SMS via the port, returning a MessageRef', async () => {
    const channel = makeChannelId('sms', 'ml-bot');
    const port = new MockTwilioSmsPort();
    const a = new TwilioSmsAdapter({ channel, port, from: '+15559990000', pollIntervalMs: 0 });
    await a.connect();
    expect(a.state().state).toBe('connected');
    const ref = await a.sendText({ channel, id: '+15551230000' }, 'hello');
    expect(ref.channel).toBe(channel);
    expect(ref.conversation).toBe('+15551230000');
    expect(port.sent[0]).toMatchObject({ to: '+15551230000', from: '+15559990000', body: 'hello' });
  });
});
```

- [ ] **Step 2: Run; expect FAIL.**

- [ ] **Step 3: Implement** `src/transport/twilio/adapter.ts` mirroring `MinimalTextAdapter` (capabilities/health/listeners/on/transitionTo identical in shape; `kind:'sms'`, `auth:'token'`, `extensions:new Set()`, `maxTextLength:1600`). `connect()` calls `port.verifyCredentials()` then transitions to `connected` (or `auth_required` on throw). `sendText()` calls `port.sendSms({ to: target.id, from: this.from, messagingServiceSid: this.mss, body: text })` and returns `{ channel, conversation: target.id, id: result.sid }`. Constructor takes `{ channel, port, from?, messagingServiceSid?, pollIntervalMs }`. (Inbound poll loop added in Task 6 — leave `startPolling()` unimplemented/no-op when `pollIntervalMs===0`.) Map a `port.sendSms` throw to `emit('error', new PermanentProviderError({ channelId: channel, operation:'sendText', correlationId, scope:'request', message }))` — confirm the error class + payload fields against `src/transport/contract/errors.ts` first.

- [ ] **Step 4: Run; expect PASS.** `npm run typecheck`.
- [ ] **Step 5: Commit** — `git add -- src/transport/twilio/adapter.ts tests/transport/twilio/adapter.send.test.ts && git commit -m "feat(twilio): SMS adapter send path"`

---

### Task 6: Inbound polling → `InboundMessage`

**Files:**
- Modify: `src/transport/twilio/adapter.ts`
- Test: `tests/transport/twilio/adapter.inbound.test.ts`

> Before writing: open `src/transport/contract/events.ts` to fill EVERY `InboundMessage` field (`ref, conversation, sender, fromMe, text, attachments, timestamp, inboundEventKey, transportTimestamp, ingestSeq`). `inboundEventKey` must be stable+unique (use the Twilio message SID) for dedup; `ingestSeq` is a monotonic counter.

- [ ] **Step 1: Failing test**
```typescript
// tests/transport/twilio/adapter.inbound.test.ts
import { describe, it, expect, vi } from 'vitest';
import { makeChannelId } from '../../../src/core/transport-refs.ts';
import { TwilioSmsAdapter } from '../../../src/transport/twilio/adapter.ts';
import { MockTwilioSmsPort } from '../../../src/transport/twilio/testing/mock-port.ts';

describe('TwilioSmsAdapter inbound poll', () => {
  it('emits an InboundMessage per polled inbound SMS, deduped by sid', async () => {
    vi.useFakeTimers();
    const channel = makeChannelId('sms', 'ml-bot');
    const port = new MockTwilioSmsPort();
    const a = new TwilioSmsAdapter({ channel, port, from: '+15559990000', pollIntervalMs: 1000 });
    const got: string[] = [];
    a.on('message', (m) => { if (m.text) got.push(m.text); });
    await a.connect();
    port.injectInbound({ sid: 'SMa', from: '+15551230000', to: '+15559990000', body: 'one', sentAt: new Date() });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000); // second tick: same sid must NOT re-emit
    await a.disconnect();
    expect(got).toEqual(['one']);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run; expect FAIL.**

- [ ] **Step 3: Implement** the poll loop: on `connect()` (when `pollIntervalMs>0`) start `setInterval`; each tick `await port.listInboundSince(this.lastPolledAt)`, skip SIDs in a `seen: Set<string>`, and for each new one `emit('message', buildInboundMessage(sms))`. `buildInboundMessage` constructs the full `InboundMessage`: `ref:{channel,conversation:sms.from,id:sms.sid}`, `conversation:{channel,id:sms.from}`, `sender:{channel,id:sms.from}`, `fromMe:false`, `text:sms.body`, `attachments:[]`, `timestamp:sms.sentAt`, `inboundEventKey:sms.sid`, `transportTimestamp:sms.sentAt`, `ingestSeq:++this.ingestSeq`. `disconnect()` clears the interval.

- [ ] **Step 4: Run; expect PASS.** `npm run typecheck`.
- [ ] **Step 5: Commit** — `git add -- src/transport/twilio/adapter.ts tests/transport/twilio/adapter.inbound.test.ts && git commit -m "feat(twilio): inbound SMS polling -> InboundMessage"`

---

### Task 7: Real SDK-backed port (`twilio` npm)

**Files:**
- Create: `src/transport/twilio/sdk-port.ts`
- Modify: `package.json` (add `"twilio"` dependency)
- Test: `tests/transport/twilio/sdk-port.test.ts` (constructs against a stubbed `twilio` client; no network)

> Confirm the current `twilio` SDK call shapes against `docs/twilio-kb/sdks-cli-auth.md` + `messaging-sms.md` (Messages.create `{to, from|messagingServiceSid, body}`; list received messages with `to=<number>` filter). Resolve the auth token via `lookupCredential(authTokenService)` from `src/lib/keyring.ts` — never inline.

- [ ] **Step 1: Failing test** — inject a fake `twilio` client object exposing `messages.create` + `messages.list`; assert `sendSms`/`listInboundSince` map onto them and that the token came from a `lookupCredential` stub.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** `SdkTwilioSmsPort implements TwilioSmsPort` wrapping the SDK; constructor takes `{ accountSid, authTokenService, defaultFrom?, messagingServiceSid? }`, resolves the token via keyring, throws a clear error if absent (fail-closed). `verifyCredentials()` → `client.api.v2010.accounts(accountSid).fetch()`.
- [ ] **Step 4: Run; expect PASS.** `npm run typecheck`.
- [ ] **Step 5: Commit** — `git add -- src/transport/twilio/sdk-port.ts package.json tests/transport/twilio/sdk-port.test.ts && git commit -m "feat(twilio): real SDK-backed SMS port"`

---

### Task 8: Config validation rules

**Files:**
- Modify: `src/core/agent-config-validator.ts`
- Test: `tests/core/agent-config-validator.twilio.test.ts`

> Before writing: read `src/core/agent-config-validator.ts` to copy its `err(field, msg)` helper, the validator-context signature, and where existing validators (provider, pinecone) are invoked, then add `validateTransportConfig` in the same style and call-site.

- [ ] **Step 1: Failing test** — assert: `transport` must be in `TRANSPORT_IDS`; `transport:'twilio'` requires object `twilioConfig`; `accountSid` matches `^AC[0-9a-f]{32}$`; `phoneNumber` matches `^\+[1-9]\d{6,14}$` unless `messagingServiceSid` (`^MG[0-9a-f]{32}$`) is set; `authTokenService` is a non-empty string; `inboundMode==='webhook'` is rejected in Stage 1 with remediation text “webhook inbound is not yet supported; use inboundMode:'poll'”; `pollIntervalMs>=5000`. Each returns the exact `err(...)`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** `validateTransportConfig(raw, ctx)` returning the first `err` or `null`, wired into the same place provider/pinecone validators run (load/create/patch/discovery).
- [ ] **Step 4: Run; expect PASS.** `npm run typecheck` + `npm test -- tests/core/agent-config-validator.twilio.test.ts`.
- [ ] **Step 5: Commit** — `git add -- src/core/agent-config-validator.ts tests/core/agent-config-validator.twilio.test.ts && git commit -m "feat(config): validate twilio transport config"`

---

### Task 9: Config loader + `InstanceConfig` fields

**Files:**
- Modify: `src/instance-loader.ts` (add `transport?`, `twilioConfig?` to `InstanceConfig`)
- Modify: `src/config.ts` (add `resolveTwilioSmsConfig()` + export `transport`/`twilioConfig` on the config object with defaults, mirroring `agentProvider`/`resolveMemoryConfig`)
- Test: `tests/config.twilio.test.ts`

> Before writing: read the `resolveMemoryConfig`/`agentProvider` sections of `src/config.ts` and the `InstanceConfig` interface in `src/instance-loader.ts`; mirror their exact style (`stringProp`/`numberProp` helpers, `?? default`).

- [ ] **Step 1: Failing test** — given an instance object with a `twilioConfig`, `resolveTwilioSmsConfig` returns a fully-defaulted `TwilioSmsConfig` (merges `DEFAULT_TWILIO_SMS`); absent → `undefined`; `transport` defaults to `'baileys'`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** the resolver + interface fields + config exports.
- [ ] **Step 4: Run; expect PASS.** `npm run typecheck:all`.
- [ ] **Step 5: Commit** — `git add -- src/config.ts src/instance-loader.ts tests/config.twilio.test.ts && git commit -m "feat(config): load twilio transport config"`

---

### Task 10: Transport factory switch (wire it in)

**Files:**
- Modify: `src/main.ts` (or the module that constructs the `TransportAdapter` — find it: `grep -rn "new BaileysConnection\|TransportAdapter" src --include=*.ts | grep -v contract | grep -v test`)
- Test: `tests/transport/factory.test.ts`

> Before writing: read the existing adapter construction site; add an exhaustive `switch (config.transport)` using `assertNeverTransport`. For `'twilio'`, build `new TwilioSmsAdapter({ channel: makeChannelId('sms', twilioConfig.account), port: new SdkTwilioSmsPort({...twilioConfig}), from: twilioConfig.phoneNumber, messagingServiceSid: twilioConfig.messagingServiceSid, pollIntervalMs: twilioConfig.pollIntervalMs })`. Keep the Baileys arm exactly as-is.

- [ ] **Step 1: Failing test** — a factory function returns a `TwilioSmsAdapter` when `transport:'twilio'` (+ valid config) and a Baileys adapter (or its existing type) when `'baileys'`; unknown id is a compile error via `assertNeverTransport`. Use the mock port via a factory injection point so the test needs no network.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement** the switch + a `createTransport(config, deps)` seam that allows injecting the port in tests.
- [ ] **Step 4: Run; expect PASS.** `npm run typecheck` + full `npm test -- --pool=forks`.
- [ ] **Step 5: Commit** — `git add -- src/main.ts src/transport/factory.ts tests/transport/factory.test.ts && git commit -m "feat(transport): select twilio sms adapter by config"`

---

### Task 11: Docs (PR-discipline co-update)

**Files:**
- Modify: `docs/configuration.md` (Twilio transport section + example instance.json)
- Create: `docs/runbooks/twilio-transport.md` (enable/operate/poll-mode/limits; explicitly “webhook + voice = Stage 2”)

- [ ] **Step 1:** Add the `transport:"twilio"` config block + field table to `docs/configuration.md`, mirroring the provider section format.
- [ ] **Step 2:** Write the runbook (prereqs: keyring `authTokenService`, an A2P-registered number for real SMS — link `docs/twilio-kb/a2p-10dlc.md`; poll-mode latency note).
- [ ] **Step 3:** Run the PR-discipline check: `git diff --name-only origin/main..HEAD | xargs -I{} grep -l "not yet wired\|TODO\|not yet implemented\|runtime gap" docs/runbooks/ 2>/dev/null` — resolve any matches.
- [ ] **Step 4: Commit** — `git add -- docs/configuration.md docs/runbooks/twilio-transport.md && git commit -m "docs(twilio): sms transport configuration + runbook"`

---

## Self-review (against the spec)
- **Coverage:** config-first (Tasks 1–4,8,9) ✓ · adapter send/inbound (5,6) ✓ · keyring-only creds (4,7) ✓ · exhaustive switch (2,10) ✓ · mock + tests throughout ✓ · docs (11) ✓. **Deferred per decomposition:** webhook inbound + Voice (Stage 2), enforcement fitness rules + self-review/escalation contract (Stage 3 on `ff038-eslint-ring`), failover block, console UI.
- **Types consistent:** `TransportId`, `TwilioSmsConfig`, `TwilioSmsPort`, `InboundSms`, `TwilioSmsAdapter`, `makeChannelId('sms',…)`, `InboundMessage` fields — same names used across tasks.
- **Read-then-mirror tasks (8,9,10)** edit large existing files; each instructs reading the specific section first to avoid transcription drift — the concrete *additions* (rules, resolver, switch arm) are specified, not deferred.

## Open follow-ons (own plans)
- **Stage 2 — Voice:** webhook inbound mode (signature-validated routes on the WhatSoup HTTP server), `placeCall`, voicemail recording→transcript→`InboundMessage` (`'voice'` attachment), live-voice requires webhook.
- **Stage 3 — Enforcement (on `ff038-eslint-ring`):** `transport.twilio-credential-gate`, `transport.webhook-signature-required`, `invariant.no-outbound-without-consent`, `transport.destructive-op-gate`, config-invariant guards, per-iteration self-review artifact + failing guard, bounded-repair + escalation triggers, add `twilio` to `arch.approved-api-client`.
