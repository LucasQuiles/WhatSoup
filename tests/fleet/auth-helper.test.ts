import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { trackAuthHelper } from '../../src/fleet/auth-helper.ts';

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
  }
});

describe('authentication helper native process confirmation', () => {
  it('keeps a running child owned after an error and confirms its requested termination', async () => {
    const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    children.push(child);
    const helper = trackAuthHelper(child);
    await once(child, 'message');
    child.emit('error', new Error('signal delivery uncertain'));
    expect(helper.confirmedClosed).toBe(false);
    expect(helper.phase).toBe('running');
    const stopping = helper.stop();
    expect(helper.stop()).toBe(stopping);
    expect(await stopping).toBe('closed');
    expect(helper.confirmedClosed).toBe(true);
    expect(helper.phase).toBe('closed');
    expect(child.signalCode).toBe('SIGTERM');
    expect(await helper.stop()).toBe('closed');
  });
});
