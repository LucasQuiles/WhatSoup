// tests/runtimes/agent/media-bridge-zod-equivalence.test.ts
//
// Equivalence net for Tier-B lane 1 (#2203 tierb-contract-lane-spec-r15,
// lane 1): src/runtimes/agent/media-bridge.ts's hand-rolled request-body
// shape guard (JSON.parse + `path` presence/type check + the `caption`/
// `filename` cast-through) moves to a Zod schema. Only that shape *prefix*
// is in scope — `path not allowed` / `current chat is required` /
// `file not found` / `failed to read file` depend on filesystem and bridge
// state, not the request body, and cannot be expressed as a schema (see the
// lane spec §1.5). This file is written and run GREEN against the
// pre-conversion handler first (see the commit's RED-phase evidence); it is
// then re-run UNMODIFIED after the conversion to prove the shape-prefix
// contract — including the exact `error` message text per branch — did not
// drift.
//
// `handleRequest` is module-private, so both the reference and the live
// verdict are observed the same way the existing media-bridge.test.ts suite
// does: over the real Unix socket.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createConnection } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Messenger, OutboundMedia, SubmissionReceipt } from '../../../src/core/types.ts';
import { startMediaBridge, setMediaBridgeChat, type MediaBridge } from '../../../src/runtimes/agent/media-bridge.ts';
import { vi } from 'vitest';

// ─── Reference implementation ──────────────────────────────────────────────
// Verbatim pre-conversion shape-prefix ladder (media-bridge.ts:226-236,
// 278-282 as of the r15 spec anchor). Do not modernize this — it defines
// the value space and message text the Zod schema must reproduce exactly.
// Stops at the shape boundary the schema actually owns; everything past the
// `path` check (realpathSync, isPathWithinAllowedRoot, statSync) is out of
// scope and is exercised only as "did NOT get rejected at the shape layer"
// below.

type ShapeVerdict =
  | { stage: 'invalid_json' }
  // Legacy trap: property access on a literal JSON `null` body throws (JS
  // `.` access on null/undefined throws; access on any other primitive or
  // array safely returns `undefined`). The pre-conversion code has no guard
  // against this — `req.path` on a null `req` crashes, and that uncaught
  // TypeError propagates to the outer socket handler's `.catch`, which maps
  // it to `{ok:false, error:'internal error'}`. A naive Zod `safeParse`
  // would absorb `null` gracefully and answer `missing path` instead — a
  // real behavior change — so this branch models the crash explicitly.
  | { stage: 'internal_error' }
  | { stage: 'missing_path' }
  | { stage: 'ok'; path: string; caption: string | undefined; filename: string | undefined };

function referenceShapeGuard(rawLine: string): ShapeVerdict {
  let req: unknown;
  try {
    req = JSON.parse(rawLine);
  } catch {
    return { stage: 'invalid_json' };
  }
  if (req === null) {
    return { stage: 'internal_error' };
  }
  const r = req as { path?: unknown; caption?: unknown; filename?: unknown };
  const filePath = typeof r.path === 'string' ? r.path : null;
  if (!filePath) {
    return { stage: 'missing_path' };
  }
  const caption = typeof r.caption === 'string' ? r.caption : undefined;
  const filename = typeof r.filename === 'string' ? r.filename : undefined;
  return { stage: 'ok', path: filePath, caption, filename };
}

// ─── Harness ────────────────────────────────────────────────────────────────

function makeSocketPath(): string {
  return join(tmpdir(), `mb-eq-${randomBytes(6).toString('hex')}.sock`);
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mb-eq-root-'));
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn(async () => ({ waMessageId: 'mock-id' }) as SubmissionReceipt),
  } as unknown as Messenger;
}

function sendRaw(socketPath: string, payload: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => client.write(payload));
    let buf = '';
    client.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        client.destroy();
        try {
          resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
        } catch (e) {
          reject(e);
        }
      }
    });
    client.on('error', reject);
    setTimeout(() => {
      client.destroy();
      reject(new Error('sendRequest timeout'));
    }, 3000);
  });
}

function waitListening(bridge: MediaBridge): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = bridge._server;
    if (server.listening) {
      resolve();
      return;
    }
    server.once('listening', resolve);
    server.once('error', reject);
    setTimeout(() => reject(new Error('bridge listen timeout')), 3000);
  });
}

let socketPath: string;
let allowedRoot: string;
let bridge: MediaBridge;
let messenger: Messenger;

beforeEach(async () => {
  socketPath = makeSocketPath();
  allowedRoot = makeTempDir();
  messenger = makeMessenger();
  bridge = startMediaBridge(socketPath, messenger, allowedRoot);
  await waitListening(bridge);
  setMediaBridgeChat(bridge, 'chat@g.us');
});

afterEach(() => {
  bridge();
});

// ─── Shape-rejecting cases: reference verdict + exact live message ─────────

interface RejectCase {
  name: string;
  rawLine: string;
  stage: 'invalid_json' | 'internal_error' | 'missing_path';
  message: string;
}

const rejectCases: RejectCase[] = [
  { name: 'malformed JSON', rawLine: 'not-json', stage: 'invalid_json', message: 'invalid JSON' },
  { name: 'literal null body (legacy crash trap)', rawLine: 'null', stage: 'internal_error', message: 'internal error' },
  { name: 'boolean true body', rawLine: 'true', stage: 'missing_path', message: 'missing path' },
  { name: 'boolean false body', rawLine: 'false', stage: 'missing_path', message: 'missing path' },
  { name: 'number body', rawLine: '42', stage: 'missing_path', message: 'missing path' },
  { name: 'string body', rawLine: '"hello"', stage: 'missing_path', message: 'missing path' },
  { name: 'empty array body', rawLine: '[]', stage: 'missing_path', message: 'missing path' },
  { name: 'array-of-strings body', rawLine: '["a","b"]', stage: 'missing_path', message: 'missing path' },
  { name: 'empty object body', rawLine: '{}', stage: 'missing_path', message: 'missing path' },
  { name: 'path: null', rawLine: '{"path":null}', stage: 'missing_path', message: 'missing path' },
  { name: 'path: number', rawLine: '{"path":123}', stage: 'missing_path', message: 'missing path' },
  { name: 'path: boolean', rawLine: '{"path":true}', stage: 'missing_path', message: 'missing path' },
  { name: 'path: object', rawLine: '{"path":{}}', stage: 'missing_path', message: 'missing path' },
  { name: 'path: empty string', rawLine: '{"path":""}', stage: 'missing_path', message: 'missing path' },
  {
    name: 'multi-field-invalid: path missing AND caption/filename simultaneously wrong-typed — single message must still be "missing path"',
    rawLine: '{"caption":123,"filename":456}',
    stage: 'missing_path',
    message: 'missing path',
  },
  {
    name: 'multi-field-invalid: path wrong-typed AND caption/filename simultaneously wrong-typed — single message must still be "missing path"',
    rawLine: '{"path":null,"caption":123,"filename":456}',
    stage: 'missing_path',
    message: 'missing path',
  },
];

describe('media-bridge shape-prefix equivalence: reject branches', () => {
  for (const c of rejectCases) {
    it(`${c.name} → ${c.stage} (reference), '${c.message}' (live)`, async () => {
      // Reference: the verbatim pre-conversion ladder agrees on which branch fires.
      expect(referenceShapeGuard(c.rawLine)).toEqual({ stage: c.stage });

      // Live: the actual handler over the socket produces the exact byte-for-byte message.
      const res = await sendRaw(socketPath, c.rawLine + '\n');
      expect(res).toEqual({ ok: false, error: c.message });
    });
  }
});

// ─── Shape-passing cases: reference agrees the prefix accepts, and live ────
// does not reject at the shape layer (it may still be rejected further
// downstream by filesystem checks that are out of this schema's scope).

interface AcceptCase {
  name: string;
  rawLine: string;
  expectPath: string;
  expectCaption: string | undefined;
  expectFilename: string | undefined;
}

const acceptCases: AcceptCase[] = [
  {
    name: 'whitespace-only path is NOT rejected (length-only check, no trim)',
    rawLine: '{"path":"   "}',
    expectPath: '   ',
    expectCaption: undefined,
    expectFilename: undefined,
  },
  {
    name: 'valid path, no caption/filename',
    rawLine: '{"path":"/nonexistent-abc"}',
    expectPath: '/nonexistent-abc',
    expectCaption: undefined,
    expectFilename: undefined,
  },
  {
    name: 'multi-field: valid path with caption/filename simultaneously wrong-typed — both silently cast to undefined, not rejected',
    rawLine: '{"path":"/nonexistent-abc","caption":123,"filename":456}',
    expectPath: '/nonexistent-abc',
    expectCaption: undefined,
    expectFilename: undefined,
  },
  {
    name: 'valid path with valid caption and filename strings',
    rawLine: '{"path":"/nonexistent-abc","caption":"cap","filename":"fn"}',
    expectPath: '/nonexistent-abc',
    expectCaption: 'cap',
    expectFilename: 'fn',
  },
];

describe('media-bridge shape-prefix equivalence: accept branches', () => {
  for (const c of acceptCases) {
    it(`${c.name} → shape accepted (reference), not shape-rejected (live)`, async () => {
      const ref = referenceShapeGuard(c.rawLine);
      expect(ref).toEqual({
        stage: 'ok',
        path: c.expectPath,
        caption: c.expectCaption,
        filename: c.expectFilename,
      });

      const res = await sendRaw(socketPath, c.rawLine + '\n');
      // Must NOT be rejected by the shape layer — any of its three messages
      // would prove the schema mis-modeled this input.
      expect(res.ok).toBe(false); // these paths don't exist under allowedRoot
      expect(res.error).not.toBe('missing path');
      expect(res.error).not.toBe('invalid JSON');
      expect(res.error).not.toBe('internal error');
    });
  }

  it('full round trip: valid existing file, no caption/filename → sendMedia sees caption:undefined, filename:basename(path)', async () => {
    const filePath = join(allowedRoot, 'photo.png');
    writeFileSync(filePath, Buffer.from([137, 80, 78, 71]));

    const res = await sendRaw(socketPath, JSON.stringify({ path: filePath }) + '\n');

    expect(res.ok).toBe(true);
    const media = vi.mocked(messenger.sendMedia).mock.calls[0]?.[1] as OutboundMedia & { caption?: string };
    expect(media.caption).toBeUndefined();
    (media as OutboundMedia & { stream?: { destroy?: () => void } }).stream?.destroy?.();
  });

  it('full round trip: valid existing file, caption/filename BOTH simultaneously wrong-typed → cast through to undefined/basename, ok:true', async () => {
    const filePath = join(allowedRoot, 'report.xlsx');
    writeFileSync(filePath, Buffer.alloc(4));

    const res = await sendRaw(
      socketPath,
      JSON.stringify({ path: filePath, caption: 123, filename: 456 }) + '\n',
    );

    expect(res.ok).toBe(true);
    const media = vi.mocked(messenger.sendMedia).mock.calls[0]?.[1] as OutboundMedia & { caption?: string; filename?: string };
    expect(media.caption).toBeUndefined();
    expect(media.filename).toBe('report.xlsx'); // basename(resolvedPath) fallback
    (media as OutboundMedia & { stream?: { destroy?: () => void } }).stream?.destroy?.();
  });

  it('full round trip: valid existing file, valid caption/filename strings → both pass through unchanged', async () => {
    // Document type (buildOutboundMediaFromPath's default branch) is the
    // only media type whose OutboundMedia actually carries `filename` — the
    // image/audio/video branches omit it, so a non-document extension here
    // would silently make the filename assertion below vacuous.
    const filePath = join(allowedRoot, 'clip.zip');
    writeFileSync(filePath, Buffer.alloc(4));

    const res = await sendRaw(
      socketPath,
      JSON.stringify({ path: filePath, caption: 'a caption', filename: 'custom-name.zip' }) + '\n',
    );

    expect(res.ok).toBe(true);
    const media = vi.mocked(messenger.sendMedia).mock.calls[0]?.[1] as OutboundMedia & { caption?: string; filename?: string };
    expect(media.caption).toBe('a caption');
    expect(media.filename).toBe('custom-name.zip');
    (media as OutboundMedia & { stream?: { destroy?: () => void } }).stream?.destroy?.();
  });

  // The original ladder used a plain `typeof X === 'string' ? X : fallback`
  // ternary, NOT a truthiness check — so an empty-string caption/filename is
  // a valid string and passes through as `''`, it does NOT trigger the
  // fallback. A correct conversion must use `??` (nullish coalescing) for
  // the filename fallback, not `||` — `'' || basename(...)` would wrongly
  // replace an explicit empty-string filename with the basename fallback,
  // a real behavior change these two cases pin down.
  it('empty-string caption is passed through as "" (not falsy-coerced to undefined)', async () => {
    const filePath = join(allowedRoot, 'empty-caption.png');
    writeFileSync(filePath, Buffer.from([137, 80, 78, 71]));

    const res = await sendRaw(socketPath, JSON.stringify({ path: filePath, caption: '' }) + '\n');

    expect(res.ok).toBe(true);
    const media = vi.mocked(messenger.sendMedia).mock.calls[0]?.[1] as OutboundMedia & { caption?: string };
    expect(media.caption).toBe('');
    (media as OutboundMedia & { stream?: { destroy?: () => void } }).stream?.destroy?.();
  });

  it('empty-string filename is passed through as "" (not falsy-coerced to the basename fallback)', async () => {
    const filePath = join(allowedRoot, 'empty-filename.zip');
    writeFileSync(filePath, Buffer.alloc(4));

    const res = await sendRaw(socketPath, JSON.stringify({ path: filePath, filename: '' }) + '\n');

    expect(res.ok).toBe(true);
    const media = vi.mocked(messenger.sendMedia).mock.calls[0]?.[1] as OutboundMedia & { filename?: string };
    expect(media.filename).toBe('');
    (media as OutboundMedia & { stream?: { destroy?: () => void } }).stream?.destroy?.();
  });
});
