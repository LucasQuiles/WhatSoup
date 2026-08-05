import net from 'node:net';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startImsgRpcRelay, type ImsgRpcRelay } from '../../../src/transport/imessage/imsg-rpc-relay.ts';
import { trackTmpDirs } from '../../helpers/tmp-dir.ts';

// T1a coverage slice: the option-validation, version-probe, stale-socket,
// close-during-startup, and kill-escalation legs of the relay that the
// happy-path suite in imsg-rpc-relay.test.ts never enters.

const tmp = trackTmpDirs('');
const relays: ImsgRpcRelay[] = [];

afterEach(async () => {
  while (relays.length > 0) {
    const relay = relays.pop()!;
    await relay.close().catch(() => undefined);
  }
});

function track(relay: ImsgRpcRelay): ImsgRpcRelay {
  relays.push(relay);
  return relay;
}

interface Fixture {
  readonly root: string;
  readonly binary: string;
  readonly socketPath: string;
}

/** Fake imsg whose behaviour is selectable per test. */
function fixture(opts: { versionExit?: number; version?: string; trapSigterm?: boolean } = {}): Fixture {
  const root = tmp.make('whatsoup-imsg-branches');
  const binary = join(root, 'fake-imsg.mjs');
  const socketPath = join(root, 'relay.sock');
  const version = opts.version ?? '0.13.2';
  writeFileSync(binary, `#!/usr/bin/env node
const command = process.argv[2];
if (command === '--version') {
  ${opts.versionExit !== undefined
    ? `process.exit(${opts.versionExit});`
    : `process.stdout.write('imsg ${version}\\n'); process.exit(0);`}
}
if (command !== 'rpc') process.exit(64);
${opts.trapSigterm ? `process.on('SIGTERM', () => undefined);` : ''}
// Announce liveness so tests can await the spawn deterministically, then
// never exit on stdin end so the relay's grace/kill timers must fire.
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'alive' }) + '\\n');
process.stdin.resume();
setInterval(() => undefined, 1000);
`, { mode: 0o700 });
  chmodSync(binary, 0o700);
  return { root, binary, socketPath };
}

function options(fx: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    socketPath: fx.socketPath,
    imsgBinary: fx.binary,
    supportedVersions: ['0.13.2'],
    ...overrides,
  // The relay validates shape at runtime; the loose cast keeps the invalid
  // cases (which TypeScript would reject) expressible.
  } as Parameters<typeof startImsgRpcRelay>[0];
}

describe('imsg-rpc-relay branch coverage', () => {
  it('rejects a relative socket path', () => {
    const fx = fixture();
    expect(() => startImsgRpcRelay(options(fx, { socketPath: 'relative.sock' })))
      .toThrow('imsg relay socket path must be absolute');
  });

  it('rejects a socket path over the UNIX limit', () => {
    const fx = fixture();
    expect(() => startImsgRpcRelay(options(fx, { socketPath: `/${'x'.repeat(120)}.sock` })))
      .toThrow('exceeds the UNIX socket path limit');
  });

  it('rejects a relative imsg binary path', () => {
    const fx = fixture();
    expect(() => startImsgRpcRelay(options(fx, { imsgBinary: 'imsg' })))
      .toThrow('imsg binary path must be absolute');
  });

  it('rejects an empty supported-version list', () => {
    const fx = fixture();
    expect(() => startImsgRpcRelay(options(fx, { supportedVersions: [] })))
      .toThrow('requires at least one exact supported version');
  });

  it('rejects a non-exact supported-version pattern', () => {
    const fx = fixture();
    expect(() => startImsgRpcRelay(options(fx, { supportedVersions: ['0.13'] })))
      .toThrow('requires at least one exact supported version');
  });

  it.each([[0], [-5], [1.5]])('rejects maxLineBytes = %s', (maxLineBytes) => {
    const fx = fixture();
    expect(() => startImsgRpcRelay(options(fx, { maxLineBytes })))
      .toThrow('maxLineBytes must be a positive safe integer');
  });

  it('rejects when the version probe itself fails', async () => {
    const fx = fixture({ versionExit: 3 });
    const relay = track(startImsgRpcRelay(options(fx)));
    await expect(relay.ready).rejects.toThrow('imsg version probe failed');
  });

  it('rejects when the probe output carries no version at all', async () => {
    const fx = fixture();
    // Overwrite: exits 0 but prints no parseable version.
    writeFileSync(fx.binary, `#!/usr/bin/env node
process.stdout.write('no version here\\n');
process.exit(0);
`, { mode: 0o700 });
    const relay = track(startImsgRpcRelay(options(fx)));
    await expect(relay.ready).rejects.toThrow('unsupported imsg version');
  });

  it('reclaims a stale socket file left by a dead relay', async () => {
    const fx = fixture();
    // A bound-then-closed server leaves the socket file behind with nothing
    // listening — connection attempts get ECONNREFUSED, the "stale" leg.
    await new Promise<void>((resolve) => {
      const dead = net.createServer();
      dead.listen(fx.socketPath, () => {
        dead.close(() => resolve());
      });
    });
    const relay = track(startImsgRpcRelay(options(fx)));
    await expect(relay.ready).resolves.toBeUndefined();
  });

  it('refuses to start over a socket that is actively serving', async () => {
    const fx = fixture();
    const first = track(startImsgRpcRelay(options(fx)));
    await first.ready;
    const second = track(startImsgRpcRelay(options(fx)));
    await expect(second.ready).rejects.toThrow('imsg relay socket path is already active');
  });

  it('aborts startup when closed while starting', async () => {
    const fx = fixture();
    const relay = startImsgRpcRelay(options(fx));
    const closed = relay.close();
    await expect(relay.ready).rejects.toThrow('imsg relay closed during startup');
    await closed;
  });

  async function connectUntilChildAlive(socketPath: string): Promise<net.Socket> {
    const client = net.createConnection(socketPath);
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));
    // The fake child announces itself with an "alive" line the moment it
    // spawns; waiting for it makes the spawn deterministic without sleeping.
    await new Promise<void>((resolve) => client.once('data', () => resolve()));
    return client;
  }

  async function socketGoneAfterClose(socketPath: string): Promise<string> {
    return new Promise<string>((resolve) => {
      const probe = net.createConnection(socketPath);
      probe.once('connect', () => {
        probe.destroy();
        resolve('connected');
      });
      probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
    });
  }

  it('escalates to SIGKILL when the child survives stdin end and SIGTERM', async () => {
    const fx = fixture({ trapSigterm: true });
    const relay = track(startImsgRpcRelay(options(fx)));
    await relay.ready;
    const client = await connectUntilChildAlive(fx.socketPath);
    // Disconnect: the child ignores stdin end AND traps SIGTERM, so only the
    // kill timer can reap it. close() awaits session.stopped, which settles
    // only once finalize() runs after the SIGKILL escalation.
    client.destroy();
    await relay.close();
    // The relay must have unlinked its socket after the escalated teardown.
    expect(await socketGoneAfterClose(fx.socketPath)).toBe('ENOENT');
  }, 10_000);

  it('reaps a cooperative child via the SIGTERM grace path', async () => {
    const fx = fixture();
    const relay = track(startImsgRpcRelay(options(fx)));
    await relay.ready;
    const client = await connectUntilChildAlive(fx.socketPath);
    client.destroy();
    await relay.close();
    expect(await socketGoneAfterClose(fx.socketPath)).toBe('ENOENT');
  }, 10_000);
});
