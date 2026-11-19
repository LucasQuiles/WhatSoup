import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

// Black-box tests of the standalone console unlock helper. Each test runs the
// helper as a child process with a temporary HOME. The CDP endpoint is either a
// port with no listener or the small CDP stand-in below.
const HELPER = join(process.cwd(), 'deploy/scripts/whatsoup-console-unlock.mjs');
const FILE_TOKEN = 'a'.repeat(64);
const ENV_TOKEN = 'b'.repeat(64);
const OVERRIDE_TOKEN = 'c'.repeat(64);

let home: string;
let configDir: string;

interface HelperRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function writeTokenFile(path: string, { mode = 0o600, active = FILE_TOKEN }: { mode?: number; active?: string } = {}): void {
  writeFileSync(path, JSON.stringify({ active, accept: [], rotatedAt: '1970-01-01T00:00:00.000Z' }));
  chmodSync(path, mode);
}

function helperEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { HOME: home, PATH: process.env.PATH ?? '', CDP_PORT: '1', FLEET: 'http://127.0.0.1:9227', ...overrides };
}

// Nothing listens on CDP_PORT=1, so a helper that accepts the token file stops
// at its first CDP request with "err:..."; a helper that refuses the file
// prints "no-fleet-token:<reason>" before any request.
function runHelper(overrides: Record<string, string> = {}, nodeArgs: string[] = []): HelperRun {
  const result = spawnSync(process.execPath, [...nodeArgs, HELPER], {
    env: helperEnv(overrides),
    encoding: 'utf8',
    timeout: 8_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function expectPastTokenRead(result: HelperRun): void {
  expect(result.status).toBe(1);
  expect(result.stdout).toMatch(/^err:/);
}

// Each refusal names its reason and never the path.
function expectRefused(result: HelperRun, reason: string): void {
  expect(result).toEqual({ status: 1, stdout: `no-fleet-token:${reason}\n`, stderr: '' });
}

// The helper's size bound; a real token file is under 1 KiB.
const MAX_TOKEN_FILE_BYTES = 64 * 1024;

function writePaddedTokenFile(path: string, size: number): void {
  const base = JSON.stringify({ active: FILE_TOKEN, accept: [], rotatedAt: '1970-01-01T00:00:00.000Z', padding: '' });
  writeFileSync(path, base.replace('"padding":""', `"padding":"${'x'.repeat(size - base.length)}"`));
  chmodSync(path, 0o600);
}

// A preload that wraps one node:fs stat call. The test can only create files
// it owns, so a changed uid or inode stands in for another owner or a swapped
// file. With an empty change it only wraps, which is the control.
function statPreload(name: string, call: 'lstatSync' | 'fstatSync', change: string): string {
  const file = join(home, `${name}.mjs`);
  writeFileSync(file, [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    `const real = fs.${call};`,
    `fs.${call} = (target, ...rest) => { const stat = real(target, ...rest); ${change} return stat; };`,
    'syncBuiltinESMExports();',
    '',
  ].join('\n'));
  return pathToFileURL(file).href;
}

function runHelperAsync(env: NodeJS.ProcessEnv): Promise<HelperRun> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [HELPER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolveRun({ status, stdout, stderr });
    });
  });
}

// --- Minimal CDP stand-in: GET /json plus one WebSocket per page target. ---

interface CdpTab {
  id: string;
  url: string;
}

interface MockCdpConfig {
  /** Answers to GET /json, in request order; the last answer repeats. */
  lists: CdpTab[][];
  /** Answer of the page's own POST /api/auth-ticket probe. */
  authTicket: 'valid' | 'locked';
  /** Answer to a bare `location.origin === ...` check (not the readiness check). */
  liveOriginMatches?: boolean;
}

interface MockCdpRecord {
  /** WebSocket paths the helper connected to, in order. */
  connectionPaths: string[];
  /** First argument of every Runtime.callFunctionOn (the unlock call). */
  tokensSent: unknown[];
  /** Every text frame the helper sent. */
  frames: string[];
}

interface MockCdp {
  port: number;
  origin: string;
  record: MockCdpRecord;
  close(): Promise<void>;
}

interface CdpMessage {
  id: number;
  method: string;
  params?: { expression?: string; arguments?: Array<{ value?: unknown }> };
}

function answerCdp(config: MockCdpConfig, record: MockCdpRecord, message: CdpMessage): unknown {
  if (message.method === 'Runtime.callFunctionOn') {
    record.tokensSent.push(message.params?.arguments?.[0]?.value);
    return { result: { value: 'unlocked' } };
  }
  if (message.method !== 'Runtime.evaluate') return {};
  const expression = message.params?.expression ?? '';
  if (expression === 'window') return { result: { objectId: 'window-object' } };
  if (expression.includes('document.readyState')) return { result: { value: true } };
  if (expression.includes('/api/auth-ticket')) return { result: { value: config.authTicket } };
  if (expression.includes('location.origin')) return { result: { value: config.liveOriginMatches ?? true } };
  return { result: {} };
}

function sendFrame(socket: Duplex, value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value));
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  socket.write(Buffer.concat([header, payload]));
}

interface FrameReader {
  buffer: Buffer;
}

// Client frames are always masked (RFC 6455 section 5.3).
function readClientFrames(reader: FrameReader, chunk: Buffer, onText: (text: string) => void, onClose: () => void): void {
  reader.buffer = Buffer.concat([reader.buffer, chunk]);
  while (reader.buffer.length >= 2) {
    const opcode = reader.buffer[0] & 0x0f;
    const lengthCode = reader.buffer[1] & 0x7f;
    const maskOffset = 2 + (lengthCode === 126 ? 2 : lengthCode === 127 ? 8 : 0);
    if (reader.buffer.length < maskOffset + 4) return;
    const length = lengthCode === 126
      ? reader.buffer.readUInt16BE(2)
      : lengthCode === 127 ? Number(reader.buffer.readBigUInt64BE(2)) : lengthCode;
    const payloadOffset = maskOffset + 4;
    if (reader.buffer.length < payloadOffset + length) return;
    const payload = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      payload[index] = reader.buffer[payloadOffset + index] ^ reader.buffer[maskOffset + (index % 4)];
    }
    reader.buffer = reader.buffer.subarray(payloadOffset + length);
    if (opcode === 0x8) {
      onClose();
      return;
    }
    if (opcode === 0x1) onText(payload.toString('utf8'));
  }
}

async function startMockCdp(configure: (origin: string) => MockCdpConfig): Promise<MockCdp> {
  const record: MockCdpRecord = { connectionPaths: [], tokensSent: [], frames: [] };
  const sockets = new Set<Duplex>();
  let config: MockCdpConfig = { lists: [], authTicket: 'valid' };
  let listRequests = 0;
  let port = 0;

  const server = createServer((request, response) => {
    if (request.url !== '/json') {
      response.writeHead(404).end();
      return;
    }
    const list = config.lists[Math.min(listRequests, config.lists.length - 1)] ?? [];
    listRequests += 1;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(list.map((tab) => ({
      id: tab.id,
      type: 'page',
      url: tab.url,
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${tab.id}`,
    }))));
  });
  server.on('connection', (socket) => { sockets.add(socket); });
  server.on('upgrade', (request, socket, head) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    record.connectionPaths.push(request.url ?? '');
    const key = String(request.headers['sec-websocket-key'] ?? '');
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const reader: FrameReader = { buffer: Buffer.alloc(0) };
    const onChunk = (chunk: Buffer): void => readClientFrames(
      reader,
      chunk,
      (text) => {
        record.frames.push(text);
        const message = JSON.parse(text) as CdpMessage;
        sendFrame(socket, { id: message.id, result: answerCdp(config, record, message) });
      },
      () => socket.end(),
    );
    socket.on('data', onChunk);
    if (head.length > 0) onChunk(head);
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  config = configure(origin);
  return {
    port,
    origin,
    record,
    close: () => new Promise<void>((resolveClose) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolveClose());
    }),
  };
}

function cdpEnv(cdp: MockCdp, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return helperEnv({ CDP_PORT: String(cdp.port), FLEET: cdp.origin, ...overrides });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'whatsoup-console-unlock-'));
  configDir = privateDir(join(home, '.config', 'whatsoup'));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('whatsoup-console-unlock.mjs token source', () => {
  // The wrapper hands over the login keychain token in WHATSOUP_CONSOLE_TOKEN,
  // as on main; the helper reads the file only when nothing was handed over.
  it('uses a token handed over in WHATSOUP_CONSOLE_TOKEN before the token file', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    const cdp = await startMockCdp((origin) => ({ lists: [[{ id: 'fleet', url: `${origin}/` }]], authTicket: 'locked' }));
    try {
      const result = await runHelperAsync(cdpEnv(cdp, { WHATSOUP_CONSOLE_TOKEN: ENV_TOKEN }));

      expect(result).toEqual({ status: 0, stdout: 'unlocked\n', stderr: '' });
      expect(cdp.record.tokensSent).toEqual([ENV_TOKEN]);
      expect(cdp.record.frames.join('\n')).not.toContain(FILE_TOKEN);
    } finally {
      await cdp.close();
    }
  });

  it('unlocks with a handed-over token when no token file exists', async () => {
    const cdp = await startMockCdp((origin) => ({ lists: [[{ id: 'fleet', url: `${origin}/` }]], authTicket: 'locked' }));
    try {
      const result = await runHelperAsync(cdpEnv(cdp, { WHATSOUP_CONSOLE_TOKEN: ENV_TOKEN }));

      expect(result).toEqual({ status: 0, stdout: 'unlocked\n', stderr: '' });
      expect(cdp.record.tokensSent).toEqual([ENV_TOKEN]);
    } finally {
      await cdp.close();
    }
  });

  it('reads the active token from the fleet-token file when no token is handed over', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    const cdp = await startMockCdp((origin) => ({ lists: [[{ id: 'fleet', url: `${origin}/` }]], authTicket: 'locked' }));
    try {
      const result = await runHelperAsync(cdpEnv(cdp));

      expect(result).toEqual({ status: 0, stdout: 'unlocked\n', stderr: '' });
      expect(cdp.record.tokensSent).toEqual([FILE_TOKEN]);
    } finally {
      await cdp.close();
    }
  });

  it('reads the file named by WHATSOUP_FLEET_TOKEN_FILE instead of the default file', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    const overrideFile = join(privateDir(join(home, 'override')), 'tokens.json');
    writeTokenFile(overrideFile, { active: OVERRIDE_TOKEN });
    const cdp = await startMockCdp((origin) => ({ lists: [[{ id: 'fleet', url: `${origin}/` }]], authTicket: 'locked' }));
    try {
      const result = await runHelperAsync(cdpEnv(cdp, { WHATSOUP_FLEET_TOKEN_FILE: overrideFile }));

      expect(result).toEqual({ status: 0, stdout: 'unlocked\n', stderr: '' });
      expect(cdp.record.tokensSent).toEqual([OVERRIDE_TOKEN]);
    } finally {
      await cdp.close();
    }
  });

});

// main refused only group or other permission bits on the file. The head keeps
// that, adds what blocks a real exposure or a hang (leaf symlink, non-regular
// file, another owner, a swapped file, an unbounded read), and checks nothing
// on the folder.
describe('whatsoup-console-unlock.mjs fleet-token file checks', () => {
  it('accepts a token file with mode 0600 or 0400 in a folder that group and others can open', () => {
    const tokenFile = join(configDir, 'fleet-tokens.json');
    chmodSync(configDir, 0o755);
    writeTokenFile(tokenFile);
    expectPastTokenRead(runHelper());

    chmodSync(tokenFile, 0o400);
    expectPastTokenRead(runHelper());
  });

  it('accepts a token file reached through a symlinked folder', () => {
    const realDir = privateDir(join(home, 'real-config'));
    writeTokenFile(join(realDir, 'fleet-tokens.json'));
    rmSync(configDir, { recursive: true });
    symlinkSync(realDir, configDir);

    expectPastTokenRead(runHelper());
  });

  it('reports a missing token file', () => {
    expectRefused(runHelper(), 'missing');
  });

  it('refuses a token file that group can read', () => {
    const tokenFile = join(configDir, 'fleet-tokens.json');
    writeTokenFile(tokenFile);
    expectPastTokenRead(runHelper());

    chmodSync(tokenFile, 0o640);
    expectRefused(runHelper(), 'mode');
  });

  it('refuses a token file that only others can read', () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'), { mode: 0o604 });

    expectRefused(runHelper(), 'mode');
  });

  it('refuses a token file reached through a symlink', () => {
    const target = join(configDir, 'tokens-target.json');
    writeTokenFile(target);
    expectPastTokenRead(runHelper({ WHATSOUP_FLEET_TOKEN_FILE: target }));

    symlinkSync(target, join(configDir, 'fleet-tokens.json'));
    expectRefused(runHelper(), 'symlink');
  });

  it('refuses a directory in place of the token file', () => {
    privateDir(join(configDir, 'fleet-tokens.json'));

    expectRefused(runHelper(), 'not-a-file');
  });

  it('refuses a FIFO in place of the token file without waiting for a writer', () => {
    const fifo = join(configDir, 'fleet-tokens.json');
    expect(spawnSync('mkfifo', ['-m', '600', fifo]).status).toBe(0);

    expectRefused(runHelper(), 'not-a-file');
  });

  it('accepts a token file at the size bound and refuses one byte more', () => {
    const tokenFile = join(configDir, 'fleet-tokens.json');
    writePaddedTokenFile(tokenFile, MAX_TOKEN_FILE_BYTES);
    expectPastTokenRead(runHelper());

    writePaddedTokenFile(tokenFile, MAX_TOKEN_FILE_BYTES + 1);
    expectRefused(runHelper(), 'too-large');
  });

  it('refuses a token file that the check before opening sees owned by another user', () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    expectPastTokenRead(runHelper({}, ['--import', statPreload('lstat-control', 'lstatSync', '')]));

    const otherOwner = statPreload('lstat-owner', 'lstatSync', "if (String(target).endsWith('fleet-tokens.json')) stat.uid += 1;");
    expectRefused(runHelper({}, ['--import', otherOwner]), 'owner');
  });

  it('refuses a token file that the check after opening sees owned by another user', () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    expectPastTokenRead(runHelper({}, ['--import', statPreload('fstat-control', 'fstatSync', '')]));

    expectRefused(runHelper({}, ['--import', statPreload('fstat-owner', 'fstatSync', 'stat.uid += 1;')]), 'owner');
  });

  it('refuses a token file whose opened inode differs from the checked one', () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));

    expectRefused(runHelper({}, ['--import', statPreload('fstat-inode', 'fstatSync', 'stat.ino += 1;')]), 'changed');
  });

  it('refuses a token file whose active token is not 64 lowercase hex characters', () => {
    const tokenFile = join(configDir, 'fleet-tokens.json');
    writeTokenFile(tokenFile);
    expectPastTokenRead(runHelper());

    writeTokenFile(tokenFile, { active: FILE_TOKEN.toUpperCase() });
    expectRefused(runHelper(), 'shape');
  });

  it('refuses a token file that is not JSON', () => {
    const tokenFile = join(configDir, 'fleet-tokens.json');
    writeFileSync(tokenFile, 'not json');
    chmodSync(tokenFile, 0o600);

    expectRefused(runHelper(), 'shape');
  });
});

describe('whatsoup-console-unlock.mjs fleet target', () => {
  it('refuses a FLEET URL whose host is not loopback before contacting CDP', () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));

    expect(runHelper({ FLEET: 'http://localhost.example.invalid:9227/agents' }))
      .toEqual({ status: 1, stdout: 'invalid-fleet-url\n', stderr: '' });
  });

  it('refuses a CDP_PORT that is not a port number', () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));

    // Spliced into http://localhost:<port>/json this would name another host.
    expect(runHelper({ CDP_PORT: '1@example.invalid' }))
      .toEqual({ status: 1, stdout: 'invalid-cdp-port\n', stderr: '' });
  });

  it('selects the tab on the exact fleet origin, not one whose URL only starts with the FLEET text', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    const cdp = await startMockCdp((origin) => ({
      lists: [[
        // Begins with the FLEET text, but its host is example.invalid (userinfo form).
        { id: 'lookalike', url: `${origin}@example.invalid/` },
        { id: 'fleet', url: `${origin}/` },
      ]],
      authTicket: 'valid',
    }));
    try {
      const result = await runHelperAsync(cdpEnv(cdp));

      expect(result).toEqual({ status: 0, stdout: 'already-valid\n', stderr: '' });
      expect(cdp.record.connectionPaths).toEqual(['/devtools/page/fleet']);
      expect(cdp.record.tokensSent).toEqual([]);
    } finally {
      await cdp.close();
    }
  });

  it('treats a FLEET path as a path boundary, not a text prefix', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    const cdp = await startMockCdp((origin) => ({
      lists: [[
        { id: 'lookalike', url: `${origin}/agents.example` },
        { id: 'fleet', url: `${origin}/agents` },
      ]],
      authTicket: 'valid',
    }));
    try {
      const result = await runHelperAsync(cdpEnv(cdp, { FLEET: `${cdp.origin}/agents` }));

      expect(result).toEqual({ status: 0, stdout: 'already-valid\n', stderr: '' });
      expect(cdp.record.connectionPaths).toEqual(['/devtools/page/fleet']);
      expect(cdp.record.tokensSent).toEqual([]);
    } finally {
      await cdp.close();
    }
  });

  it('withholds the token when CDP reports that the tab left the fleet target before the unlock', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    const cdp = await startMockCdp((origin) => ({
      // Selection and the check before the session probe see the fleet tab;
      // the check right before the unlock sees it on another site.
      lists: [
        [{ id: 'fleet', url: `${origin}/` }],
        [{ id: 'fleet', url: `${origin}/` }],
        [{ id: 'fleet', url: 'http://example.invalid/' }],
      ],
      authTicket: 'locked',
    }));
    try {
      const result = await runHelperAsync(cdpEnv(cdp));

      expect(result).toEqual({ status: 1, stdout: 'origin-mismatch\n', stderr: '' });
      expect(cdp.record.tokensSent).toEqual([]);
      expect(cdp.record.frames.join('\n')).not.toContain(FILE_TOKEN);
    } finally {
      await cdp.close();
    }
  });

  it('withholds the token when the live document left the fleet origin before the unlock', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    const cdp = await startMockCdp((origin) => ({
      lists: [[{ id: 'fleet', url: `${origin}/` }]],
      authTicket: 'locked',
      liveOriginMatches: false,
    }));
    try {
      const result = await runHelperAsync(cdpEnv(cdp));

      expect(result).toEqual({ status: 1, stdout: 'origin-mismatch\n', stderr: '' });
      expect(cdp.record.tokensSent).toEqual([]);
      expect(cdp.record.frames.join('\n')).not.toContain(FILE_TOKEN);
    } finally {
      await cdp.close();
    }
  });
});
