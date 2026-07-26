/**
 * S-03 — the in-place mutating update path is retired in EVERY supported mode.
 *
 * `POST /api/update` used to `git pull` / `merge --ff-only` inside the running
 * checkout, then npm-install, rebuild the console, and restart the fleet — a
 * mutation of a directory that, on the fleet, is an immutable release
 * (`WhatSoup-release-<sha>`, detached HEAD). The live update-checker was already
 * observed failing `git fetch origin main` inside that release dir.
 *
 * The retired contract: `handleUpdate` performs NO mutation under any config and
 * returns a typed, machine-readable refusal over the existing SSE error channel
 * (200 `text/event-stream` + one `error` event with
 * `code: 'update-by-release-deploy-required'`). The console's existing error
 * phase already renders `data.message`, so old and new consoles both surface the
 * guidance during mixed-version deploys. The read-only availability/version
 * check (`GET /api/version` via UpdateChecker) is unchanged and covered
 * elsewhere (update.test.ts, update-checker-detached.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the child-process seam so a refusal can be PROVEN to spawn nothing:
// any git/npm invocation would land on execFileAsyncSpy.
const { execFileAsyncSpy, execFileCbSpy } = vi.hoisted(() => ({
  execFileAsyncSpy: vi.fn(),
  execFileCbSpy: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileCbSpy,
}));

vi.mock('node:util', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('node:util');
  return {
    ...original,
    promisify: () => execFileAsyncSpy,
  };
});

import { handleUpdate } from '../../../src/fleet/routes/update.ts';

const REFUSAL_CODE = 'update-by-release-deploy-required';

function makeReqRes() {
  const chunks: string[] = [];
  let closeHandler: (() => void) | undefined;
  const req = {
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'close') closeHandler = cb;
    }),
    triggerClose: () => closeHandler?.(),
  } as any;
  const res = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
      return true;
    }),
    end: vi.fn(),
    // ServerResponse is an EventEmitter; createSSEWriter attaches an 'error'
    // listener (#2292 L7), so a fake without `on` is an incomplete fake.
    on: vi.fn(() => res),
    get chunks() {
      return chunks;
    },
  } as any;
  return { req, res };
}

function makeChecker() {
  return { checkNow: vi.fn().mockResolvedValue({}), getState: vi.fn(() => ({})) } as any;
}

function parseSSE(chunks: string[]) {
  return chunks.map((chunk) => {
    const lines = chunk.split('\n').filter(Boolean);
    const event = lines.find((l) => l.startsWith('event:'))?.slice('event:'.length).trim();
    const dataLine = lines.find((l) => l.startsWith('data:'))?.slice('data:'.length).trim();
    return { event, data: dataLine ? JSON.parse(dataLine) : undefined };
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  // If any residual code path did spawn a process, make it observable rather
  // than hang: reject so a stray call surfaces loudly.
  execFileAsyncSpy.mockRejectedValue(new Error('no subprocess should be spawned by a retired update'));
  execFileCbSpy.mockImplementation((_c: unknown, _a: unknown, cb: (e?: Error | null) => void) => {
    cb(new Error('no subprocess should be spawned by a retired update'));
    return {} as any;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('handleUpdate — retired in-place mutation (S-03)', () => {
  it('returns a typed update-by-release-deploy-required refusal over the SSE error channel', async () => {
    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    // 200 text/event-stream — keeps the console EventSource/fetch reader path,
    // so pre-existing consoles surface data.message in their error phase.
    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'Content-Type': 'text/event-stream' }),
    );

    const events = parseSSE(res.chunks);
    const errors = events.filter((e) => e.event === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].data.code).toBe(REFUSAL_CODE);
    expect(typeof errors[0].data.message).toBe('string');
    expect(errors[0].data.message.length).toBeGreaterThan(0);
    // No progress steps (pull/install/build/restart) are emitted.
    expect(events.some((e) => e.event === 'progress')).toBe(false);
    expect(res.end).toHaveBeenCalled();
  });

  it('spawns no git/npm subprocess when refusing (no mutation of the checkout)', async () => {
    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');
    expect(execFileAsyncSpy).not.toHaveBeenCalled();
    expect(execFileCbSpy).not.toHaveBeenCalled();
  });

  it('cannot be re-enabled by environment configuration', async () => {
    vi.stubEnv('WHATSOUP_ALLOW_INPLACE_UPDATE', '1');
    vi.stubEnv('FLEET_ENABLE_INPLACE_UPDATE', 'true');
    vi.stubEnv('ALLOW_GIT_PULL', '1');
    vi.stubEnv('NODE_ENV', 'production');

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const errors = parseSSE(res.chunks).filter((e) => e.event === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].data.code).toBe(REFUSAL_CODE);
    expect(execFileAsyncSpy).not.toHaveBeenCalled();
  });

  it('refuses idempotently on repeated calls (no lingering in-progress lock)', async () => {
    const first = makeReqRes();
    await handleUpdate(first.req, first.res, makeChecker(), '/repo');
    const second = makeReqRes();
    await handleUpdate(second.req, second.res, makeChecker(), '/repo');

    for (const rr of [first, second]) {
      const errors = parseSSE(rr.res.chunks).filter((e) => e.event === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0].data.code).toBe(REFUSAL_CODE);
    }
  });
});
