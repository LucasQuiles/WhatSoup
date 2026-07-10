# Privacy, Erasure, and Media Confinement Implementation Plan

**Status:** Pending implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make routine logs metadata-only, make message deletion propagate through enrichment and local secondary telemetry, and confine every cached-media read to the canonical managed media root.

**Architecture:** Implement three independently reviewable PRs in risk order: WS-A06 adds a central last-line log sanitizer plus removal of known free-text call sites; WS-A07 makes tool-call durability metadata-only and gives message deletion a transactional erasure boundary that races safely with enrichment; WS-A08 adds one descriptor-pinned managed-media reader used by cached download and transcription. Each PR starts from a freshly fetched `origin/main`, is independently revertible, and carries synthetic negative canaries at the exact persistence or read seam.

**Tech Stack:** TypeScript 5.9, Node.js 24.15.0, npm 11.12.1, Pino 9, Vitest 4, `node:sqlite`, POSIX descriptor flags (`O_NOFOLLOW`), SQLite JSON1.

## Global Constraints

- Audited base is `7330bafbe77d7a15febce32eb09b304e8778862f`; fetch `origin` immediately before creating each branch and record the actual base SHA in the PR receipt.
- Publication boundary is local branch and commits only; publishing a branch or Draft PR requires explicit approval.
- Preserve one coherent behavioral idea per PR and keep every PR independently revertible.
- The numbered schema sequence is WS-A02 migration 37, WS-A04 migration 38, WS-A05 migration 39, then WS-A07 migration 40; if current main has advanced, reserve fresh consecutive versions and update all four plan references before implementation.
- Use the repository-pinned Node.js `24.15.0` and npm `11.12.1` through `scripts/run-with-pinned-npm.sh`; never use the workstation's ambient Node/npm for evidence.
- WS-A06 starts only after PR #1714 lands or closes because #1714 may move outbound-redaction contracts; rebase the log work onto its final form rather than editing #1714's branch.
- PR #1715 does not block WS-A06/A07/A08, but every branch still starts from main after its current disposition is known so deploy-script changes are not accidentally overwritten.
- PR #1716 does not block WS-A06/A07/A08, but rerun the full release gate after rebasing because it changes runtime/health/hygiene surfaces used by the same test program.
- Before treating any existing branch as superseded, run `git range-diff` and `git cherry -v`; do not delete a branch in this program.
- No private message/model-output preview, raw JID, raw phone, access token, URL userinfo/query/fragment, or malformed MCP request bytes may enter routine logs.
- Synthetic privacy canaries must be invented test values; tests must not use real chats, phones, credentials, media, providers, or keychains.
- Deletion must fail closed at selection, pre-extraction, pre-validation, queue insertion, and local secondary-store boundaries.
- Cached media must be opened once, refused when symlinked or non-regular, canonicalized beneath `config.mediaDir`, inode-checked, and read from the validated descriptor.
- Do not weaken an assertion that pins unsafe behavior; replace it with the new invariant and retain a negative assertion proving the old outcome is impossible.
- A skipped, masked, timed-out, or environment-missing check is inconclusive and must be reported as a proof gap.

---

## File Structure

### WS-A06 — metadata-only logging

- Create `src/lib/log-safety.ts`: pure recursive sink sanitizer, stable identity hashing, and URL metadata normalization.
- Modify `src/logger.ts`: apply the sanitizer through one Pino `logMethod` hook before stdout and rolling-file fan-out.
- Create `tests/lib/log-safety.test.ts`: pure canary corpus, recursion, error, Buffer, URL, and identity tests.
- Create `tests/fixtures/log-privacy-canary.ts`: real-Pino subprocess fixture for stdout and rolling-file capture.
- Create `tests/logger-privacy.test.ts`: end-to-end sink canary test.
- Modify `tests/logger.test.ts`: pin that both transport and stdout-only Pino factories receive the same hook.
- Modify `src/runtimes/chat/runtime.ts`, `src/runtimes/chat/media/links.ts`, `src/lib/ssrf-fetch.ts`, `src/mcp/socket-server.ts`, `src/runtimes/chat/providers/anthropic.ts`, and `src/runtimes/chat/providers/openai.ts`: remove known content-bearing log fields at source.
- Modify `tests/runtimes/chat/runtime.test.ts`, `tests/runtimes/chat/media/links-extraction.test.ts`, and `tests/mcp/socket-server.test.ts`: call-site negative canaries.
- Modify `docs/configuration.md`: document the metadata-only logging contract.

### WS-A07 — erasure propagation

- Modify `src/core/database.ts`: migration 40 scrubs historical tool content; deletion methods become atomic message-plus-secondary-store operations.
- Modify `src/core/durability.ts`: discard tool input/result content at the storage boundary.
- Modify `src/mcp/registry.ts`: stop serializing parameters/results for durability telemetry.
- Create `src/core/erasure.ts`: local fact-queue erasure and message-liveness helpers.
- Modify `src/core/messages.ts`: exclude deleted rows from enrichment selection/counts and expose live-PK revalidation.
- Modify `src/runtimes/chat/enrichment/fact-export-queue.ts`: reject a fact atomically when any source message is missing or deleted.
- Modify `src/runtimes/chat/enrichment/poller.ts`: revalidate before extraction, validation, and export.
- Modify `tests/core/migration-safety.test.ts`, `tests/core/durability-tools.test.ts`, `tests/mcp/registry-erasure-redaction.test.ts`, `tests/core/messages.test.ts`, `tests/core/database.test.ts`, `tests/runtimes/chat/enrichment/fact-export-queue.test.ts`, and `tests/runtimes/chat/enrichment/poller.test.ts`: historical scrub, deletion, and race proofs.
- Modify `docs/durability.md`: append the explicit local/remote erasure matrix and residual boundary.
- Modify `docs/configuration.md`: migration 40 and telemetry lifecycle.

### WS-A08 — cached-media confinement

- Create `src/core/managed-media-read.ts`: descriptor-pinned inspect/read API for managed media.
- Modify `src/mcp/tools/media.ts`: use the shared API for `download_media` cache hits and `transcribe_audio` reads.
- Create `tests/core/managed-media-read.test.ts`: regular-file, traversal, outside-root, symlink, FIFO/directory, missing-root, and size cases.
- Modify `tests/mcp/tools/media.test.ts`: prove the provider is never invoked with outside/symlink bytes.
- Modify `docs/durability.md`: managed-media read contract and operator diagnostics.

---

### Task 1: Build the Metadata-Only Log Sanitizer (WS-A06)

**Files:**
- Create: `src/lib/log-safety.ts`
- Test: `tests/lib/log-safety.test.ts`

**Interfaces:**
- Consumes: `shortHash(value: string, length?: number): string` from `src/lib/short-hash.ts`.
- Produces: `hashLogIdentity(value: string): string`, `sanitizeUrlForLog(value: string): string`, `sanitizeLogText(value: string): string`, `sanitizeLogValue(value: unknown, key?: string): unknown`, and `sanitizeLogArgs(args: readonly unknown[]): unknown[]`.

- [ ] **Step 1: Write the failing sanitizer tests**

```ts
// tests/lib/log-safety.test.ts
import { describe, expect, it } from 'vitest';
import {
  hashLogIdentity,
  sanitizeLogArgs,
  sanitizeLogText,
  sanitizeLogValue,
  sanitizeUrlForLog,
} from '../../src/lib/log-safety.ts';

const MESSAGE = 'PRIVATE_MESSAGE_CANARY_7f7d1b';
const PHONE_DIGITS = ['1555', '1234567'].join('');
const JID = `${PHONE_DIGITS}@${['s', 'whatsapp', 'net'].join('.')}`;
const PHONE = `+${PHONE_DIGITS}`;
const TOKEN = 'access-canary-2c307bea';
const URL = `https://${['alice', 'pw'].join(':')}@example.test/private?${['access', 'token'].join('_')}=${TOKEN}#${MESSAGE}`;

describe('log safety', () => {
  it('hashes an identity deterministically without retaining its source', () => {
    expect(hashLogIdentity(JID)).toMatch(/^id:[a-f0-9]{12}$/);
    expect(hashLogIdentity(JID)).toBe(hashLogIdentity(JID));
    expect(hashLogIdentity(JID)).not.toContain('15551234567');
  });

  it('keeps URL origin/path metadata and removes userinfo, query, and fragment', () => {
    expect(sanitizeUrlForLog(URL)).toBe('https://example.test/private');
    expect(sanitizeUrlForLog('not a URL')).toBe('[invalid-url]');
  });

  it('redacts content keys, hashes identity keys, and censors secret keys recursively', () => {
    const output = sanitizeLogValue({
      responseText: MESSAGE,
      nested: {
        chatJid: JID,
        phone: PHONE,
        accessToken: TOKEN,
        url: URL,
      },
    }) as Record<string, unknown>;
    const bytes = JSON.stringify(output);
    for (const canary of [MESSAGE, JID, PHONE, TOKEN, 'alice:pw', 'access_token=']) {
      expect(bytes).not.toContain(canary);
    }
    expect(output.responseText).toBe('[REDACTED_CONTENT]');
    expect(bytes).toContain('https://example.test/private');
    expect(bytes).toMatch(/id:[a-f0-9]{12}/);
  });

  it('sanitizes free strings, errors, buffers, and cycles without throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const output = sanitizeLogArgs([
      `Bearer ${TOKEN} contact ${PHONE} at ${URL}`,
      Object.assign(new Error(`request for ${JID} used ${TOKEN}`), { code: 'EACCES' }),
      Buffer.from(MESSAGE),
      cyclic,
    ]);
    const bytes = JSON.stringify(output);
    for (const canary of [MESSAGE, JID, PHONE, TOKEN, 'alice:pw', 'access_token=']) {
      expect(bytes).not.toContain(canary);
    }
    expect(bytes).toContain('EACCES');
    expect(bytes).toContain('[Circular]');
    expect(bytes).toContain('"length":29');
  });

  it('does not redact ordinary counters, years, component names, or static messages', () => {
    expect(sanitizeLogText('processed 42 messages in 2026')).toBe('processed 42 messages in 2026');
    expect(sanitizeLogValue({ component: 'enrichment', count: 42, year: 2026 })).toEqual({
      component: 'enrichment',
      count: 42,
      year: 2026,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails for the missing module**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/lib/log-safety.test.ts --pool=forks`

Expected: FAIL with `Cannot find module '../../src/lib/log-safety.ts'`; zero matching tests may not be accepted as evidence.

- [ ] **Step 3: Implement the pure sanitizer**

```ts
// src/lib/log-safety.ts
import { shortHash } from './short-hash.ts';

const CONTENT_KEYS = new Set([
  'body',
  'caption',
  'content',
  'line',
  'messageText',
  'payload',
  'preview',
  'prompt',
  'raw',
  'rawOutput',
  'requestBody',
  'response',
  'responseText',
  'result',
  'text',
  'toolInput',
  'tool_input',
  'transcript',
]);

const URL_KEYS = new Set(['href', 'requestUrl', 'targetUrl', 'url']);
const SECRET_KEY = /(?:api[_-]?key|authorization|cookie|credential|password|passphrase|private[_-]?key|secret|session[_-]?token|token)$/i;
const IDENTITY_KEY = /(?:actorJid|chatJid|conversationKey|deliveryJid|jid|ownerJid|phone|senderJid|subjectId)$/i;
const URL_IN_TEXT = /https?:\/\/[^\s<>{}\[\]"']+/gi;
const AUTH_IN_TEXT = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const EMAIL_IN_TEXT = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const JID_IN_TEXT = /\b[^\s@]+@(?:g\.us|lid|s\.whatsapp\.net)\b/gi;
const PHONE_IN_TEXT = /(?<![A-Za-z0-9])\+?\d(?:[\s().-]*\d){8,14}(?![A-Za-z0-9])/g;
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|password|secret|token))\s*[:=]\s*[^\s,;]+/gi;

export function hashLogIdentity(value: string): string {
  return `id:${shortHash(value, 12)}`;
}

export function sanitizeUrlForLog(value: string): string {
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

export function sanitizeLogText(value: string): string {
  return value
    .replace(URL_IN_TEXT, (url) => sanitizeUrlForLog(url))
    .replace(AUTH_IN_TEXT, '[REDACTED_AUTH]')
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .replace(EMAIL_IN_TEXT, '[REDACTED_EMAIL]')
    .replace(JID_IN_TEXT, (jid) => hashLogIdentity(jid))
    .replace(PHONE_IN_TEXT, (phone) => hashLogIdentity(phone));
}

function sanitize(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
): unknown {
  if (key && CONTENT_KEYS.has(key)) return '[REDACTED_CONTENT]';
  if (key && SECRET_KEY.test(key)) return '[REDACTED_SECRET]';
  if (typeof value === 'string' && key && IDENTITY_KEY.test(key)) return hashLogIdentity(value);
  if (typeof value === 'string' && key && URL_KEYS.has(key)) return sanitizeUrlForLog(value);
  if (typeof value === 'string') return sanitizeLogText(value);
  if (value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return { type: 'Buffer', length: value.length };
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    const errorCode = (value as NodeJS.ErrnoException).code;
    return {
      type: value.name,
      ...(errorCode ? { code: errorCode } : {}),
      message: sanitizeLogText(value.message),
    };
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, undefined, seen));
  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    output[childKey] = sanitize(childValue, childKey, seen);
  }
  return output;
}

export function sanitizeLogValue(value: unknown, key?: string): unknown {
  return sanitize(value, key, new WeakSet<object>());
}

export function sanitizeLogArgs(args: readonly unknown[]): unknown[] {
  return args.map((arg) => sanitizeLogValue(arg));
}
```

- [ ] **Step 4: Run the focused test**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/lib/log-safety.test.ts --pool=forks`

Expected: PASS, including the exact canary-absence loop and the benign-counter case.

- [ ] **Step 5: Run type validation**

Run: `bash scripts/run-with-pinned-npm.sh run typecheck:all`

Expected: exit 0 with no TypeScript diagnostics.

- [ ] **Step 6: Commit the primitive**

```bash
git add src/lib/log-safety.ts tests/lib/log-safety.test.ts
git commit -m "security(logging): add metadata-only sink sanitizer"
```

### Task 2: Enforce the Sanitizer Before Every Pino Sink (WS-A06)

**Files:**
- Modify: `src/logger.ts:1-49`
- Create: `tests/fixtures/log-privacy-canary.ts`
- Create: `tests/logger-privacy.test.ts`
- Modify: `tests/logger.test.ts:68-99,217-258`

**Interfaces:**
- Consumes: `sanitizeLogArgs(args: readonly unknown[]): unknown[]` from Task 1.
- Produces: one `LoggerOptions` object used identically for stdout-only Pino and the stdout-plus-rolling-file transport.

- [ ] **Step 1: Write the real-sink privacy fixture and failing integration test**

```ts
// tests/fixtures/log-privacy-canary.ts
import logger, { flushLogger } from '../../src/logger.ts';

const phoneDigits = ['1555', '1234567'].join('');
const tokenKey = ['access', 'Token'].join('');
const queryKey = ['access', 'token'].join('_');
const tokenValue = ['access', 'canary', '2c307bea'].join('-');

logger.info({
  event: 'privacy_canary',
  messageText: 'PRIVATE_MESSAGE_CANARY_7f7d1b',
  chatJid: `${phoneDigits}@${['s', 'whatsapp', 'net'].join('.')}`,
  phone: `+${phoneDigits}`,
  [tokenKey]: tokenValue,
  url: `https://${['alice', 'pw'].join(':')}@example.test/private?${queryKey}=${tokenValue}#PRIVATE_MESSAGE_CANARY_7f7d1b`,
  line: JSON.stringify({ [tokenKey]: tokenValue }),
}, 'privacy canary');

await flushLogger();
```

```ts
// tests/logger-privacy.test.ts
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const fixture = resolve('tests/fixtures/log-privacy-canary.ts');
const forbidden = [
  'PRIVATE_MESSAGE_CANARY_7f7d1b',
  '15551234567@s.whatsapp.net',
  '+15551234567',
  'access-canary-2c307bea',
  'alice:pw',
  'access_token=',
];

function filesUnder(root: string): string {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((entry) => join(root, entry))
    .filter((entry) => statSync(entry).isFile())
    .map((entry) => readFileSync(entry, 'utf8'))
    .join('\n');
}

function runFixture(logDir?: string): string {
  const env = { ...process.env, LOG_LEVEL: 'info' };
  if (logDir) env.LOG_DIR = logDir;
  else delete env.LOG_DIR;
  const child = spawnSync(
    process.execPath,
    ['--no-warnings', '--experimental-strip-types', fixture],
    { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000 },
  );
  expect(child.status, child.stderr).toBe(0);
  return [child.stdout, child.stderr, logDir ? filesUnder(logDir) : ''].join('\n');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('logger privacy sinks', () => {
  it.each(['stdout', 'stdout-and-roll'] as const)('removes every synthetic canary from %s', (mode) => {
    const logDir = mode === 'stdout-and-roll'
      ? mkdtempSync(join(tmpdir(), 'whatsoup-log-privacy-'))
      : undefined;
    if (logDir) roots.push(logDir);
    const output = runFixture(logDir);
    expect(output).toContain('privacy_canary');
    expect(output).toContain('https://example.test/private');
    expect(output).toMatch(/id:[a-f0-9]{12}/);
    for (const canary of forbidden) expect(output).not.toContain(canary);
  });
});
```

- [ ] **Step 2: Run the integration test to demonstrate the current leak**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/logger-privacy.test.ts --pool=forks`

Expected: FAIL because stdout and the rolling file contain at least the message, JID, phone, token, and full URL canaries.

- [ ] **Step 3: Wire one hook into both logger construction paths**

Replace the logger construction in `src/logger.ts` with this shared options object; leave transport setup and `flushLogger` behavior otherwise unchanged:

```ts
import pino, { type LoggerOptions } from 'pino';
import { join } from 'node:path';
import { sanitizeLogArgs } from './lib/log-safety.ts';

const level = process.env.LOG_LEVEL ?? 'info';

const loggerOptions: LoggerOptions = {
  level,
  hooks: {
    logMethod(inputArgs, method) {
      Reflect.apply(method, this, sanitizeLogArgs(inputArgs));
    },
  },
};

```

Insert `loggerOptions` immediately after the existing `level` declaration. Keep the already-tested transport construction at lines 6-41 byte-for-byte, then replace line 43 with:

```ts
const logger = transport ? pino(loggerOptions, transport) : pino(loggerOptions);
```

Update the two Pino factory assertions in `tests/logger.test.ts` to capture and invoke the hook instead of expecting the old `{ level }` literal:

```ts
const options = pinoFactory.mock.calls[0][0] as import('pino').LoggerOptions;
expect(options.level).toBe('debug');
expect(options.hooks?.logMethod).toEqual(expect.any(Function));
expect(pinoFactory).toHaveBeenCalledWith(options, transport);

const method = vi.fn();
options.hooks!.logMethod!.call({}, [{ chatJid: '15551234567@s.whatsapp.net' }], method);
expect(JSON.stringify(method.mock.calls)).not.toContain('15551234567');
```

Use the same shape in the transport-fallback assertion and expect `pinoFactory` to receive `options` without a destination argument.

- [ ] **Step 4: Run logger tests and both real sinks**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/lib/log-safety.test.ts tests/logger.test.ts tests/logger-privacy.test.ts --pool=forks`

Expected: PASS; both parameterized sink cases contain `privacy_canary` metadata but none of the six forbidden canaries.

- [ ] **Step 5: Commit the sink enforcement**

```bash
git add src/logger.ts tests/logger.test.ts tests/logger-privacy.test.ts tests/fixtures/log-privacy-canary.ts
git commit -m "security(logging): sanitize before stdout and file sinks"
```

### Task 3: Remove Known Content-Bearing Log Call Sites (WS-A06)

**Files:**
- Modify: `src/runtimes/chat/runtime.ts:501-505`
- Modify: `src/runtimes/chat/media/links.ts:44-172`
- Modify: `src/lib/ssrf-fetch.ts:308-356`
- Modify: `src/mcp/socket-server.ts:132-151`
- Modify: `src/runtimes/chat/providers/anthropic.ts:76-100`
- Modify: `src/runtimes/chat/providers/openai.ts:96-118`
- Modify: `tests/runtimes/chat/runtime.test.ts:1222-1238`
- Modify: `tests/runtimes/chat/media/links-extraction.test.ts`
- Modify: `tests/mcp/socket-server.test.ts:449-465`
- Modify: `docs/configuration.md:239-245`

**Interfaces:**
- Consumes: `hashLogIdentity`, `sanitizeUrlForLog`, and `shortHash`.
- Produces: call-site metadata fields `responseHash`, `responseLength`, `url`, `lineHash`, `lineBytes`, `responseId`, `responseModel`, `finishReason`, and `stopReason`; no content field.

- [ ] **Step 1: Replace the unsafe send-failure assertion with a negative canary**

```ts
it('all send attempts fail without logging the response body', async () => {
  vi.useFakeTimers();
  const { handler, messenger, primary } = makeHandler();
  vi.mocked(primary.generate).mockResolvedValue({
    content: 'PRIVATE_SEND_FAILURE_CANARY_6e956a',
    inputTokens: 1,
    outputTokens: 1,
    model: 'test-model',
    durationMs: 1,
  });
  messenger.sendMessage.mockRejectedValue(new Error('permanent failure'));

  await handler.handleMessage(makeIncomingMessage());
  await vi.runAllTimersAsync();
  await drainQueue();

  const call = mockLogError().mock.calls.find(([, message]) =>
    String(message).includes('all send attempts failed'));
  expect(call).toBeDefined();
  const metadata = call![0] as Record<string, unknown>;
  expect(metadata.responseLength).toBe('PRIVATE_SEND_FAILURE_CANARY_6e956a'.length);
  expect(metadata.responseHash).toMatch(/^[a-f0-9]{12}$/);
  expect(metadata).not.toHaveProperty('responseText');
  expect(JSON.stringify(call)).not.toContain('PRIVATE_SEND_FAILURE_CANARY_6e956a');
});
```

- [ ] **Step 2: Run the runtime test to verify the old assertion/behavior fails**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/runtimes/chat/runtime.test.ts -t "without logging the response body" --pool=forks`

Expected: FAIL because the current log contains `responseText` and does not contain `responseHash`/`responseLength`.

- [ ] **Step 3: Replace content-bearing fields with bounded metadata**

Apply these exact call-site shapes:

```ts
// src/runtimes/chat/runtime.ts
import { shortHash } from '../../lib/short-hash.ts';

log.error(
  {
    traceId,
    err: lastSendErr,
    chatJid: msg.chatJid,
    responseHash: shortHash(responseText, 12),
    responseLength: responseText.length,
  },
  'all send attempts failed; tracked outbound payload retained for recovery',
);
```

```ts
// src/runtimes/chat/media/links.ts and src/lib/ssrf-fetch.ts
import { sanitizeUrlForLog } from '../../../lib/log-safety.ts'; // links.ts
// ssrf-fetch.ts uses: import { sanitizeUrlForLog } from './log-safety.ts';

const logUrl = sanitizeUrlForLog(url);
log.warn({ url: logUrl, hostname }, 'Blocked SSRF attempt to private host');
log.warn({ url: logUrl, resolvedIP: address }, 'SSRF: domain resolves to private IP');
log.warn({ err, url: logUrl }, 'Failed to fetch URL — using raw fallback');
log.info({ url: logUrl, fallbackLevel: 'readability' }, 'Link content extracted via readability');
```

Use `logUrl` at every existing URL-bearing log in `links.ts`. In `ssrf-fetch.ts`, compute `logUrl` once after URL parsing and log only `logUrl` plus `hostname`.

```ts
// src/mcp/socket-server.ts
import { shortHash } from '../lib/short-hash.ts';

const lineBytes = Buffer.byteLength(trimmed, 'utf8');
log.warn(
  { lineBytes, lineHash: shortHash(trimmed, 12), errorType: 'json_parse' },
  'failed to parse JSON-RPC message',
);
```

```ts
// src/runtimes/chat/providers/anthropic.ts
logger.error(
  {
    model,
    provider: 'anthropic',
    responseId: response.id,
    responseModel: response.model,
    stopReason: response.stop_reason,
    contentBlockCount: response.content.length,
  },
  'Anthropic returned no content with a non-end_turn stop',
);
```

Use the same metadata for the unexpected-block-type branch, adding `blockType: block.type`; do not include `response`.

```ts
// src/runtimes/chat/providers/openai.ts
logger.error(
  {
    model,
    provider: 'openai',
    responseId: response.id,
    responseModel: response.model,
    choiceCount: response.choices.length,
    finishReason: choice?.finish_reason ?? null,
  },
  'Unexpected response shape from OpenAI',
);
```

Use the same metadata for the non-stop empty-content branch; do not include `response`.

- [ ] **Step 4: Add URL and MCP negative canaries**

In `tests/runtimes/chat/media/links-extraction.test.ts`, hoist the logger spies and add:

```ts
it('never logs URL userinfo, query, or fragment', async () => {
  const url = `https://${['alice', 'pw'].join(':')}@example.com/page?${['to', 'ken'].join('')}=URL_CANARY_143b#fragment-canary`;
  mockDnsLookup.mockResolvedValue({ address: '127.0.0.1', family: 4 });
  await extractLinkContent(url);
  const bytes = JSON.stringify([...mockLogWarn.mock.calls, ...mockLogInfo.mock.calls]);
  expect(bytes).toContain('https://example.com/page');
  expect(bytes).not.toContain('alice:pw');
  expect(bytes).not.toContain('URL_CANARY_143b');
  expect(bytes).not.toContain('fragment-canary');
});
```

In `tests/mcp/socket-server.test.ts`, expose the logger warning spy and extend the malformed-JSON test:

```ts
const malformed = '{"token":"MCP_PARSE_CANARY_f7a9",';
const response = await sendRawJsonRpcLine(socketPath, malformed) as JsonRpcErrorResponse;
expect(response.error.code).toBe(-32700);
const bytes = JSON.stringify(mockLogWarn.mock.calls);
expect(bytes).not.toContain('MCP_PARSE_CANARY_f7a9');
expect(bytes).toContain('lineBytes');
expect(bytes).toContain('lineHash');
```

- [ ] **Step 5: Run all WS-A06 focused tests**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/lib/log-safety.test.ts tests/logger.test.ts tests/logger-privacy.test.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/chat/media/links.test.ts tests/runtimes/chat/media/links-extraction.test.ts tests/mcp/socket-server.test.ts tests/runtimes/chat/providers/anthropic.test.ts tests/runtimes/chat/providers/openai.test.ts --pool=forks`

Expected: PASS; every negative canary is absent and JSON-RPC still returns `-32700`.

- [ ] **Step 6: Document the logging contract**

Add this paragraph after the logging table in `docs/configuration.md`:

```markdown
Routine logs are metadata-only. Before a record reaches stdout/journald or the rolling-file sink, WhatSoup hashes identity fields, removes URL userinfo/query/fragment, censors secret-bearing fields, and replaces content-bearing fields with a fixed marker. Call sites must still log lengths, stable short hashes, bounded status/error classes, and timings instead of message bodies, model output, malformed request bytes, tool parameters, or tool results. Debug level does not relax this contract.
```

- [ ] **Step 7: Run typecheck and commit WS-A06 call-site hardening**

Run: `bash scripts/run-with-pinned-npm.sh run typecheck:all`

Expected: exit 0.

```bash
git add src/runtimes/chat/runtime.ts src/runtimes/chat/media/links.ts src/lib/ssrf-fetch.ts src/mcp/socket-server.ts src/runtimes/chat/providers/anthropic.ts src/runtimes/chat/providers/openai.ts tests/runtimes/chat/runtime.test.ts tests/runtimes/chat/media/links-extraction.test.ts tests/mcp/socket-server.test.ts docs/configuration.md
git commit -m "security(logging): remove content from routine call sites"
```

### Task 4: Make Tool-Call Durability Metadata-Only, Including Historical Rows (WS-A07)

**Files:**
- Modify: `src/core/database.ts:556-737,884-918`
- Modify: `src/core/durability.ts:256-263,618-634`
- Modify: `src/mcp/registry.ts:21-43,443-495`
- Modify: `tests/core/migration-safety.test.ts:44,1100-1175,1511-1585`
- Modify: `tests/core/durability-tools.test.ts`
- Modify: `tests/mcp/registry-erasure-redaction.test.ts`
- Modify: `tests/mcp/registry-durability-resilience.test.ts`
- Modify: `docs/configuration.md:1421-1465`

**Interfaces:**
- Consumes: existing `recordToolCall` and `markToolComplete` call graph.
- Produces: persisted `tool_input` values only `[metadata-only]`; persisted `result` values only `[complete]` or `[error]`; migration 40 irreversibly scrubs all pre-existing content.

- [ ] **Step 1: Write the failing durability-boundary test**

Add this test to `tests/core/durability-tools.test.ts`:

```ts
it('never persists tool parameters or results even when a caller supplies them', () => {
  const inputCanary = 'TOOL_INPUT_CANARY_d1c2';
  const resultCanary = 'TOOL_RESULT_CANARY_41a8';
  const id = engine.recordToolCall(
    'conv-privacy',
    'list_messages',
    JSON.stringify({ query: inputCanary }),
    'read_only',
  );
  engine.markToolComplete(id, JSON.stringify({ messages: [resultCanary] }));

  const row = db.raw.prepare(
    'SELECT tool_input, result FROM tool_calls WHERE id = ?',
  ).get(id) as { tool_input: string; result: string };
  expect(row).toEqual({ tool_input: '[metadata-only]', result: '[complete]' });
  expect(JSON.stringify(row)).not.toContain(inputCanary);
  expect(JSON.stringify(row)).not.toContain(resultCanary);
});
```

- [ ] **Step 2: Run it to prove the secondary archive exists**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/durability-tools.test.ts -t "never persists tool parameters" --pool=forks`

Expected: FAIL because the row currently contains both canaries.

- [ ] **Step 3: Enforce fixed markers inside `DurabilityEngine`**

```ts
// src/core/durability.ts
const TOOL_INPUT_MARKER = '[metadata-only]';
const TOOL_RESULT_COMPLETE = '[complete]';
const TOOL_RESULT_ERROR = '[error]';

// Prepared statements
recordToolCall: prepare(
  `INSERT INTO tool_calls
     (conversation_key, session_checkpoint_id, tool_name, tool_input, status, replay_policy)
   VALUES (?, ?, ?, '${TOOL_INPUT_MARKER}', 'pending', ?)`,
),
markToolComplete: prepare(
  `UPDATE tool_calls
      SET status = 'complete', result = ?, completed_at = datetime('now'), outbound_op_id = ?
    WHERE id = ?`,
),

recordToolCall(
  conversationKey: string,
  toolName: string,
  _discardedToolInput: string,
  replayPolicy: string,
  checkpointId?: number,
): number {
  const result = this.statements.recordToolCall.run(
    conversationKey,
    checkpointId ?? null,
    toolName,
    replayPolicy,
  );
  const id = Number(result.lastInsertRowid);
  log.debug({ id, toolName, replayPolicy }, 'recordToolCall');
  return id;
}

markToolComplete(id: number, result: string, outboundOpId?: number): void {
  const outcome = result.startsWith('error:') ? TOOL_RESULT_ERROR : TOOL_RESULT_COMPLETE;
  this.statements.markToolComplete.run(outcome, outboundOpId ?? null, id);
}
```

The ignored parameter preserves source compatibility for tests and any local extension, while the storage boundary makes bypass impossible.

- [ ] **Step 4: Stop constructing content strings in `ToolRegistry`**

Replace the erasure-sensitive name set and serialization branches with fixed values:

```ts
const TOOL_INPUT_MARKER = '[metadata-only]';
const TOOL_COMPLETE_MARKER = '[complete]';
const TOOL_ERROR_MARKER = 'error: tool_failed';

// Record path
durabilityId = this.durability.recordToolCall(
  durabilityKey,
  name,
  TOOL_INPUT_MARKER,
  replayPolicy,
);

// Successful handler path
this.durability!.markToolComplete(
  durabilityId,
  isError ? TOOL_ERROR_MARKER : TOOL_COMPLETE_MARKER,
);

// Throw path
this.durability!.markToolComplete(durabilityId, TOOL_ERROR_MARKER);
```

Keep `text` only for the immediate MCP response returned to the authorized caller. Delete `ERASURE_SENSITIVE_TOOL_NAMES`, its comments, and the old redacted marker because every tool now receives the stronger default.

- [ ] **Step 5: Add migration 40 and its historical-canary test**

Add to `src/core/database.ts`:

```ts
function runMigration40(db: DatabaseSync): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_calls'")
    .get() as { name: string } | undefined;
  if (!table) return;
  db.exec(`
    UPDATE tool_calls
       SET tool_input = '[metadata-only]',
           result = CASE
             WHEN result IS NULL THEN NULL
             WHEN result LIKE 'error:%' THEN '[error]'
             ELSE '[complete]'
           END
  `);
}
```

Append `[40, runMigration40]` to `MIGRATIONS` after the inbound, delivery-audit, and scheduler-identity migrations. Change `ALL_MIGRATION_VERSIONS` in `tests/core/migration-safety.test.ts` to `Array.from({ length: 40 }, ...)` and add:

```ts
it('migration 40 irreversibly scrubs historical tool input and result content', () => {
  const path = tmpFile();
  const initial = new Database(path);
  initial.open();
  initial.raw.prepare('DELETE FROM schema_migrations WHERE version = 40').run();
  initial.raw.prepare(`
    INSERT INTO tool_calls
      (conversation_key, tool_name, tool_input, status, result, replay_policy)
    VALUES (?, 'list_messages', ?, 'complete', ?, 'read_only')
  `).run('conversation', '{"query":"HIST_INPUT_CANARY_92a1"}', '{"text":"HIST_RESULT_CANARY_7cf0"}');
  initial.close();

  const migrated = new Database(path);
  migrated.open();
  const row = migrated.raw.prepare(
    'SELECT tool_input, result FROM tool_calls ORDER BY id DESC LIMIT 1',
  ).get() as { tool_input: string; result: string };
  expect(row).toEqual({ tool_input: '[metadata-only]', result: '[complete]' });
  expect(JSON.stringify(row)).not.toMatch(/HIST_(?:INPUT|RESULT)_CANARY/);
  migrated.close();
  cleanup(path);
});
```

Use the `tmpFile` and `cleanup` helpers already defined at the top of that test file.

- [ ] **Step 6: Update registry tests to assert metadata-only defaults**

First make the existing recorder observe completion without storing response bytes:

```ts
markToolComplete: (id: number, result: string) => {
  calls.push({ method: 'markToolComplete', args: [id, result] });
},
```

Replace the non-sensitive raw-input expectation in `tests/mcp/registry-erasure-redaction.test.ts` with:

```ts
it('records metadata-only markers for content-returning and mutating tools alike', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  registry.setDurability(recordingDurability(calls));
  registry.register(makeTool({
    name: 'list_messages',
    schema: z.object({ query: z.string() }),
    handler: async () => ({ text: 'TOOL_RESULT_CANARY_41a8' }),
  }));

  await registry.call(
    'list_messages',
    { query: 'TOOL_INPUT_CANARY_d1c2' },
    makeSession(),
  );

  const bytes = JSON.stringify(calls);
  expect(bytes).toContain('[metadata-only]');
  expect(bytes).toContain('[complete]');
  expect(bytes).not.toContain('TOOL_INPUT_CANARY_d1c2');
  expect(bytes).not.toContain('TOOL_RESULT_CANARY_41a8');
});
```

Update `tests/mcp/registry-durability-resilience.test.ts` to expect `[metadata-only]` for both formerly sensitive and ordinary tools. Retain every resilience assertion that telemetry failure never blocks the tool response.

- [ ] **Step 7: Run migration, durability, and registry suites**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/migration-safety.test.ts tests/core/durability-tools.test.ts tests/core/durability-recovery.test.ts tests/integration/crash-recovery.test.ts tests/mcp/registry.test.ts tests/mcp/registry-erasure-redaction.test.ts tests/mcp/registry-durability-resilience.test.ts tests/mcp/sensitive-flag.test.ts --pool=forks`

Expected: PASS; crash recovery still uses status/replay policy/outbound linkage and never requires stored arguments/results.

- [ ] **Step 8: Document migration 40 and commit**

Append to the migration table in `docs/configuration.md`:

```markdown
| 40 | Irreversibly replaces historical `tool_calls.tool_input`/`result` content with metadata-only outcome markers. Future writes persist only `[metadata-only]`, `[complete]`, or `[error]`; recovery continues to use tool name, status, replay policy, checkpoint, and outbound linkage. |
```

Run: `bash scripts/run-with-pinned-npm.sh run typecheck:all`

Expected: exit 0.

```bash
git add src/core/database.ts src/core/durability.ts src/mcp/registry.ts tests/core/migration-safety.test.ts tests/core/durability-tools.test.ts tests/mcp/registry-erasure-redaction.test.ts tests/mcp/registry-durability-resilience.test.ts docs/configuration.md
git commit -m "security(erasure): make tool durability metadata-only"
```

### Task 5: Make Deletion Atomic Across Enrichment and Local Fact Telemetry (WS-A07)

**Files:**
- Create: `src/core/erasure.ts`
- Modify: `src/core/messages.ts:202-249`
- Modify: `src/core/database.ts:1415-1444`
- Modify: `src/runtimes/chat/enrichment/fact-export-queue.ts:74-95,132-236`
- Modify: `src/runtimes/chat/enrichment/poller.ts:82-190`
- Modify: `tests/core/messages.test.ts:218-305,661-685`
- Modify: `tests/core/database.test.ts:1646-1680,1785-1845`
- Modify: `tests/runtimes/chat/enrichment/fact-export-queue.test.ts`
- Modify: `tests/runtimes/chat/enrichment/poller.test.ts`
- Modify: `docs/durability.md`

**Interfaces:**
- Produces: `liveMessagePks(db, pks): Set<number>`, `allMessagePksLive(db, pks): boolean`, `eraseSecondaryDataForMessagePks(db, pks, conversationKeys): ErasureResult`.
- Changes: `EnqueueFactsResult` gains `erased: number`; successful accounting becomes `attempted === inserted + duplicates + erased`.
- Preserves: `Database.clearChat` and `Database.markMessagesDeleted` continue returning the number of newly soft-deleted messages.

- [ ] **Step 1: Add the failing selection and deletion-race tests**

Add to `tests/core/messages.test.ts`:

```ts
it('excludes soft-deleted rows from enrichment selection and counts', () => {
  storeMessageIfNew(db, makeMsg({ messageId: 'live-enrich', content: 'live' }));
  storeMessageIfNew(db, makeMsg({ messageId: 'gone-enrich', content: 'ERASURE_CANARY_54b3' }));
  db.raw.prepare("UPDATE messages SET deleted_at = datetime('now') WHERE message_id = 'gone-enrich'").run();

  expect(getUnprocessedMessages(db, 100).map((m) => m.messageId)).toEqual(['live-enrich']);
  expect(getUnprocessedCount(db)).toBe(1);
});
```

Add to `tests/runtimes/chat/enrichment/fact-export-queue.test.ts`:

```ts
it('refuses a fact when a source message was deleted before queue insertion', () => {
  db.raw.prepare(`
    INSERT INTO messages
      (chat_jid, conversation_key, sender_jid, message_id, content, is_from_me, timestamp, deleted_at)
    VALUES ('chat@g.us', 'chat_at_g.us', 'sender@s.whatsapp.net', 'deleted-source',
            'ERASURE_CANARY_54b3', 0, 1700000000, datetime('now'))
  `).run();
  const source = db.raw.prepare("SELECT pk FROM messages WHERE message_id='deleted-source'")
    .get() as { pk: number };

  const result = enqueueFacts(db, [makeFact({
    factId: 'erasure-race-fact',
    text: 'ERASURE_CANARY_54b3',
    sourceMessagePks: [source.pk],
  })]);

  expect(result).toEqual({ attempted: 1, inserted: 0, duplicates: 0, erased: 1, failed: 0 });
  expect(db.raw.prepare("SELECT COUNT(*) AS n FROM fact_export_queue WHERE fact_id='erasure-race-fact'").get())
    .toEqual({ n: 0 });
});
```

Add to `tests/core/database.test.ts`:

```ts
it('clearChat purges pending facts and irreversibly redacts terminal fact rows atomically', () => {
  const db = new Database(':memory:');
  db.open();
  db.raw.prepare(`
    INSERT INTO messages
      (chat_jid, conversation_key, sender_jid, message_id, content, is_from_me, timestamp)
    VALUES ('chat@g.us', 'chat_at_g.us', 'sender@s.whatsapp.net', 'erase-source',
            'ERASURE_CANARY_54b3', 0, 1700000000)
  `).run();
  const source = db.raw.prepare("SELECT pk FROM messages WHERE message_id='erase-source'")
    .get() as { pk: number };
  const payload = JSON.stringify({
    text: 'ERASURE_CANARY_54b3', memoryType: 'user_fact', confidence: 0.9,
    senderName: 'ERASURE_NAME_CANARY', supersedesText: '', sourceMessagePks: [source.pk],
  });
  db.raw.prepare(`INSERT INTO fact_export_queue
    (fact_id, chat_jid, sender_jid, payload_json, status)
    VALUES ('pending-canary', 'chat@g.us', 'sender@s.whatsapp.net', ?, 'pending'),
           ('exported-canary', 'chat@g.us', 'sender@s.whatsapp.net', ?, 'exported')`)
    .run(payload, payload);

  expect(db.clearChat('chat_at_g.us')).toBe(1);

  const rows = db.raw.prepare(`SELECT fact_id, chat_jid, sender_jid, payload_json, status
                                FROM fact_export_queue ORDER BY id`).all();
  const bytes = JSON.stringify(rows);
  expect(rows).toEqual([{
    fact_id: expect.stringMatching(/^erased:\d+$/),
    chat_jid: '[erased]',
    sender_jid: null,
    payload_json: '{"erased":true}',
    status: 'erased',
  }]);
  expect(bytes).not.toMatch(/ERASURE_(?:CANARY|NAME_CANARY)|sender@s\.whatsapp\.net|exported-canary/);
  db.close();
});
```

- [ ] **Step 2: Run the three focused tests to verify the current failure**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/messages.test.ts tests/core/database.test.ts tests/runtimes/chat/enrichment/fact-export-queue.test.ts -t "soft-deleted|purges pending facts|refuses a fact" --pool=forks`

Expected: FAIL: deleted rows remain selectable/countable, `clearChat` leaves queue content, and `enqueueFacts` inserts the deleted-source fact.

- [ ] **Step 3: Implement the single erasure helper**

```ts
// src/core/erasure.ts
import type { Database } from './database.ts';

export interface ErasureResult {
  pendingFactsDeleted: number;
  terminalFactsRedacted: number;
  toolCallsRedacted: number;
}

function uniquePks(pks: number[]): number[] {
  return [...new Set(pks.filter((pk) => Number.isInteger(pk) && pk > 0))];
}

export function liveMessagePks(db: Database, pks: number[]): Set<number> {
  const unique = uniquePks(pks);
  if (unique.length === 0) return new Set<number>();
  const placeholders = unique.map(() => '?').join(',');
  const rows = db.raw.prepare(
    `SELECT pk FROM messages WHERE pk IN (${placeholders}) AND deleted_at IS NULL`,
  ).all(...unique) as Array<{ pk: number }>;
  return new Set(rows.map((row) => row.pk));
}

export function allMessagePksLive(db: Database, pks: number[]): boolean {
  const unique = uniquePks(pks);
  return unique.length > 0 && liveMessagePks(db, unique).size === unique.length;
}

export function eraseSecondaryDataForMessagePks(
  db: Database,
  pks: number[],
  conversationKeys: string[],
): ErasureResult {
  const unique = uniquePks(pks);
  const factIds = new Set<number>();
  if (unique.length > 0) {
    const placeholders = unique.map(() => '?').join(',');
    const rows = db.raw.prepare(`
      SELECT DISTINCT f.id
        FROM fact_export_queue AS f, json_each(f.payload_json, '$.sourceMessagePks') AS source
       WHERE CAST(source.value AS INTEGER) IN (${placeholders})
    `).all(...unique) as Array<{ id: number }>;
    for (const row of rows) factIds.add(row.id);
  }

  let pendingFactsDeleted = 0;
  let terminalFactsRedacted = 0;
  if (factIds.size > 0) {
    const ids = [...factIds];
    const placeholders = ids.map(() => '?').join(',');
    pendingFactsDeleted = Number(db.raw.prepare(
      `DELETE FROM fact_export_queue WHERE id IN (${placeholders}) AND status = 'pending'`,
    ).run(...ids).changes);
    terminalFactsRedacted = Number(db.raw.prepare(`
      UPDATE fact_export_queue
         SET fact_id = 'erased:' || id,
             chat_jid = '[erased]',
             sender_jid = NULL,
             namespace = '[erased]',
             payload_json = '{"erased":true}',
             status = 'erased',
             exported_at = NULL
       WHERE id IN (${placeholders}) AND status != 'pending'
    `).run(...ids).changes);
  }

  const keys = [...new Set(conversationKeys.filter(Boolean))];
  let toolCallsRedacted = 0;
  if (keys.length > 0) {
    const placeholders = keys.map(() => '?').join(',');
    toolCallsRedacted = Number(db.raw.prepare(`
      UPDATE tool_calls
         SET tool_input = '[metadata-only]',
             result = CASE WHEN result IS NULL THEN NULL
                           WHEN result = '[error]' THEN '[error]'
                           ELSE '[complete]' END
       WHERE conversation_key IN (${placeholders})
    `).run(...keys).changes);
  }

  return { pendingFactsDeleted, terminalFactsRedacted, toolCallsRedacted };
}
```

- [ ] **Step 4: Exclude deleted rows at the first enrichment seam**

Update both queries in `src/core/messages.ts` and add the exported revalidator:

```ts
export function getUnprocessedMessages(db: Database, limit: number): StoredMessage[] {
  const rows = db.raw.prepare(`
    SELECT * FROM messages
    WHERE enrichment_processed_at IS NULL
      AND is_from_me = 0
      AND deleted_at IS NULL
    ORDER BY timestamp ASC, pk ASC
    LIMIT @limit
  `).all({ limit }) as Record<string, unknown>[];
  return rows.map(rowToStoredMessage);
}

export function getUnprocessedCount(db: Database): number {
  const row = db.raw.prepare(`
    SELECT COUNT(*) AS cnt FROM messages
     WHERE enrichment_processed_at IS NULL
       AND is_from_me = 0
       AND deleted_at IS NULL
  `).get() as { cnt: number };
  return row.cnt;
}
```

- [ ] **Step 5: Make both deletion entry points transactional**

Import `withTransaction` and `eraseSecondaryDataForMessagePks` into `src/core/database.ts`, then replace the methods with:

```ts
clearChat(conversationKey: string): number {
  return withTransaction(this, () => {
    const rows = this.db.prepare(
      `SELECT pk FROM messages WHERE conversation_key = ? AND deleted_at IS NULL`,
    ).all(conversationKey) as Array<{ pk: number }>;
    if (rows.length === 0) return 0;
    const result = this.db.prepare(
      `UPDATE messages SET deleted_at = datetime('now')
       WHERE conversation_key = ? AND deleted_at IS NULL`,
    ).run(conversationKey);
    eraseSecondaryDataForMessagePks(this, rows.map((row) => row.pk), [conversationKey]);
    return Number(result.changes);
  });
}

markMessagesDeleted(messageIds: string[]): number {
  if (messageIds.length === 0) return 0;
  return withTransaction(this, () => {
    const placeholders = messageIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT pk, conversation_key FROM messages
       WHERE message_id IN (${placeholders}) AND deleted_at IS NULL`,
    ).all(...messageIds) as Array<{ pk: number; conversation_key: string }>;
    if (rows.length === 0) return 0;
    const result = this.db.prepare(
      `UPDATE messages SET deleted_at = datetime('now')
       WHERE message_id IN (${placeholders}) AND deleted_at IS NULL`,
    ).run(...messageIds);
    eraseSecondaryDataForMessagePks(
      this,
      rows.map((row) => row.pk),
      rows.map((row) => row.conversation_key),
    );
    return Number(result.changes);
  });
}
```

- [ ] **Step 6: Enforce source liveness inside the queue transaction**

Extend `EnqueueFactsResult` and update `enqueueFacts` in `src/runtimes/chat/enrichment/fact-export-queue.ts`:

```ts
export interface EnqueueFactsResult {
  attempted: number;
  inserted: number;
  duplicates: number;
  erased: number;
  failed: number;
}

// Empty result
return { attempted: 0, inserted: 0, duplicates: 0, erased: 0, failed: 0 };

let inserted = 0;
let duplicates = 0;
let erased = 0;

db.raw.exec('BEGIN');
try {
  for (const fact of facts) {
    if (!allMessagePksLive(db, fact.sourceMessagePks)) {
      erased += 1;
      continue;
    }
    const payload = {
      text: fact.text,
      memoryType: fact.memoryType,
      confidence: fact.confidence,
      senderName: fact.senderName,
      supersedesText: fact.supersedesText,
      sourceMessagePks: fact.sourceMessagePks,
      promotionReason: fact.promotionReason ?? '',
      claim: fact.claim ?? '',
      evidence: fact.evidence ?? '',
      warrant: fact.warrant ?? '',
      confidenceQualifier: fact.confidenceQualifier ?? '',
      contradicts: fact.contradicts ?? '',
    };
    const result = stmt.run(
      fact.factId,
      fact.chatJid,
      fact.senderJid,
      fact.namespace ?? config.memory.pinecone.namespaces.facts,
      JSON.stringify(payload),
    );
    if (Number(result.changes) > 0) inserted += 1;
    else duplicates += 1;
  }
  db.raw.exec('COMMIT');
} catch (err) {
  try { db.raw.exec('ROLLBACK'); } catch { /* original error remains authoritative */ }
  throw err;
}
return { attempted, inserted, duplicates, erased, failed: 0 };
```

Import `allMessagePksLive` from `../../../core/erasure.ts`. Update accounting logs and tests to include `erased`.

- [ ] **Step 7: Revalidate at every asynchronous enrichment boundary**

In `src/runtimes/chat/enrichment/poller.ts`, import `liveMessagePks` and use this exact segment flow:

```ts
for (const [chatJid, selectedMessages] of byChat) {
  try {
    let live = liveMessagePks(this.db, selectedMessages.map((message) => message.pk));
    let chatMessages = selectedMessages.filter((message) => live.has(message.pk));
    if (chatMessages.length === 0) continue;

    let facts = await extractFacts(this.extractionProvider, chatMessages);
    live = liveMessagePks(this.db, chatMessages.map((message) => message.pk));
    chatMessages = chatMessages.filter((message) => live.has(message.pk));
    facts = facts.filter((fact) => fact.sourceMessagePks.every((pk) => live.has(pk)));
    if (chatMessages.length === 0 || facts.length === 0) continue;
    totalExtracted += facts.length;

    let validated = await validateFacts(this.validationProvider, facts, chatMessages);
    live = liveMessagePks(this.db, chatMessages.map((message) => message.pk));
    chatMessages = chatMessages.filter((message) => live.has(message.pk));
    validated = validated.filter((fact) => fact.sourceMessagePks.every((pk) => live.has(pk)));
    if (chatMessages.length === 0 || validated.length === 0) continue;

    const exportable = validated.map(toExportable);
    const result = enqueueFacts(this.db, exportable);
    totalQueued += result.inserted;
    const accountingOk =
      result.failed === 0 &&
      result.inserted + result.duplicates + result.erased === exportable.length;
    if (accountingOk) {
      live = liveMessagePks(this.db, chatMessages.map((message) => message.pk));
      for (const message of chatMessages) if (live.has(message.pk)) successPks.push(message.pk);
    }
  } catch (err) {
    log.error({ err, chatJid }, 'enrichment: segment processing failed');
    const retryPks: number[] = [];
    for (const message of selectedMessages) {
      const nextRetry = message.enrichmentRetries + 1;
      if (nextRetry >= config.enrichmentMaxRetries) {
        log.warn(
          { pk: message.pk, chatJid, retries: nextRetry },
          'enrichment: message permanently failed — max_retries_exceeded',
        );
        failedPks.push(message.pk);
      } else {
        retryPks.push(message.pk);
      }
    }
    try {
      incrementEnrichmentRetries(this.db, retryPks);
    } catch (dbErr) {
      log.error({ err: dbErr }, 'enrichment: failed to persist retry counters');
    }
  }
}
```

The queue's transaction is the final race authority: if deletion commits after the last poller recheck but before insertion, it either purges the inserted row or makes `allMessagePksLive` reject it.

- [ ] **Step 8: Add the in-flight deletion test**

In `tests/runtimes/chat/enrichment/poller.test.ts`, add this module mock before importing the poller, import its function, and reset the default implementation in `beforeEach`:

```ts
vi.mock('../../../../src/core/erasure.ts', () => ({
  liveMessagePks: vi.fn((_db: unknown, pks: number[]) => new Set(pks)),
}));

import { liveMessagePks } from '../../../../src/core/erasure.ts';
import type { ExtractedFact } from '../../../../src/runtimes/chat/enrichment/extractor.ts';

// beforeEach
vi.mocked(liveMessagePks).mockImplementation((_db, pks) => new Set(pks));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeExtractedFact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    text: 'Test fact',
    chatJid: 'chat1@g.us',
    senderJid: '15551230008@s.whatsapp.net',
    senderName: 'TestUser',
    memoryType: 'user_fact',
    confidence: 0.9,
    supersedesText: '',
    sourceMessagePks: [1],
    ...overrides,
  };
}
```

Add a deferred extraction provider and assert validation/export never receives deleted content:

```ts
it('drops a batch deleted while extraction is in flight', async () => {
  const source = makeStoredMsg({ pk: 901, messageId: 'race-delete', content: 'ERASURE_RACE_CANARY_5be1' });
  vi.mocked(getUnprocessedMessages).mockReturnValue([source]);
  vi.mocked(liveMessagePks)
    .mockReturnValueOnce(new Set([source.pk]))
    .mockReturnValueOnce(new Set());
  const extraction = deferred<ExtractedFact[]>();
  vi.mocked(extractFacts).mockReturnValue(extraction.promise);

  const { poller } = makePoller();
  const cycle = (poller as unknown as { runCycle(): Promise<void> }).runCycle();
  await vi.waitFor(() => expect(extractFacts).toHaveBeenCalledOnce());
  extraction.resolve([makeExtractedFact({
    text: 'ERASURE_RACE_CANARY_5be1',
    sourceMessagePks: [source.pk],
  })]);
  await cycle;

  expect(validateFacts).not.toHaveBeenCalled();
  expect(enqueueFacts).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(enqueueFacts).mock.calls)).not.toContain('ERASURE_RACE_CANARY_5be1');
});
```

The first liveness result models the selected row; the second models deletion committed while extraction awaited. Keep `makeStoredMsg` unchanged.

- [ ] **Step 9: Run all erasure tests**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/messages.test.ts tests/core/database.test.ts tests/core/database-retention.test.ts tests/runtimes/chat/enrichment/poller.test.ts tests/runtimes/chat/enrichment/fact-export-queue.test.ts tests/scripts/backfill-enrichment.test.ts --pool=forks`

Expected: PASS; the unique erasure markers are absent from queue rows, selection, validation, and enqueue calls.

- [ ] **Step 10: Document the lifecycle and residual remote boundary**

Append this complete policy table and operator statement to `docs/durability.md`:

```markdown
## Privacy, Erasure, and Managed Media

## Data lifecycle

| Surface | Normal content policy | Deletion behavior |
|---|---|---|
| `messages` | Primary local message record | `deleted_at` tombstone; excluded from reads, FTS, enrichment, and counts |
| `tool_calls` | Tool name/status/replay policy/timestamps only | Parameters/results are never stored; migration 40 scrubs historical rows |
| `fact_export_queue` pending row | Fact payload awaiting the deployment-owned bridge | Row is deleted in the same transaction as message deletion |
| `fact_export_queue` terminal row | Local export audit | Identity/content is irreversibly replaced with `status=erased` and `{"erased":true}` |
| Remote vector store | Deployment-owned bridge outside this repository | A local erasure proves only that WhatSoup no longer selects, queues, or retains content. Operators must run the remote store's deletion procedure before claiming end-to-end erasure. |
| Routine logs | Metadata, bounded error class, counts, timings, short identity hashes | Message/model/tool bodies are never written, so no per-message log purge is required |

Deletion races are closed twice: the poller rechecks message liveness after each asynchronous model boundary, and `enqueueFacts` checks every source PK inside its SQLite transaction. A delete that commits first prevents insertion; a delete that commits second removes or redacts the queue row in its own transaction.

## Verification

Use synthetic markers only. Run the focused erasure suites, inspect `messages.deleted_at`, confirm no pending queue row remains, and confirm terminal rows contain only the fixed erased payload. Do not claim remote-vector erasure from these local checks.
```

- [ ] **Step 11: Typecheck and commit**

Run: `bash scripts/run-with-pinned-npm.sh run typecheck:all`

Expected: exit 0.

```bash
git add src/core/erasure.ts src/core/messages.ts src/core/database.ts src/runtimes/chat/enrichment/fact-export-queue.ts src/runtimes/chat/enrichment/poller.ts tests/core/messages.test.ts tests/core/database.test.ts tests/runtimes/chat/enrichment/fact-export-queue.test.ts tests/runtimes/chat/enrichment/poller.test.ts docs/durability.md
git commit -m "security(erasure): propagate deletion through enrichment"
```

### Task 6: Descriptor-Pin Every Cached Media Read (WS-A08)

**Files:**
- Create: `src/core/managed-media-read.ts`
- Create: `tests/core/managed-media-read.test.ts`
- Modify: `src/mcp/tools/media.ts:4-17,238-260,410-421`
- Modify: `tests/mcp/tools/media.test.ts:975-1057,1431-1650`
- Modify: `docs/durability.md`

**Interfaces:**
- Produces: `inspectManagedMediaFile(filePath, managedRoot, maxBytes?): ManagedMediaFile` and `readManagedMediaFile(filePath, managedRoot, maxBytes?): ManagedMediaRead`.
- Failure contract: throws `ManagedMediaReadError` with bounded code `missing`, `outside_root`, `symlink`, `not_regular`, `too_large`, or `changed_during_validation`.
- Consumes: `config.mediaDir` as the only root for cached received-media paths.

- [ ] **Step 1: Write the helper's fail-closed test matrix**

```ts
// tests/core/managed-media-read.test.ts
import {
  mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inspectManagedMediaFile,
  readManagedMediaFile,
  ManagedMediaReadError,
} from '../../src/core/managed-media-read.ts';

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'managed-media-root-'));
  outside = mkdtempSync(join(tmpdir(), 'managed-media-outside-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function expectCode(fn: () => unknown, code: ManagedMediaReadError['code']): void {
  expect(fn).toThrowError(expect.objectContaining({ code }));
}

describe('managed media reads', () => {
  it('inspects and reads a regular file beneath the canonical root', () => {
    const file = join(root, 'voice.ogg');
    writeFileSync(file, 'MEDIA_OK');
    expect(inspectManagedMediaFile(file, root)).toMatchObject({ size: 8, path: file });
    expect(readManagedMediaFile(file, root).buffer.toString()).toBe('MEDIA_OK');
  });

  it('rejects an outside regular file and an escaping traversal', () => {
    const file = join(outside, 'secret.ogg');
    writeFileSync(file, 'OUTSIDE_MEDIA_CANARY_70bd');
    expectCode(() => readManagedMediaFile(file, root), 'outside_root');
    const traversal = join(root, '..', outside.split('/').at(-1)!, 'secret.ogg');
    expectCode(() => readManagedMediaFile(traversal, root), 'outside_root');
  });

  it('rejects both escaping and in-root symlinks before reading bytes', () => {
    const outsideFile = join(outside, 'secret.ogg');
    const insideFile = join(root, 'inside.ogg');
    writeFileSync(outsideFile, 'OUTSIDE_MEDIA_CANARY_70bd');
    writeFileSync(insideFile, 'INSIDE_MEDIA');
    const escape = join(root, 'escape.ogg');
    const alias = join(root, 'alias.ogg');
    symlinkSync(outsideFile, escape);
    symlinkSync(insideFile, alias);
    expectCode(() => readManagedMediaFile(escape, root), 'symlink');
    expectCode(() => readManagedMediaFile(alias, root), 'symlink');
  });

  it('rejects directories, FIFOs, missing roots, and oversized files', () => {
    const directory = join(root, 'directory.ogg');
    mkdirSync(directory);
    expectCode(() => readManagedMediaFile(directory, root), 'not_regular');
    if (process.platform !== 'win32') {
      const fifo = join(root, 'pipe.ogg');
      execFileSync('mkfifo', [fifo]);
      expectCode(() => readManagedMediaFile(fifo, root), 'not_regular');
    }
    const regular = join(root, 'large.ogg');
    writeFileSync(regular, '12345');
    expectCode(() => readManagedMediaFile(regular, root, 4), 'too_large');
    expectCode(() => readManagedMediaFile(regular, join(root, 'absent')), 'outside_root');
  });
});
```

- [ ] **Step 2: Run it to verify the module is absent**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/managed-media-read.test.ts --pool=forks`

Expected: FAIL with missing `src/core/managed-media-read.ts`.

- [ ] **Step 3: Implement one open/validate/read primitive**

```ts
// src/core/managed-media-read.ts
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isPathWithinAllowedRoot } from '../lib/path-boundary.ts';

export type ManagedMediaReadErrorCode =
  | 'missing'
  | 'outside_root'
  | 'symlink'
  | 'not_regular'
  | 'too_large'
  | 'changed_during_validation';

export class ManagedMediaReadError extends Error {
  constructor(public readonly code: ManagedMediaReadErrorCode) {
    super(`managed media read refused: ${code}`);
    this.name = 'ManagedMediaReadError';
  }
}

export interface ManagedMediaFile {
  path: string;
  size: number;
}

export interface ManagedMediaRead extends ManagedMediaFile {
  buffer: Buffer;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

function withManagedDescriptor<T>(
  filePath: string,
  managedRoot: string,
  maxBytes: number,
  use: (fd: number, file: ManagedMediaFile) => T,
): T {
  let root: string;
  try {
    root = realpathSync(managedRoot);
  } catch {
    throw new ManagedMediaReadError('outside_root');
  }
  try {
    if (lstatSync(filePath).isSymbolicLink()) throw new ManagedMediaReadError('symlink');
  } catch (err) {
    if (err instanceof ManagedMediaReadError) throw err;
    throw new ManagedMediaReadError('missing');
  }

  let fd: number;
  try {
    fd = openSync(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new ManagedMediaReadError('symlink');
    }
    throw new ManagedMediaReadError('missing');
  }

  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new ManagedMediaReadError('not_regular');
    let resolved: string;
    try {
      resolved = realpathSync(filePath);
    } catch {
      throw new ManagedMediaReadError('missing');
    }
    if (!isPathWithinAllowedRoot(resolved, root)) {
      throw new ManagedMediaReadError('outside_root');
    }
    const canonical = statSync(resolved);
    if (canonical.dev !== opened.dev || canonical.ino !== opened.ino) {
      throw new ManagedMediaReadError('changed_during_validation');
    }
    if (opened.size > maxBytes) throw new ManagedMediaReadError('too_large');
    return use(fd, { path: resolved, size: opened.size });
  } finally {
    closeSync(fd);
  }
}

export function inspectManagedMediaFile(
  filePath: string,
  managedRoot: string,
  maxBytes = DEFAULT_MAX_BYTES,
): ManagedMediaFile {
  return withManagedDescriptor(filePath, managedRoot, maxBytes, (_fd, file) => file);
}

export function readManagedMediaFile(
  filePath: string,
  managedRoot: string,
  maxBytes = DEFAULT_MAX_BYTES,
): ManagedMediaRead {
  return withManagedDescriptor(filePath, managedRoot, maxBytes, (fd, file) => ({
    ...file,
    buffer: readFileSync(fd),
  }));
}
```

- [ ] **Step 4: Run the helper test**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/managed-media-read.test.ts --pool=forks`

Expected: PASS without reading either synthetic outside canary.

- [ ] **Step 5: Wire `download_media` and `transcribe_audio`**

Replace the lexical cached-path block in `src/mcp/tools/media.ts`:

```ts
import {
  inspectManagedMediaFile,
  readManagedMediaFile,
  ManagedMediaReadError,
} from '../../core/managed-media-read.ts';

if (!quoted && row.media_path) {
  try {
    const cached = inspectManagedMediaFile(row.media_path, config.mediaDir);
    return {
      file_path: cached.path,
      content_type: row.content_type,
      file_size: cached.size,
      cached: true,
    };
  } catch (err) {
    const reason = err instanceof ManagedMediaReadError ? err.code : 'validation_error';
    log.warn({ messageId, reason }, 'download_media: cached path refused; treating as stale');
  }
}
```

Replace the transcription media-path read:

```ts
if (row.media_path) {
  try {
    const cached = readManagedMediaFile(row.media_path, config.mediaDir);
    audioBuffer = cached.buffer;
    const ext = cached.path.split('.').pop()?.toLowerCase();
    if (ext === 'mp3') audioMime = 'audio/mpeg';
    else if (ext === 'm4a') audioMime = 'audio/mp4';
    else if (ext === 'wav') audioMime = 'audio/wav';
    else if (ext === 'webm') audioMime = 'audio/webm';
  } catch (err) {
    const reason = err instanceof ManagedMediaReadError ? err.code : 'validation_error';
    log.warn({ messageId, reason }, 'transcribe_audio: cached path refused');
  }
}
```

Mechanically change the existing `} else if (row.raw_message) {` token at line 421 to `}\n\nif (!audioBuffer && row.raw_message) {`; retain the complete JSON parse, authenticated download, error mapping, cache write, and `updateMediaPath` body already inside that condition.

Remove now-unused `existsSync`, `readFileSync`, and `normalize` imports. Do not log `row.media_path` or `config.mediaDir`.

- [ ] **Step 6: Add tool-level provider non-invocation tests**

Add to the path-confinement section of `tests/mcp/tools/media.test.ts`:

```ts
it('does not return cached bytes through an escaping symlink', async () => {
  const outside = tempDir();
  dirsToClean.push(outside);
  const secret = join(outside, 'secret.jpg');
  writeFileSync(secret, 'OUTSIDE_MEDIA_CANARY_70bd');
  const link = join(workspace, 'escape.jpg');
  symlinkSync(secret, link);
  insertMessage('msg-symlink', 'image', { mediaPath: link });

  const result = await registry.call('download_media', { message_id: 'msg-symlink' }, globalSession());
  const body = JSON.parse(result.content[0].text);
  expect(body.cached).not.toBe(true);
  expect(body.file_path).toBeUndefined();
  expect(body.error).toBe('no_raw_message');
  expect(JSON.stringify(body)).not.toContain('OUTSIDE_MEDIA_CANARY_70bd');
});
```

Add to the transcription execution section:

```ts
it('refuses an escaping cached-audio symlink before invoking transcription', async () => {
  const outside = tempDir();
  dirsToClean.push(outside);
  const secret = join(outside, 'secret.ogg');
  writeFileSync(secret, 'OUTSIDE_AUDIO_CANARY_f4c1');
  const link = join(workspace, 'escape.ogg');
  symlinkSync(secret, link);
  insertAudioRow('msg-audio-symlink', { mediaPath: link });

  const result = await registry.call(
    'transcribe_audio',
    { message_id: 'msg-audio-symlink' },
    globalSession(),
  );
  const body = JSON.parse(result.content[0].text);
  expect(body.error).toBe('no_audio_data');
  expect(mockTranscribeAudio).not.toHaveBeenCalled();
  expect(JSON.stringify(mockTranscribeAudio.mock.calls)).not.toContain('OUTSIDE_AUDIO_CANARY_f4c1');
});
```

- [ ] **Step 7: Run all media confinement tests**

Run: `bash scripts/run-with-pinned-npm.sh test -- tests/core/managed-media-read.test.ts tests/mcp/tools/media.test.ts tests/transport/media-read-stream-fdpin.test.ts tests/core/schedule-enqueue-toctou.test.ts --pool=forks`

Expected: PASS; no outside/symlink canary reaches a tool result, outbound stream, or transcription provider.

- [ ] **Step 8: Extend the runbook and commit**

Append to `docs/durability.md`:

```markdown
## Managed cached media

`config.mediaDir` is the only trust root for received-media cache reads. Cache hits and transcription open the candidate once with `O_NOFOLLOW`, require a regular file, compare the opened inode with the canonical in-root path, enforce the byte ceiling, and read only from that validated descriptor. A missing, outside, symlinked, non-regular, oversized, or raced path is stale/unusable; it is never passed to a transcription provider. `download_media` may re-download from authenticated WhatsApp raw-message metadata when available.
```

Run: `bash scripts/run-with-pinned-npm.sh run typecheck:all`

Expected: exit 0.

```bash
git add src/core/managed-media-read.ts src/mcp/tools/media.ts tests/core/managed-media-read.test.ts tests/mcp/tools/media.test.ts docs/durability.md
git commit -m "security(media): confine cached media reads"
```

### Task 7: Verify and Package the Three Privacy PRs

**Files:**
- Modify only if generated guards require it: `docs/public-surface.md`, `docs/work-index.md`

**Interfaces:**
- Consumes: all WS-A06/A07/A08 commits.
- Produces: one fresh release receipt and one residual-risk note per PR; no publication.

- [ ] **Step 1: Rebase each PR branch onto a freshly fetched main in sequence**

```bash
git fetch origin
git rev-parse origin/main
git status --short
```

Expected: a recorded 40-character main SHA and an empty status. If #1714 landed after WS-A06 began, rebase WS-A06 and rerun its canaries. If #1715 or #1716 landed, rebase every not-yet-final branch and rerun its focused suites.

- [ ] **Step 2: Run the full focused privacy receipt**

Run:

```bash
bash scripts/run-with-pinned-npm.sh test -- \
  tests/lib/log-safety.test.ts \
  tests/logger.test.ts \
  tests/logger-privacy.test.ts \
  tests/runtimes/chat/runtime.test.ts \
  tests/runtimes/chat/media/links.test.ts \
  tests/runtimes/chat/media/links-extraction.test.ts \
  tests/mcp/socket-server.test.ts \
  tests/core/migration-safety.test.ts \
  tests/core/durability-tools.test.ts \
  tests/mcp/registry-erasure-redaction.test.ts \
  tests/core/messages.test.ts \
  tests/core/database.test.ts \
  tests/runtimes/chat/enrichment/poller.test.ts \
  tests/runtimes/chat/enrichment/fact-export-queue.test.ts \
  tests/core/managed-media-read.test.ts \
  tests/mcp/tools/media.test.ts \
  --pool=forks
```

Expected: PASS with no skipped privacy canary.

- [ ] **Step 3: Run repository validation**

Run: `bash scripts/run-with-pinned-npm.sh run typecheck:all`

Expected: exit 0.

Run: `bash scripts/run-with-pinned-npm.sh run guard:test-integrity`

Expected: exit 0; accepted baseline advisories may remain, but no new advisory may name these tests.

Run: `bash scripts/run-with-pinned-npm.sh run guard:public-surface-drift`

Expected: exit 0. If the new runbook or migration changes a guarded registry, update that registry with the exact new stable surface and rerun.

- [ ] **Step 4: Run the complete release gate separately on each PR tip**

Run: `bash scripts/run-with-pinned-npm.sh run verify:release`

Expected: exit 0, including root tests, coverage, console build/design/browser suites, guard package, repository guards, and deployment drills. Any browser-runtime absence or external binary skip is inconclusive until its declared dependency is installed and the command is rerun.

- [ ] **Step 5: Record residual risk without overstating erasure**

Use this exact PR note:

```markdown
Residual risk: local canaries prove WhatSoup no longer writes the tested content to routine logs/tool telemetry, no longer enriches or locally queues deleted messages, and refuses unconfined cached-media reads. This PR does not prove deletion from a deployment-owned remote vector store, historical logs produced before deployment, live WhatsApp, or a real transcription provider. Those require the remote erasure procedure and staging canaries.
```

- [ ] **Step 6: Confirm branch state without publishing**

```bash
git status --short
git log --oneline --decorate origin/main..HEAD
git diff --check origin/main...HEAD
```

Expected: clean worktree, only the intended commits, and no whitespace errors. Stop before `git push` or any GitHub mutation.

---

## Self-Review Notes

- Spec coverage: Task 1-3 implement WS-A06 and I5; Task 4-5 implement WS-A07 and I6; Task 6 implements WS-A08; Task 7 enforces the approved verification/publication boundary.
- Negative controls: arbitrary message/model/tool markers are absent from both sinks and local secondary stores; URL credentials/query/fragment are absent; symlink/outside bytes never reach transcription.
- Fail-closed review: message liveness is checked inside the fact-queue transaction, erasure and message tombstones share a transaction, and media bytes come only from the validated descriptor.
- Type consistency: `EnqueueFactsResult.erased` is introduced once and included in poller accounting and every expected object; media error codes are a closed union shared by helper and tests.
- Data-boundary honesty: exported remote facts are explicitly a deployment-owned residual; this plan does not label local redaction as remote deletion.
- Prohibited-token scan: run `rg -n '[T]BD|[T]ODO|implement[ ]later|fill[ ]in|similar[ ]to[ ]Task|appropriate[ ]error[ ]handling' docs/superpowers/plans/2026-07-09-privacy-erasure-and-media-confinement.md`; expected result is no matches.
- Open-PR sequencing: #1714 blocks the logging branch start; #1715/#1716 require fresh-main rebases and release reruns but do not authorize editing their branches.
