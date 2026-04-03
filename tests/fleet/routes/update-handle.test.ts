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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
// Sequence: rev-parse HEAD → git status --porcelain → git pull → diff prePullSha → vite build
function setupHappyPath({
  pullStdout = 'Already up to date.\n',
  diffFiles = 'src/foo.ts\nconsole/src/bar.ts\n',
  dirtyFiles = '',
} = {}) {
  execFileAsyncSpy
    .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })   // git rev-parse HEAD (pre-pull)
    .mockResolvedValueOnce({ stdout: dirtyFiles, stderr: '' })     // git status --porcelain (dirty check)
    .mockResolvedValueOnce({ stdout: pullStdout, stderr: '' })     // git pull
    .mockResolvedValueOnce({ stdout: diffFiles, stderr: '' })      // git diff prePullSha --name-only (single call)
    .mockResolvedValueOnce({ stdout: '', stderr: '' });            // npx vite build
  execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });
}

// ---------------------------------------------------------------------------
// Reset mocks before each test so state does not leak.
// The module-level `updateInProgress` flag CAN leak — see Mutex section below.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
});

// The systemctl restart step uses callback-based execFile (not promisified).
// Its callback fires on the next event loop tick AFTER handleUpdate() resolves,
// which means updateInProgress is still true when the test ends. Drain it here.
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
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
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' }) // rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' })          // git status --porcelain
      .mockRejectedValueOnce(err);                                // git pull fails

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
    // First two calls (rev-parse + porcelain) resolve immediately
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })  // rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' });           // git status --porcelain

    // Create a deferred promise so we can control when pull resolves
    let resolvePull!: (value: any) => void;
    const hangingPull = new Promise<any>((resolve) => { resolvePull = resolve; });
    execFileAsyncSpy.mockReturnValueOnce(hangingPull);              // git pull hangs

    const { req: req1, res: res1 } = makeReqRes();
    const { req: req2, res: res2 } = makeReqRes();

    // Start first call — do NOT await yet
    const firstCall = handleUpdate(req1, res1, makeChecker(), '/repo');

    // Yield microtasks so handleUpdate reaches the hanging pull and sets updateInProgress = true.
    // Need enough yields for: enter function → rev-parse await → porcelain await → pull (hangs)
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Second call — synchronous check of flag, should immediately 409
    await handleUpdate(req2, res2, makeChecker(), '/repo');

    expect(res2.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
    const body409 = JSON.parse(res2.end.mock.calls[0][0]);
    expect(body409.error).toMatch(/in progress/i);

    // Clean up: resolve the hanging pull so the first call can finish and reset the flag
    resolvePull({ stdout: 'Already up to date.\n', stderr: '' });

    // Set up remaining mocks for the first call to complete
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'console/src/foo.ts\n', stderr: '' })   // diff
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                       // vite build
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    await firstCall; // drain so updateInProgress resets to false
    // Extra drain: systemctl callback runs via setImmediate-like scheduling
    await new Promise((r) => setImmediate(r));
  });
});

// ---------------------------------------------------------------------------
// Error paths — git pull
// ---------------------------------------------------------------------------

describe('handleUpdate — git pull failure', () => {
  it('emits SSE error event with step=pull', async () => {
    const err: any = new Error('network unreachable');
    err.stderr = 'fatal: could not read from remote repository.';
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' }) // rev-parse HEAD (pre-pull)
      .mockResolvedValueOnce({ stdout: '', stderr: '' })          // git status --porcelain (clean)
      .mockRejectedValueOnce(err);                                // git pull fails

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    const pullError = events.find((e) => e.event === 'error' && e.data?.step === 'pull');
    expect(pullError).toBeDefined();
    expect(pullError!.data.message).toContain('could not read from remote');
  });

  it('uses err.message when err.stderr is absent', async () => {
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' }) // rev-parse HEAD (pre-pull)
      .mockResolvedValueOnce({ stdout: '', stderr: '' })          // git status --porcelain (clean)
      .mockRejectedValueOnce(new Error('ENOENT: git not found')); // git pull fails

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    const pullError = events.find((e) => e.event === 'error');
    expect(pullError?.data?.message).toContain('ENOENT');
  });

  it('calls res.end after pull error (stream is closed)', async () => {
    const err: any = new Error('bad');
    err.stderr = 'fatal: error';
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })          // git status --porcelain (clean)
      .mockRejectedValueOnce(err);

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    expect(res.end).toHaveBeenCalled();
  });

  it('does not emit install, build, or restart events after pull failure', async () => {
    const err: any = new Error('bad');
    err.stderr = 'fatal: error';
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })          // git status --porcelain (clean)
      .mockRejectedValueOnce(err);

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
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })             // rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                       // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'Already up to date.\n', stderr: '' }) // pull
      .mockResolvedValueOnce({ stdout: 'console/src/foo.ts\n', stderr: '' }); // diff (console/ file triggers build)

    const buildErr: any = new Error('build failed');
    buildErr.stderr = 'error: [vite] Transform failed with 3 errors.';
    execFileAsyncSpy.mockRejectedValueOnce(buildErr);                         // vite build
    execFileAsyncSpy.mockResolvedValueOnce({ stdout: '', stderr: '' });      // rollback: git reset --hard

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
    const err2: any = new Error('fail'); err2.stderr = 'vite error';
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })  // rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' })            // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'OK\n', stderr: '' })       // pull
      .mockResolvedValueOnce({ stdout: 'console/src/foo.ts\n', stderr: '' }) // diff
      .mockRejectedValueOnce(err2)                                  // vite build fails
      .mockResolvedValueOnce({ stdout: '', stderr: '' });           // rollback
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    expect(res.end).toHaveBeenCalled();
  });

  it('does not emit restart event after build failure', async () => {
    const err3: any = new Error('fail'); err3.stderr = 'vite error';
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })  // rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' })            // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'OK\n', stderr: '' })       // pull
      .mockResolvedValueOnce({ stdout: 'console/src/foo.ts\n', stderr: '' }) // diff
      .mockRejectedValueOnce(err3)                                  // vite build fails
      .mockResolvedValueOnce({ stdout: '', stderr: '' });           // rollback
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    const restartEvents = events.filter((e) => e.data?.step === 'restart');
    expect(restartEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rollback on post-pull failure
// ---------------------------------------------------------------------------

describe('handleUpdate — rollback', () => {
  it('calls git reset --hard prePullSha after npm install fails', async () => {
    const installErr: any = new Error('npm ERR! missing dep');
    installErr.stderr = 'npm ERR! peer dep missing';
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234abc1234abc1234abc1234abc1234abc1234\n', stderr: '' }) // rev-parse HEAD (full SHA)
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                              // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })                          // git pull
      .mockResolvedValueOnce({ stdout: 'package-lock.json\n', stderr: '' })                          // diff
      .mockRejectedValueOnce(installErr)                                                              // npm install fails
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                                             // git reset --hard (rollback)
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    // Rollback event emitted
    const rollbackEvent = events.find((e) => e.data?.step === 'rollback' && e.data?.status === 'done');
    expect(rollbackEvent).toBeDefined();
    // Error event also present
    const installError = events.find((e) => e.event === 'error' && e.data?.step === 'install');
    expect(installError).toBeDefined();
  });

  it('emits rollback:error when git reset --hard fails', async () => {
    const installErr: any = new Error('npm ERR!');
    installErr.stderr = 'install failed';
    const resetErr = new Error('git reset failed: permission denied');
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234abc1234abc1234abc1234abc1234abc1234\n', stderr: '' }) // rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                              // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })                          // git pull
      .mockResolvedValueOnce({ stdout: 'package-lock.json\n', stderr: '' })                          // diff
      .mockRejectedValueOnce(installErr)                                                              // npm install fails
      .mockRejectedValueOnce(resetErr);                                                               // git reset fails too
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    const rollbackError = events.find((e) => e.event === 'error' && e.data?.step === 'rollback');
    expect(rollbackError).toBeDefined();
    expect(rollbackError!.data.message).toContain('Rollback failed');
  });

  it('skips rollback when prePullSha is unavailable', async () => {
    // rev-parse fails → prePullSha = null → no rollback attempted
    const installErr: any = new Error('npm ERR!');
    installErr.stderr = 'install failed';
    execFileAsyncSpy
      .mockRejectedValueOnce(new Error('git not found'))      // rev-parse fails
      .mockResolvedValueOnce({ stdout: '', stderr: '' })      // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'OK\n', stderr: '' }) // pull succeeds
      .mockRejectedValueOnce(installErr);                     // npm install fails (no diff — runs unconditionally)
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    // No rollback event should exist
    const rollbackEvents = events.filter((e) => e.data?.step === 'rollback');
    expect(rollbackEvents).toHaveLength(0);
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
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' }) // rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' })          // git status --porcelain
      .mockRejectedValueOnce(err);

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
    // rev-parse + porcelain succeed, pull succeeds, then checker.checkNow triggers
    // the close event (simulating the client disconnecting just after pull completes)
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })       // rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                 // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' }); // pull
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
  // New sequence: rev-parse(pre-pull) → pull → diff(prePullSha, single call) → vite build
  // Lockfile checks use line-level matching on the single diff output.

  it('skips both installs when no lockfiles in diff', async () => {
    setupHappyPath({ diffFiles: 'src/index.ts\nsrc/other.ts\n' });
    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    expect(events.find((e) => e.data?.step === 'install' && e.data?.status === 'skip')).toBeDefined();
    expect(events.find((e) => e.data?.step === 'console-install' && e.data?.status === 'skip')).toBeDefined();
  });

  it('runs root npm install when package-lock.json IS in diff', async () => {
    // rev-parse → porcelain → pull → diff (has root lockfile) → npm install root
    // No console/ files in diff → console-build is skipped
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })                              // rev-parse
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                        // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })                    // pull
      .mockResolvedValueOnce({ stdout: 'package-lock.json\nsrc/x.ts\n', stderr: '' })          // diff
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                                       // npm install root
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');
    await new Promise((r) => setImmediate(r)); // drain systemctl cb

    const events = parseSSE(res.chunks);
    // debug removed
    expect(events.find((e) => e.data?.step === 'install' && e.data?.status === 'done')).toBeDefined();
    expect(events.find((e) => e.data?.step === 'console-install' && e.data?.status === 'skip')).toBeDefined();
  });

  it('runs console npm install when console/package-lock.json IS in diff', async () => {
    // console/ file in diff → console-build runs
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })                              // rev-parse
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                        // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })                    // pull
      .mockResolvedValueOnce({ stdout: 'console/package-lock.json\nsrc/y.ts\n', stderr: '' })  // diff
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                        // npm install console
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                                       // vite build
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    expect(events.find((e) => e.data?.step === 'install' && e.data?.status === 'skip')).toBeDefined();
    expect(events.find((e) => e.data?.step === 'console-install' && e.data?.status === 'done')).toBeDefined();
  });

  it('both root and console lockfiles changed — both installs run', async () => {
    // console/ file in diff → console-build runs
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })                                         // rev-parse
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                                    // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })                                // pull
      .mockResolvedValueOnce({ stdout: 'package-lock.json\nconsole/package-lock.json\n', stderr: '' })     // diff (both)
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                                    // npm install root
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                                    // npm install console
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                                                   // vite build
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    expect(events.find((e) => e.data?.step === 'install' && e.data?.status === 'done')).toBeDefined();
    expect(events.find((e) => e.data?.step === 'console-install' && e.data?.status === 'done')).toBeDefined();
  });

  it('does not false-match console/package-lock.json for root lockfile check', async () => {
    // Only console lockfile changed — root should SKIP; console/ file in diff triggers build
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })                              // rev-parse
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                        // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })                    // pull
      .mockResolvedValueOnce({ stdout: 'console/package-lock.json\n', stderr: '' })             // diff
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                        // npm install console
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                                       // vite build
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    // Root should be SKIPPED — console/package-lock.json should NOT trigger root install
    expect(events.find((e) => e.data?.step === 'install' && e.data?.status === 'skip')).toBeDefined();
    expect(events.find((e) => e.data?.step === 'console-install' && e.data?.status === 'done')).toBeDefined();
  });
});
