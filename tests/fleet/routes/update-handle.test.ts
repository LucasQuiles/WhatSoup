/**
 * Exhaustive tests for handleUpdate in src/fleet/routes/update.ts
 *
 * Coverage:
 *  - SSE happy path (pull → install → console-install → build → restart)
 *  - Mutex: concurrent call returns 409
 *  - git pull failure exits early with SSE error
 *  - vite build failure exits early with SSE error
 *  - endOnce idempotency (multiple close events don't double-end)
 *  - writeSSE skips write when connection already ended
 *  - lockfile change detection (package-lock.json present / absent)
 *  - console lockfile change detection
 *  - checker.checkNow() called after successful pull
 *  - systemctl restart error path emits SSE error
 *  - SSE event format correctness (event: / data: / double-newline)
 *  - err.message fallback when err.stderr is absent
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted() — must run before vi.mock() factories so they can reference
// these spies in factory closures.
// ---------------------------------------------------------------------------

const { execFileAsyncSpy, execFileCbSpy } = vi.hoisted(() => ({
  execFileAsyncSpy: vi.fn(),
  execFileCbSpy: vi.fn(),
}));

// Mock node:child_process — execFile (callback) and promisify target
vi.mock('node:child_process', () => ({
  execFile: execFileCbSpy,
}));

// Mock node:util so that promisify() returns our async spy at module-init time
vi.mock('node:util', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:util')>();
  return {
    ...orig,
    promisify: (_fn: any) => execFileAsyncSpy,
  };
});

// Now import the module under test — the mocks are already in place
import { handleUpdate } from '../../../src/fleet/routes/update.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReqRes() {
  const chunks: string[] = [];
  let closeHandler: (() => void) | null = null;

  const req = {
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'close') closeHandler = cb;
    }),
    triggerClose: () => { if (closeHandler) closeHandler(); },
  } as any;

  const res = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => { chunks.push(chunk); return true; }),
    end: vi.fn(),
    get chunks() { return chunks; },
  } as any;

  return { req, res };
}

function parseSSE(chunks: string[]) {
  return chunks.map((chunk) => {
    const lines = chunk.split('\n').filter(Boolean);
    const event = lines.find((l) => l.startsWith('event:'))?.slice('event:'.length).trim();
    const dataLine = lines.find((l) => l.startsWith('data:'))?.slice('data:'.length).trim();
    return { event, data: dataLine ? JSON.parse(dataLine) : undefined, raw: chunk };
  });
}

function makeChecker(impl?: () => Promise<any>) {
  return {
    checkNow: vi.fn().mockImplementation(impl ?? (() => Promise.resolve({}))),
  } as any;
}

// Convenience: configure execFileAsync for the standard happy-path sequence.
// Call this at the start of a test; it mutates execFileAsyncSpy.
function setupHappyPath({
  pullStdout = 'Already up to date.\n',
  rootDiff = 'src/foo.ts\n',
  consoleDiff = 'src/bar.ts\n',
} = {}) {
  execFileAsyncSpy
    .mockResolvedValueOnce({ stdout: pullStdout, stderr: '' })   // git pull
    .mockResolvedValueOnce({ stdout: rootDiff, stderr: '' })      // git diff (root)
    .mockResolvedValueOnce({ stdout: consoleDiff, stderr: '' })   // git diff (console)
    .mockResolvedValueOnce({ stdout: '', stderr: '' });            // npx vite build
  execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });
}

// ---------------------------------------------------------------------------
// Reset mocks before each test so state does not leak.
// The module-level `updateInProgress` flag CAN leak — see Mutex section below.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// SSE format
// ---------------------------------------------------------------------------

describe('SSE event format', () => {
  it('each chunk conforms to the SSE wire format (event/data/blank-line)', async () => {
    setupHappyPath();
    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    expect(res.chunks.length).toBeGreaterThan(0);
    for (const chunk of res.chunks) {
      // Must match: "event: <name>\ndata: <json>\n\n"
      expect(chunk).toMatch(/^event: [\w-]+\ndata: .+\n\n$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('handleUpdate — happy path', () => {
  it('responds with SSE headers (200, text/event-stream, no-cache)', async () => {
    setupHappyPath();
    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    }));
  });

  it('emits progress events for all 5 steps', async () => {
    setupHappyPath();
    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    const steps = events.filter((e) => e.event === 'progress').map((e) => e.data?.step);
    expect(steps).toContain('pull');
    expect(steps).toContain('install');
    expect(steps).toContain('console-install');
    expect(steps).toContain('console-build');
    expect(steps).toContain('restart');
  });

  it('emits pull:running before pull:done', async () => {
    setupHappyPath();
    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    const pullIdx = {
      running: events.findIndex((e) => e.data?.step === 'pull' && e.data?.status === 'running'),
      done: events.findIndex((e) => e.data?.step === 'pull' && e.data?.status === 'done'),
    };
    expect(pullIdx.running).toBeGreaterThanOrEqual(0);
    expect(pullIdx.done).toBeGreaterThan(pullIdx.running);
  });

  it('calls checker.checkNow() after successful pull', async () => {
    setupHappyPath();
    const { req, res } = makeReqRes();
    const checker = makeChecker();
    await handleUpdate(req, res, checker, '/repo');

    expect(checker.checkNow).toHaveBeenCalledTimes(1);
  });

  it('does not call checker.checkNow() when pull fails', async () => {
    const err: any = new Error('network error');
    err.stderr = 'fatal: cannot connect';
    execFileAsyncSpy.mockRejectedValueOnce(err);

    const { req, res } = makeReqRes();
    const checker = makeChecker();
    await handleUpdate(req, res, checker, '/repo');

    expect(checker.checkNow).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Mutex — concurrent requests
//
// The module-level `updateInProgress` flag starts as false.
// To test the mutex, we start a call that hangs (pull never resolves),
// then immediately fire a second call which should see the flag and 409.
// We must also drain/resolve the first call afterward to reset the flag for
// subsequent tests in the file.
// ---------------------------------------------------------------------------

describe('handleUpdate — mutex (409 on concurrent request)', () => {
  it('returns 409 JSON when an update is already in progress', async () => {
    // Create a deferred promise so we can control when pull resolves
    let resolvePull!: (value: any) => void;
    const hangingPull = new Promise<any>((resolve) => { resolvePull = resolve; });
    execFileAsyncSpy.mockReturnValueOnce(hangingPull);

    const { req: req1, res: res1 } = makeReqRes();
    const { req: req2, res: res2 } = makeReqRes();

    // Start first call — do NOT await yet
    const firstCall = handleUpdate(req1, res1, makeChecker(), '/repo');

    // Yield a microtask so handleUpdate sets updateInProgress = true
    await Promise.resolve();

    // Second call — synchronous check of flag, should immediately 409
    await handleUpdate(req2, res2, makeChecker(), '/repo');

    expect(res2.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
    const body409 = JSON.parse(res2.end.mock.calls[0][0]);
    expect(body409.error).toMatch(/in progress/i);

    // Clean up: resolve the hanging pull so the first call can finish and reset the flag
    resolvePull({ stdout: 'Already up to date.\n', stderr: '' });

    // Set up remaining mocks for the first call to complete
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'src/foo.ts\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'src/bar.ts\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    await firstCall; // drain so updateInProgress resets to false
  });
});

// ---------------------------------------------------------------------------
// Error paths — git pull
// ---------------------------------------------------------------------------

describe('handleUpdate — git pull failure', () => {
  it('emits SSE error event with step=pull', async () => {
    const err: any = new Error('network unreachable');
    err.stderr = 'fatal: could not read from remote repository.';
    execFileAsyncSpy.mockRejectedValueOnce(err);

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    const pullError = events.find((e) => e.event === 'error' && e.data?.step === 'pull');
    expect(pullError).toBeDefined();
    expect(pullError!.data.message).toContain('could not read from remote');
  });

  it('uses err.message when err.stderr is absent', async () => {
    execFileAsyncSpy.mockRejectedValueOnce(new Error('ENOENT: git not found'));

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    const pullError = events.find((e) => e.event === 'error');
    expect(pullError?.data?.message).toContain('ENOENT');
  });

  it('calls res.end after pull error (stream is closed)', async () => {
    const err: any = new Error('bad');
    err.stderr = 'fatal: error';
    execFileAsyncSpy.mockRejectedValueOnce(err);

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    expect(res.end).toHaveBeenCalled();
  });

  it('does not emit install, build, or restart events after pull failure', async () => {
    const err: any = new Error('bad');
    err.stderr = 'fatal: error';
    execFileAsyncSpy.mockRejectedValueOnce(err);

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    const laterSteps = events.filter((e) =>
      ['install', 'console-install', 'console-build', 'restart'].includes(e.data?.step),
    );
    expect(laterSteps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error paths — vite build
// ---------------------------------------------------------------------------

describe('handleUpdate — vite build failure', () => {
  it('emits SSE error event with step=console-build', async () => {
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'Already up to date.\n', stderr: '' }) // pull
      .mockResolvedValueOnce({ stdout: 'src/foo.ts\n', stderr: '' })          // diff root
      .mockResolvedValueOnce({ stdout: 'src/bar.ts\n', stderr: '' });         // diff console

    const buildErr: any = new Error('build failed');
    buildErr.stderr = 'error: [vite] Transform failed with 3 errors.';
    execFileAsyncSpy.mockRejectedValueOnce(buildErr);                         // vite build

    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    const checker = makeChecker();
    await handleUpdate(req, res, checker, '/repo');

    const events = parseSSE(res.chunks);
    const buildError = events.find((e) => e.event === 'error' && e.data?.step === 'console-build');
    expect(buildError).toBeDefined();
    expect(buildError!.data.message).toContain('Transform failed');
  });

  it('calls res.end after build failure', async () => {
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'OK\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'src/foo.ts\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'src/bar.ts\n', stderr: '' });
    const buildErr: any = new Error('fail');
    buildErr.stderr = 'vite error';
    execFileAsyncSpy.mockRejectedValueOnce(buildErr);
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    expect(res.end).toHaveBeenCalled();
  });

  it('does not emit restart event after build failure', async () => {
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'OK\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'src/foo.ts\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'src/bar.ts\n', stderr: '' });
    const buildErr: any = new Error('fail');
    buildErr.stderr = 'vite error';
    execFileAsyncSpy.mockRejectedValueOnce(buildErr);
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    const restartEvents = events.filter((e) => e.data?.step === 'restart');
    expect(restartEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error paths — systemctl restart
// ---------------------------------------------------------------------------

describe('handleUpdate — systemctl restart error', () => {
  it('emits SSE error event with step=restart when systemctl fails', async () => {
    setupHappyPath();
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => {
      cb(new Error('Failed to connect to bus'));
      return {} as any;
    });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    // systemctl callback is async — wait a microtask
    await new Promise((r) => setImmediate(r));

    const events = parseSSE(res.chunks);
    const restartError = events.find((e) => e.event === 'error' && e.data?.step === 'restart');
    expect(restartError).toBeDefined();
    expect(restartError!.data.message).toMatch(/systemd|Restart manually/i);
  });

  it('calls res.end after systemctl error', async () => {
    setupHappyPath();
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => {
      cb(new Error('systemd not available'));
      return {} as any;
    });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');
    await new Promise((r) => setImmediate(r));

    expect(res.end).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// endOnce idempotency
// ---------------------------------------------------------------------------

describe('endOnce idempotency', () => {
  it('res.end called exactly once even when close event fires after pull error', async () => {
    const err: any = new Error('pull fail');
    err.stderr = 'fatal: bad';
    execFileAsyncSpy.mockRejectedValueOnce(err);

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    // Trigger close event after endOnce already ran
    req.triggerClose();
    req.triggerClose();

    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('res.end called exactly once on happy path (no double-end from close event)', async () => {
    setupHappyPath();
    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');
    await new Promise((r) => setImmediate(r)); // drain systemctl cb

    // Trigger close after completion
    req.triggerClose();

    expect(res.end).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// writeSSE skips write when already ended
// ---------------------------------------------------------------------------

describe('writeSSE skip after stream ended', () => {
  it('does not write to res after client disconnects mid-stream', async () => {
    // Pull succeeds, then checker.checkNow triggers the close event (simulating
    // the client disconnecting just after pull completes)
    execFileAsyncSpy.mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' });
    // Remaining calls resolve but should not cause writes after ended
    execFileAsyncSpy.mockResolvedValue({ stdout: '', stderr: '' });
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    const writeCountAtClose = { value: 0 };

    const checker = makeChecker(async () => {
      // Disconnect here — endOnce fires, ended = true
      req.triggerClose();
      writeCountAtClose.value = res.write.mock.calls.length;
      return {};
    });

    await handleUpdate(req, res, checker, '/repo');

    // Any writes that happened AFTER endOnce fired (after writeCountAtClose was recorded)
    // must not have increased the count. The implementation checks `if (!ended)` before
    // calling res.write, so subsequent writeSSE calls must be no-ops.
    expect(res.end).toHaveBeenCalledTimes(1);
    // The write count must not have grown after the close event fired
    expect(res.write.mock.calls.length).toBe(writeCountAtClose.value);
  });
});

// ---------------------------------------------------------------------------
// Lockfile change detection
// ---------------------------------------------------------------------------

describe('handleUpdate — lockfile change detection', () => {
  it('skips root npm install when package-lock.json not in diff', async () => {
    setupHappyPath({ rootDiff: 'src/index.ts\n' });
    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    const installSkip = events.find((e) => e.data?.step === 'install' && e.data?.status === 'skip');
    expect(installSkip).toBeDefined();
    expect(installSkip!.data.message).toMatch(/No lockfile/i);
  });

  it('runs root npm install when package-lock.json IS in diff', async () => {
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })    // pull
      .mockResolvedValueOnce({ stdout: 'package-lock.json\nsrc/x.ts\n', stderr: '' }) // diff root
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                         // npm install root
      .mockResolvedValueOnce({ stdout: 'src/bar.ts\n', stderr: '' })             // diff console
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                         // vite build
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    const installDone = events.find((e) => e.data?.step === 'install' && e.data?.status === 'done');
    expect(installDone).toBeDefined();
  });

  it('skips console npm install when console/package-lock.json not in diff', async () => {
    setupHappyPath({ consoleDiff: 'src/other.ts\n' });
    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    const skip = events.find((e) => e.data?.step === 'console-install' && e.data?.status === 'skip');
    expect(skip).toBeDefined();
    expect(skip!.data.message).toMatch(/No console lockfile/i);
  });

  it('runs console npm install when console/package-lock.json IS in diff', async () => {
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })           // pull
      .mockResolvedValueOnce({ stdout: 'src/foo.ts\n', stderr: '' })                   // diff root (no root lockfile)
      .mockResolvedValueOnce({ stdout: 'console/package-lock.json\nsrc/y.ts\n', stderr: '' }) // diff console
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                // npm install console
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                               // vite build
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    const done = events.find((e) => e.data?.step === 'console-install' && e.data?.status === 'done');
    expect(done).toBeDefined();
  });

  it('both root and console lockfiles changed — both installs run', async () => {
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'package-lock.json\n', stderr: '' })                  // root lockfile
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                      // npm install root
      .mockResolvedValueOnce({ stdout: 'console/package-lock.json\n', stderr: '' })           // console lockfile
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                      // npm install console
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                                     // vite build
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    expect(events.find((e) => e.data?.step === 'install' && e.data?.status === 'done')).toBeDefined();
    expect(events.find((e) => e.data?.step === 'console-install' && e.data?.status === 'done')).toBeDefined();
  });
});
