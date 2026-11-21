/**
 * probeChainEntryCompletion against real child processes.
 *
 * Each child is a short Node script standing in for `opencode run --format json`:
 * it prints OpenCode JSON events (or something else) and exits, hangs, floods
 * stdout, or spawns a descendant. The probe passes only a complete, tool-free
 * "OK" turn, bounds captured output in bytes, and reaps the whole process tree
 * through killSessionTree when it has to stop the child.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CANARY_OUTPUT_LIMIT_BYTES,
  probeChainEntryCompletion,
} from '../../../../src/runtimes/agent/providers/chain-entry-canary.ts';

const NODE = process.execPath;

function event(type: string, part: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, sessionID: 'ses_synthetic', part });
}

const STEP_START = event('step_start');
const STOP = event('step_finish', { reason: 'stop', tokens: { input: 1, output: 1 } });
const text = (value: string): string => event('text', { text: value });
const TOOL_USE = event('tool_use', { callID: 'c1', tool: 'bash', state: { status: 'completed', output: 'x' } });

/** A child that prints `lines` (joined by newlines) and exits with `code`. */
function printer(lines: string[], code = 0): string[] {
  return ['-e', `process.stdout.write(${JSON.stringify(lines.join('\n') + '\n')}, () => process.exit(${code}));`];
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return predicate();
}

function probe(args: string[], timeoutMs = 10_000, prompt = 'Reply with exactly: OK') {
  return probeChainEntryCompletion(NODE, args, prompt, { PATH: process.env.PATH }, timeoutMs);
}

describe('probeChainEntryCompletion completion parsing', () => {
  it('passes a complete OpenCode turn whose only reply is OK', async () => {
    const result = await probe(printer([STEP_START, text('OK'), STOP]));
    expect(result).toMatchObject({ status: 'ok', evidence: null, failureClass: null });
  });

  it('accepts the reply with a trailing full stop and any case', async () => {
    const result = await probe(printer([STEP_START, text('ok.'), STOP]));
    expect(result.status).toBe('ok');
  });

  it('fails plain prose that exits cleanly without completion events', async () => {
    const result = await probe(printer(['Insufficient balance. Please recharge your account.']));
    expect(result.status).toBe('failed');
    expect(result.failureClass).toBe('auth');
  });

  it('fails a partial turn with no terminal step', async () => {
    const result = await probe(printer([STEP_START, text('OK')]));
    expect(result.status).toBe('failed');
  });

  it('fails a turn that contains a malformed event line', async () => {
    const result = await probe(printer([STEP_START, '{"type":"text",', text('OK'), STOP]));
    expect(result.status).toBe('failed');
  });

  it('fails a turn that used a tool', async () => {
    const result = await probe(printer([STEP_START, TOOL_USE, text('OK'), STOP]));
    expect(result.status).toBe('failed');
  });

  it('fails a complete turn whose reply is not OK', async () => {
    const result = await probe(printer([STEP_START, text('I cannot do that.'), STOP]));
    expect(result.status).toBe('failed');
  });

  it('fails an unknown event type such as a provider error event', async () => {
    const result = await probe(printer([STEP_START, event('error', { message: 'quota exceeded' }), STOP]));
    expect(result.status).toBe('failed');
  });

  it('still fails a non-zero exit after a complete OK turn', async () => {
    const result = await probe(printer([STEP_START, text('OK'), STOP], 3));
    expect(result.status).toBe('failed');
  });
});

describe('probeChainEntryCompletion single-turn grammar', () => {
  it('passes OK split across text chunks of one turn, with blank lines', async () => {
    const result = await probe(printer(['', STEP_START, text('O'), '', text('K'), STOP, '']));
    expect(result.status).toBe('ok');
  });

  it('fails a reply and terminal result with no step start', async () => {
    const result = await probe(printer([text('OK'), STOP]));
    expect(result.status).toBe('failed');
  });

  it('fails two complete turns whose texts only combine into OK', async () => {
    const result = await probe(printer([STEP_START, text('O'), STOP, STEP_START, text('K'), STOP]));
    expect(result.status).toBe('failed');
  });

  it('fails a new step started after the terminal result', async () => {
    const result = await probe(printer([STEP_START, text('OK'), STOP, STEP_START]));
    expect(result.status).toBe('failed');
  });

  it('fails a duplicate terminal result', async () => {
    const result = await probe(printer([STEP_START, text('OK'), STOP, STOP]));
    expect(result.status).toBe('failed');
  });

  it('fails text that arrives after the terminal result', async () => {
    const result = await probe(printer([STEP_START, text('OK'), STOP, text('.')]));
    expect(result.status).toBe('failed');
  });
});

describe('probeChainEntryCompletion output limit', () => {
  /** One valid OK turn whose step_start carries padding, exactly `totalBytes` of stdout. */
  function paddedTurn(totalBytes: number, padChar: string): string[] {
    const turn = (pad: string) => [event('step_start', { pad }), text('OK'), STOP];
    const bytes = (lines: string[]) => Buffer.byteLength(lines.join('\n') + '\n');
    const room = totalBytes - bytes(turn(''));
    const charBytes = Buffer.byteLength(padChar);
    return turn(padChar.repeat(Math.floor(room / charBytes)) + 'a'.repeat(room % charBytes));
  }

  it('defines the limit as 64 KiB of stdout bytes', () => {
    expect(CANARY_OUTPUT_LIMIT_BYTES).toBe(65_536);
  });

  it('accepts a turn of exactly the limit and fails one byte over it', async () => {
    const atLimit = paddedTurn(CANARY_OUTPUT_LIMIT_BYTES, 'a');
    expect(Buffer.byteLength(atLimit.join('\n') + '\n')).toBe(CANARY_OUTPUT_LIMIT_BYTES);
    expect((await probe(printer(atLimit))).status).toBe('ok');

    const overLimit = paddedTurn(CANARY_OUTPUT_LIMIT_BYTES + 1, 'a');
    expect(Buffer.byteLength(overLimit.join('\n') + '\n')).toBe(CANARY_OUTPUT_LIMIT_BYTES + 1);
    expect((await probe(printer(overLimit))).status).toBe('failed');
  });

  it('counts bytes, not string length, for multibyte output', async () => {
    const atLimit = paddedTurn(CANARY_OUTPUT_LIMIT_BYTES, 'é');
    expect(Buffer.byteLength(atLimit.join('\n') + '\n')).toBe(CANARY_OUTPUT_LIMIT_BYTES);
    expect((await probe(printer(atLimit))).status).toBe('ok');

    const overLimit = paddedTurn(CANARY_OUTPUT_LIMIT_BYTES + 1, 'é');
    const stdout = overLimit.join('\n') + '\n';
    expect(Buffer.byteLength(stdout)).toBe(CANARY_OUTPUT_LIMIT_BYTES + 1);
    expect(stdout.length).toBeLessThan(CANARY_OUTPUT_LIMIT_BYTES);
    expect((await probe(printer(overLimit))).status).toBe('failed');
  });

  it('stops a child that keeps writing past the limit', async () => {
    const started = Date.now();
    const result = await probe(['-e', `
      const chunk = 'x'.repeat(16_384);
      const write = () => process.stdout.write(chunk, write);
      write();
      setInterval(() => {}, 1_000);
    `], 30_000);
    expect(result.status).toBe('failed');
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 40_000);
});

describe('probeChainEntryCompletion process cleanup', () => {
  let dir: string;
  const spawned: number[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chain-canary-tree-'));
  });

  afterEach(() => {
    for (const pid of spawned.splice(0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('reaps a hung child and its descendant on timeout', async () => {
    const pidFile = join(dir, 'pids.json');
    const resultPromise = probe(['-e', `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
      setInterval(() => {}, 1000);
    `], 2_000);
    expect(await waitUntil(() => existsSync(pidFile), 8_000)).toBe(true);
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { child: number; grandchild: number };
    spawned.push(pids.child, pids.grandchild);

    const result = await resultPromise;

    expect(result.status).toBe('timeout');
    expect(await waitUntil(() => !isAlive(pids.child) && !isAlive(pids.grandchild), 8_000)).toBe(true);
    expect(isAlive(process.pid)).toBe(true);
  }, 30_000);

  it('reaps a still-running child and its descendant when output overflows', async () => {
    const pidFile = join(dir, 'pids.json');
    const resultPromise = probe(['-e', `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
      const chunk = 'x'.repeat(16_384);
      const write = () => process.stdout.write(chunk, write);
      write();
      setInterval(() => {}, 1000);
    `], 30_000);

    const result = await resultPromise;
    expect(existsSync(pidFile)).toBe(true);
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { child: number; grandchild: number };
    spawned.push(pids.child, pids.grandchild);

    expect(result.status).toBe('failed');
    expect(result.evidence).toBe(`output exceeded ${CANARY_OUTPUT_LIMIT_BYTES} bytes`);
    expect(await waitUntil(() => !isAlive(pids.child) && !isAlive(pids.grandchild), 8_000)).toBe(true);
    expect(isAlive(process.pid)).toBe(true);
  }, 40_000);

  it('settles as a failure when the child closes stdin before reading the prompt', async () => {
    const result = await probe(
      ['-e', `require('node:fs').closeSync(0); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); process.exit(1);`],
      10_000,
      'x'.repeat(1024 * 1024),
    );
    expect(result.status).toBe('failed');
  });
});
