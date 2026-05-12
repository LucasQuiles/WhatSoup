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

const { writeFileSyncSpy } = vi.hoisted(() => ({
  writeFileSyncSpy: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const orig = (await importOriginal()) as typeof import('node:fs');
  return {
    ...orig,
    writeFileSync: writeFileSyncSpy,
  };
});

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
  const orig = (await importOriginal()) as typeof import('node:util');
  return {
    ...orig,
    promisify: (_fn: any) => execFileAsyncSpy,
  };
});

// Now import the module under test — the mocks are already in place
// Mock the service manager factory so restart tests are platform-agnostic
// (LaunchdServiceManager on macOS calls launchctl stop+start; SystemdServiceManager
// on Linux calls systemctl restart. Stubbing createServiceManager lets us drive
// restart success/failure deterministically from the test without platform coupling.)
const { serviceManagerRestartSpy } = vi.hoisted(() => ({
  serviceManagerRestartSpy: vi.fn(),
}));
vi.mock('../../../src/fleet/platform.ts', () => ({
  createServiceManager: () => ({
    restart: serviceManagerRestartSpy,
    start: vi.fn(),
    stop: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    startFire: vi.fn(),
  }),
  detectPlatform: () => 'macos-launchd',
}));

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

function sseSequence(chunks: string[]) {
  return parseSSE(chunks).map((e) => ({
    event: e.event,
    step: e.data?.step,
    ...(e.data?.status === undefined ? {} : { status: e.data.status }),
  }));
}

function expectSSESequence(
  chunks: string[],
  expected: Array<{ event: string; step: string; status?: string }>,
) {
  expect(sseSequence(chunks)).toEqual(expected);
}

function execFileAsyncCalls() {
  return execFileAsyncSpy.mock.calls.map(([cmd, args, options]: any[]) => ({
    cmd,
    args,
    cwd: options?.cwd,
    timeout: options?.timeout,
  }));
}

function makeChecker(impl?: () => Promise<any>) {
  return {
    checkNow: vi.fn().mockImplementation(impl ?? (() => Promise.resolve({}))),
  } as any;
}

// Convenience: configure execFileAsync for the standard happy-path sequence.
// Call this at the start of a test; it mutates execFileAsyncSpy.
// Sequence: rev-parse HEAD → git status --porcelain → git pull → rev-parse --short HEAD → diff prePullSha → vite build
function setupHappyPath({
  pullStdout = 'Already up to date.\n',
  diffFiles = 'src/foo.ts\nconsole/src/bar.ts\n',
  dirtyFiles = '',
} = {}) {
  execFileAsyncSpy
    .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })   // git rev-parse HEAD (pre-pull)
    .mockResolvedValueOnce({ stdout: dirtyFiles, stderr: '' })     // git status --porcelain (dirty check)
    .mockResolvedValueOnce({ stdout: pullStdout, stderr: '' })     // git pull
    .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })   // git rev-parse --short HEAD (post-pull newSha)
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
  // Default: service manager restart resolves successfully. Tests that exercise
  // restart failures override with serviceManagerRestartSpy.mockRejectedValueOnce.
  serviceManagerRestartSpy.mockResolvedValue(undefined);
  // Default: fs.writeFileSync succeeds. Tests that exercise patch-write failure
  // override with writeFileSyncSpy.mockImplementationOnce(() => { throw ... }).
  writeFileSyncSpy.mockImplementation(() => undefined);
});

// The service manager restart runs on the next event loop tick AFTER
// handleUpdate() resolves (see the .catch().finally() chain in update.ts),
// which means updateInProgress is still true when the test body returns.
// Drain the microtask queue here so mutex state does not leak across tests.
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

    expect(res.chunks).toHaveLength(9);
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

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
  });

  it('emits the exact happy-path progress sequence and side effects', async () => {
    setupHappyPath();
    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'progress', step: 'install', status: 'skip' },
      { event: 'progress', step: 'console-install', status: 'running' },
      { event: 'progress', step: 'console-install', status: 'skip' },
      { event: 'progress', step: 'console-build', status: 'running' },
      { event: 'progress', step: 'console-build', status: 'done' },
      { event: 'progress', step: 'restart', status: 'running' },
    ]);
    expect(execFileAsyncCalls()).toEqual([
      { cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['pull', 'origin', 'main'], cwd: '/repo', timeout: 60_000 },
      { cmd: 'git', args: ['rev-parse', '--short', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['diff', 'abc1234', '--name-only'], cwd: '/repo', timeout: 10_000 },
      { cmd: 'npx', args: ['vite', 'build'], cwd: '/repo/console', timeout: 120_000 },
    ]);
    expect(serviceManagerRestartSpy).toHaveBeenCalledTimes(1);
    expect(serviceManagerRestartSpy).toHaveBeenCalledWith('whatsoup-fleet');
  });

  it('emits pull:running before pull:done', async () => {
    setupHappyPath();
    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    expect(sseSequence(res.chunks).slice(0, 2)).toEqual([
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
    ]);
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

    expect(res2.writeHead).toHaveBeenCalledWith(409, { 'Content-Type': 'application/json' });
    const body409 = JSON.parse(res2.end.mock.calls[0][0]);
    expect(body409).toEqual({ error: 'Update already in progress' });
    expect(res2.end).toHaveBeenCalledTimes(1);

    // Clean up: resolve the hanging pull so the first call can finish and reset the flag
    resolvePull({ stdout: 'Already up to date.\n', stderr: '' });

    // Set up remaining mocks for the first call to complete
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })             // rev-parse --short HEAD (post-pull)
      .mockResolvedValueOnce({ stdout: 'console/src/foo.ts\n', stderr: '' })   // diff
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                       // vite build
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    await firstCall; // drain so updateInProgress resets to false
    // Extra drain: systemctl callback runs via setImmediate-like scheduling
    await new Promise((r) => setImmediate(r));
  });

  it('keeps the mutex after client disconnect while update work continues', async () => {
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })  // rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' });           // git status --porcelain

    let resolvePull!: (value: any) => void;
    const hangingPull = new Promise<any>((resolve) => { resolvePull = resolve; });
    execFileAsyncSpy.mockReturnValueOnce(hangingPull);              // git pull continues after disconnect

    const { req: req1, res: res1 } = makeReqRes();
    const { req: req2, res: res2 } = makeReqRes();

    const firstCall = handleUpdate(req1, res1, makeChecker(), '/repo');

    for (let i = 0; i < 10; i++) await Promise.resolve();
    req1.triggerClose();

    await handleUpdate(req2, res2, makeChecker(), '/repo');
    const secondWriteHeadCall = res2.writeHead.mock.calls[0];
    const secondEndBody = res2.end.mock.calls[0]?.[0];

    resolvePull({ stdout: 'Already up to date.\n', stderr: '' });
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })             // rev-parse --short HEAD
      .mockResolvedValueOnce({ stdout: 'console/src/foo.ts\n', stderr: '' })   // diff
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                      // vite build

    await firstCall;
    await new Promise((r) => setImmediate(r));

    expect(secondWriteHeadCall).toEqual([409, { 'Content-Type': 'application/json' }]);
    expect(JSON.parse(secondEndBody)).toEqual({ error: 'Update already in progress' });
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
    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'error', step: 'pull' },
    ]);
    expect(events[1].data).toEqual({
      step: 'pull',
      message: 'fatal: could not read from remote repository.',
    });
  });

  it('uses err.message when err.stderr is absent', async () => {
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' }) // rev-parse HEAD (pre-pull)
      .mockResolvedValueOnce({ stdout: '', stderr: '' })          // git status --porcelain (clean)
      .mockRejectedValueOnce(new Error('ENOENT: git not found')); // git pull fails

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'error', step: 'pull' },
    ]);
    expect(events[1].data).toEqual({
      step: 'pull',
      message: 'ENOENT: git not found',
    });
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

    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'error', step: 'pull' },
    ]);
    expect(res.end).toHaveBeenCalledTimes(1);
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

    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'error', step: 'pull' },
    ]);
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
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })             // rev-parse --short HEAD (post-pull)
      .mockResolvedValueOnce({ stdout: 'console/src/foo.ts\n', stderr: '' }); // diff (console/ file triggers build)

    const buildErr: any = new Error('build failed');
    buildErr.stderr = 'error: [vite] Transform failed with 3 errors.';
    execFileAsyncSpy.mockRejectedValueOnce(buildErr);                         // vite build
    execFileAsyncSpy.mockResolvedValueOnce({ stdout: '', stderr: '' });      // rollback: git status (clean)
    execFileAsyncSpy.mockResolvedValueOnce({ stdout: '', stderr: '' });      // rollback: git reset --hard

    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    const checker = makeChecker();
    await handleUpdate(req, res, checker, '/repo');

    const events = parseSSE(res.chunks);
    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'progress', step: 'install', status: 'skip' },
      { event: 'progress', step: 'console-install', status: 'running' },
      { event: 'progress', step: 'console-install', status: 'skip' },
      { event: 'progress', step: 'console-build', status: 'running' },
      { event: 'error', step: 'console-build' },
      { event: 'progress', step: 'rollback', status: 'done' },
    ]);
    expect(events[7].data).toEqual({
      step: 'console-build',
      message: 'error: [vite] Transform failed with 3 errors.',
    });
    expect(execFileAsyncCalls()).toEqual([
      { cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['pull', 'origin', 'main'], cwd: '/repo', timeout: 60_000 },
      { cmd: 'git', args: ['rev-parse', '--short', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['diff', 'abc1234', '--name-only'], cwd: '/repo', timeout: 10_000 },
      { cmd: 'npx', args: ['vite', 'build'], cwd: '/repo/console', timeout: 120_000 },
      { cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['reset', '--hard', 'abc1234'], cwd: '/repo', timeout: 15_000 },
    ]);
  });

  it('calls res.end after build failure', async () => {
    const err2: any = new Error('fail'); err2.stderr = 'vite error';
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })  // rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' })            // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'OK\n', stderr: '' })       // pull
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })  // rev-parse --short HEAD (post-pull)
      .mockResolvedValueOnce({ stdout: 'console/src/foo.ts\n', stderr: '' }) // diff
      .mockRejectedValueOnce(err2)                                  // vite build fails
      .mockResolvedValueOnce({ stdout: '', stderr: '' })            // rollback: git status (clean)
      .mockResolvedValueOnce({ stdout: '', stderr: '' });           // rollback: git reset
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'progress', step: 'install', status: 'skip' },
      { event: 'progress', step: 'console-install', status: 'running' },
      { event: 'progress', step: 'console-install', status: 'skip' },
      { event: 'progress', step: 'console-build', status: 'running' },
      { event: 'error', step: 'console-build' },
      { event: 'progress', step: 'rollback', status: 'done' },
    ]);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('does not emit restart event after build failure', async () => {
    const err3: any = new Error('fail'); err3.stderr = 'vite error';
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })  // rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' })            // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'OK\n', stderr: '' })       // pull
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })  // rev-parse --short HEAD (post-pull)
      .mockResolvedValueOnce({ stdout: 'console/src/foo.ts\n', stderr: '' }) // diff
      .mockRejectedValueOnce(err3)                                  // vite build fails
      .mockResolvedValueOnce({ stdout: '', stderr: '' })            // rollback: git status (clean)
      .mockResolvedValueOnce({ stdout: '', stderr: '' });           // rollback: git reset
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'progress', step: 'install', status: 'skip' },
      { event: 'progress', step: 'console-install', status: 'running' },
      { event: 'progress', step: 'console-install', status: 'skip' },
      { event: 'progress', step: 'console-build', status: 'running' },
      { event: 'error', step: 'console-build' },
      { event: 'progress', step: 'rollback', status: 'done' },
    ]);
    expect(serviceManagerRestartSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rollback on post-pull failure
// ---------------------------------------------------------------------------

describe('handleUpdate — rollback', () => {
  it('calls git reset --hard prePullSha after npm install fails (clean working tree)', async () => {
    const installErr: any = new Error('npm ERR! missing dep');
    installErr.stderr = 'npm ERR! peer dep missing';
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234abc1234abc1234abc1234abc1234abc1234\n', stderr: '' }) // rev-parse HEAD (full SHA)
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                              // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })                          // git pull
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })                                    // rev-parse --short HEAD (post-pull)
      .mockResolvedValueOnce({ stdout: 'package-lock.json\n', stderr: '' })                          // diff
      .mockRejectedValueOnce(installErr)                                                              // npm install fails
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                              // rollback: git status (clean)
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                                             // git reset --hard (rollback)
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'error', step: 'install' },
      { event: 'progress', step: 'rollback', status: 'done' },
    ]);
    expect(events[3].data).toEqual({
      step: 'install',
      message: 'npm ERR! peer dep missing',
    });
    expect(events[4].data).toEqual({
      step: 'rollback',
      status: 'done',
      sha: 'abc1234abc1234abc1234abc1234abc1234abc1234',
      message: 'Rolled back to abc1234',
      preservedFiles: [],
    });
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    expect(execFileAsyncCalls()).toEqual([
      { cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['pull', 'origin', 'main'], cwd: '/repo', timeout: 60_000 },
      { cmd: 'git', args: ['rev-parse', '--short', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      {
        cmd: 'git',
        args: ['diff', 'abc1234abc1234abc1234abc1234abc1234abc1234', '--name-only'],
        cwd: '/repo',
        timeout: 10_000,
      },
      { cmd: 'npm', args: ['install'], cwd: '/repo', timeout: 120_000 },
      { cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 },
      {
        cmd: 'git',
        args: ['reset', '--hard', 'abc1234abc1234abc1234abc1234abc1234abc1234'],
        cwd: '/repo',
        timeout: 15_000,
      },
    ]);
  });

  it('preserves post-pull lockfile drift via patch + stash before reset', async () => {
    const installErr: any = new Error('npm ERR!');
    installErr.stderr = 'install failed';
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234abc1234abc1234abc1234abc1234abc1234\n', stderr: '' }) // rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                              // pre-flight git status (clean)
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })                          // git pull
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })                                    // rev-parse --short HEAD
      .mockResolvedValueOnce({ stdout: 'package-lock.json\n', stderr: '' })                          // diff
      .mockRejectedValueOnce(installErr)                                                              // npm install fails
      .mockResolvedValueOnce({ stdout: ' M package-lock.json\n', stderr: '' })                      // rollback: git status (drift)
      .mockResolvedValueOnce({ stdout: 'diff --git a/package-lock.json b/package-lock.json\n', stderr: '' }) // git diff HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                              // git stash push
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                                             // git reset --hard
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    const rollbackEvent = events[events.length - 1];
    expect(rollbackEvent.event).toBe('progress');
    expect(rollbackEvent.data.step).toBe('rollback');
    expect(rollbackEvent.data.status).toBe('done');
    expect(rollbackEvent.data.preservedFiles).toEqual(['package-lock.json']);
    expect(rollbackEvent.data.patchPath).toMatch(/^\/tmp\/whatsoup-update-rollback-.*-abc1234\.patch$/);
    expect(rollbackEvent.data.stashRef).toBe('stash@{0}');

    // Patch was written before the destructive reset.
    expect(writeFileSyncSpy).toHaveBeenCalledTimes(1);
    const [patchPathArg, patchBodyArg] = writeFileSyncSpy.mock.calls[0];
    expect(patchPathArg).toMatch(/^\/tmp\/whatsoup-update-rollback-.*-abc1234\.patch$/);
    expect(patchBodyArg).toContain('diff --git a/package-lock.json');

    // Ordering: status -> diff -> stash push -> reset.
    const calls = execFileAsyncCalls();
    const rollbackSlice = calls.slice(-4);
    expect(rollbackSlice[0]).toEqual({ cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 });
    expect(rollbackSlice[1]).toEqual({ cmd: 'git', args: ['diff', 'HEAD'], cwd: '/repo', timeout: 10_000 });
    expect(rollbackSlice[2].cmd).toBe('git');
    expect(rollbackSlice[2].args.slice(0, 4)).toEqual(['stash', 'push', '--include-untracked', '--message']);
    expect(rollbackSlice[2].args[4]).toMatch(/^whatsoup-update-rollback /);
    expect(rollbackSlice[3]).toEqual({
      cmd: 'git',
      args: ['reset', '--hard', 'abc1234abc1234abc1234abc1234abc1234abc1234'],
      cwd: '/repo',
      timeout: 15_000,
    });
  });

  it('skips reset and emits status=skipped when patch write fails', async () => {
    const installErr: any = new Error('npm ERR!');
    installErr.stderr = 'install failed';
    const writeErr: any = new Error('ENOSPC: no space left on device');
    writeErr.code = 'ENOSPC';
    writeFileSyncSpy.mockImplementationOnce(() => { throw writeErr; });

    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234abc1234abc1234abc1234abc1234abc1234\n', stderr: '' }) // rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                              // pre-flight status (clean)
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })                          // git pull
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })                                    // rev-parse --short HEAD
      .mockResolvedValueOnce({ stdout: 'package-lock.json\n', stderr: '' })                          // diff
      .mockRejectedValueOnce(installErr)                                                              // npm install fails
      .mockResolvedValueOnce({ stdout: ' M package-lock.json\n', stderr: '' })                      // rollback: status (drift)
      .mockResolvedValueOnce({ stdout: 'diff --git ...\n', stderr: '' });                           // git diff HEAD
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    const rollbackEvent = events[events.length - 1];
    expect(rollbackEvent.event).toBe('progress');
    expect(rollbackEvent.data).toEqual({
      step: 'rollback',
      status: 'skipped',
      reason: 'patch-write-failed',
      files: ['package-lock.json'],
    });

    // CRITICAL: git reset --hard MUST NOT have been called.
    const resetCalls = execFileAsyncCalls().filter(
      (c) => c.cmd === 'git' && Array.isArray(c.args) && c.args[0] === 'reset',
    );
    expect(resetCalls).toEqual([]);
  });

  it('emits rollback:error when git reset --hard fails', async () => {
    const installErr: any = new Error('npm ERR!');
    installErr.stderr = 'install failed';
    const resetErr = new Error('git reset failed: permission denied');
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234abc1234abc1234abc1234abc1234abc1234\n', stderr: '' }) // rev-parse HEAD
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                              // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })                          // git pull
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })                                    // rev-parse --short HEAD (post-pull)
      .mockResolvedValueOnce({ stdout: 'package-lock.json\n', stderr: '' })                          // diff
      .mockRejectedValueOnce(installErr)                                                              // npm install fails
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                              // rollback: git status (clean)
      .mockRejectedValueOnce(resetErr);                                                               // git reset fails too
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    const events = parseSSE(res.chunks);
    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'error', step: 'install' },
      { event: 'error', step: 'rollback' },
    ]);
    expect(events[4].data).toEqual({
      step: 'rollback',
      message: 'Rollback failed: git reset failed: permission denied',
    });
  });

  it('skips rollback when prePullSha is unavailable', async () => {
    // rev-parse fails → prePullSha = null → no rollback attempted
    const installErr: any = new Error('npm ERR!');
    installErr.stderr = 'install failed';
    execFileAsyncSpy
      .mockRejectedValueOnce(new Error('git not found'))      // rev-parse fails
      .mockResolvedValueOnce({ stdout: '', stderr: '' })      // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'OK\n', stderr: '' }) // pull succeeds
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' }) // rev-parse --short HEAD (post-pull)
      .mockRejectedValueOnce(installErr);                     // npm install fails (no diff — runs unconditionally)
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'error', step: 'install' },
    ]);
    expect(execFileAsyncCalls()).toEqual([
      { cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['pull', 'origin', 'main'], cwd: '/repo', timeout: 60_000 },
      { cmd: 'git', args: ['rev-parse', '--short', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'npm', args: ['install'], cwd: '/repo', timeout: 120_000 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Error paths — systemctl restart
// ---------------------------------------------------------------------------

describe('handleUpdate — service manager restart error', () => {
  it('emits SSE error event with step=restart when service manager restart fails', async () => {
    setupHappyPath();
    serviceManagerRestartSpy.mockRejectedValueOnce(new Error('Failed to connect to bus'));

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    // .catch/.finally chain on svcMgr.restart runs on the next microtask
    await new Promise((r) => setImmediate(r));

    const events = parseSSE(res.chunks);
    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'progress', step: 'install', status: 'skip' },
      { event: 'progress', step: 'console-install', status: 'running' },
      { event: 'progress', step: 'console-install', status: 'skip' },
      { event: 'progress', step: 'console-build', status: 'running' },
      { event: 'progress', step: 'console-build', status: 'done' },
      { event: 'progress', step: 'restart', status: 'running' },
      { event: 'error', step: 'restart' },
    ]);
    expect(events[9].data).toEqual({
      step: 'restart',
      message: 'Fleet restart failed: Failed to connect to bus. Restart manually: npm run fleet',
    });
  });

  it('calls res.end after service manager restart error', async () => {
    setupHappyPath();
    serviceManagerRestartSpy.mockRejectedValueOnce(new Error('service not available'));

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');
    await new Promise((r) => setImmediate(r));

    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'progress', step: 'install', status: 'skip' },
      { event: 'progress', step: 'console-install', status: 'running' },
      { event: 'progress', step: 'console-install', status: 'skip' },
      { event: 'progress', step: 'console-build', status: 'running' },
      { event: 'progress', step: 'console-build', status: 'done' },
      { event: 'progress', step: 'restart', status: 'running' },
      { event: 'error', step: 'restart' },
    ]);
    expect(res.end).toHaveBeenCalledTimes(1);
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
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' }) // pull
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' });      // rev-parse --short HEAD (post-pull)
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

    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'progress', step: 'install', status: 'skip' },
      { event: 'progress', step: 'console-install', status: 'running' },
      { event: 'progress', step: 'console-install', status: 'skip' },
      { event: 'progress', step: 'console-build', status: 'skip' },
      { event: 'progress', step: 'restart', status: 'running' },
    ]);
    expect(execFileAsyncCalls()).toEqual([
      { cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['pull', 'origin', 'main'], cwd: '/repo', timeout: 60_000 },
      { cmd: 'git', args: ['rev-parse', '--short', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['diff', 'abc1234', '--name-only'], cwd: '/repo', timeout: 10_000 },
    ]);
  });

  it('runs root npm install when package-lock.json IS in diff', async () => {
    // rev-parse → porcelain → pull → rev-parse --short → diff (has root lockfile) → npm install root
    // No console/ files in diff → console-build is skipped
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })                              // rev-parse
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                        // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })                    // pull
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })                              // rev-parse --short HEAD (post-pull)
      .mockResolvedValueOnce({ stdout: 'package-lock.json\nsrc/x.ts\n', stderr: '' })          // diff
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                                       // npm install root
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');
    await new Promise((r) => setImmediate(r)); // drain systemctl cb

    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'progress', step: 'install', status: 'done' },
      { event: 'progress', step: 'console-install', status: 'running' },
      { event: 'progress', step: 'console-install', status: 'skip' },
      { event: 'progress', step: 'console-build', status: 'skip' },
      { event: 'progress', step: 'restart', status: 'running' },
    ]);
    expect(execFileAsyncCalls()).toEqual([
      { cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['pull', 'origin', 'main'], cwd: '/repo', timeout: 60_000 },
      { cmd: 'git', args: ['rev-parse', '--short', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['diff', 'abc1234', '--name-only'], cwd: '/repo', timeout: 10_000 },
      { cmd: 'npm', args: ['install'], cwd: '/repo', timeout: 120_000 },
    ]);
  });

  it('runs console npm install when console/package-lock.json IS in diff', async () => {
    // console/ file in diff → console-build runs
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })                              // rev-parse
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                        // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })                    // pull
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })                              // rev-parse --short HEAD (post-pull)
      .mockResolvedValueOnce({ stdout: 'console/package-lock.json\nsrc/y.ts\n', stderr: '' })  // diff
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                        // npm install console
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                                       // vite build
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'progress', step: 'install', status: 'skip' },
      { event: 'progress', step: 'console-install', status: 'running' },
      { event: 'progress', step: 'console-install', status: 'done' },
      { event: 'progress', step: 'console-build', status: 'running' },
      { event: 'progress', step: 'console-build', status: 'done' },
      { event: 'progress', step: 'restart', status: 'running' },
    ]);
    expect(execFileAsyncCalls()).toEqual([
      { cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['pull', 'origin', 'main'], cwd: '/repo', timeout: 60_000 },
      { cmd: 'git', args: ['rev-parse', '--short', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['diff', 'abc1234', '--name-only'], cwd: '/repo', timeout: 10_000 },
      { cmd: 'npm', args: ['install'], cwd: '/repo/console', timeout: 120_000 },
      { cmd: 'npx', args: ['vite', 'build'], cwd: '/repo/console', timeout: 120_000 },
    ]);
  });

  it('both root and console lockfiles changed — both installs run', async () => {
    // console/ file in diff → console-build runs
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })                                         // rev-parse
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                                    // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })                                // pull
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })                                          // rev-parse --short HEAD (post-pull)
      .mockResolvedValueOnce({ stdout: 'package-lock.json\nconsole/package-lock.json\n', stderr: '' })     // diff (both)
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                                    // npm install root
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                                    // npm install console
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                                                   // vite build
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'progress', step: 'install', status: 'done' },
      { event: 'progress', step: 'console-install', status: 'running' },
      { event: 'progress', step: 'console-install', status: 'done' },
      { event: 'progress', step: 'console-build', status: 'running' },
      { event: 'progress', step: 'console-build', status: 'done' },
      { event: 'progress', step: 'restart', status: 'running' },
    ]);
    expect(execFileAsyncCalls()).toEqual([
      { cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['pull', 'origin', 'main'], cwd: '/repo', timeout: 60_000 },
      { cmd: 'git', args: ['rev-parse', '--short', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['diff', 'abc1234', '--name-only'], cwd: '/repo', timeout: 10_000 },
      { cmd: 'npm', args: ['install'], cwd: '/repo', timeout: 120_000 },
      { cmd: 'npm', args: ['install'], cwd: '/repo/console', timeout: 120_000 },
      { cmd: 'npx', args: ['vite', 'build'], cwd: '/repo/console', timeout: 120_000 },
    ]);
  });

  it('does not false-match console/package-lock.json for root lockfile check', async () => {
    // Only console lockfile changed — root should SKIP; console/ file in diff triggers build
    execFileAsyncSpy
      .mockResolvedValueOnce({ stdout: 'abc1234\n', stderr: '' })                              // rev-parse
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                        // git status --porcelain
      .mockResolvedValueOnce({ stdout: 'Updating abc..def\n', stderr: '' })                    // pull
      .mockResolvedValueOnce({ stdout: 'def5678\n', stderr: '' })                              // rev-parse --short HEAD (post-pull)
      .mockResolvedValueOnce({ stdout: 'console/package-lock.json\n', stderr: '' })             // diff
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                                        // npm install console
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                                       // vite build
    execFileCbSpy.mockImplementation((_cmd: any, _args: any, cb: any) => { cb(null); return {} as any; });

    const { req, res } = makeReqRes();
    await handleUpdate(req, res, makeChecker(), '/repo');

    expectSSESequence(res.chunks, [
      { event: 'progress', step: 'pull', status: 'running' },
      { event: 'progress', step: 'pull', status: 'done' },
      { event: 'progress', step: 'install', status: 'running' },
      { event: 'progress', step: 'install', status: 'skip' },
      { event: 'progress', step: 'console-install', status: 'running' },
      { event: 'progress', step: 'console-install', status: 'done' },
      { event: 'progress', step: 'console-build', status: 'running' },
      { event: 'progress', step: 'console-build', status: 'done' },
      { event: 'progress', step: 'restart', status: 'running' },
    ]);
    expect(execFileAsyncCalls()).toEqual([
      { cmd: 'git', args: ['rev-parse', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['status', '--porcelain'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['pull', 'origin', 'main'], cwd: '/repo', timeout: 60_000 },
      { cmd: 'git', args: ['rev-parse', '--short', 'HEAD'], cwd: '/repo', timeout: 5_000 },
      { cmd: 'git', args: ['diff', 'abc1234', '--name-only'], cwd: '/repo', timeout: 10_000 },
      { cmd: 'npm', args: ['install'], cwd: '/repo/console', timeout: 120_000 },
      { cmd: 'npx', args: ['vite', 'build'], cwd: '/repo/console', timeout: 120_000 },
    ]);
  });
});
