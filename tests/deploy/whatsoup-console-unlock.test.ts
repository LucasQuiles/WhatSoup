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
// prints "no-fleet-token" before any request.
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

function expectRefused(result: HelperRun): void {
  expect(result).toEqual({ status: 1, stdout: 'no-fleet-token\n', stderr: '' });
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

describe('whatsoup-console-unlock.mjs fleet-token file', () => {
  it('reads the active token from the private fleet-token file and sends only that token to the page', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    const cdp = await startMockCdp((origin) => ({ lists: [[{ id: 'fleet', url: `${origin}/` }]], authTicket: 'locked' }));
    try {
      // A token in the environment is not a token source any more.
      const result = await runHelperAsync(cdpEnv(cdp, { WHATSOUP_CONSOLE_TOKEN: ENV_TOKEN }));

      expect(result).toEqual({ status: 0, stdout: 'unlocked\n', stderr: '' });
      expect(cdp.record.tokensSent).toEqual([FILE_TOKEN]);
      expect(cdp.record.frames.join('\n')).not.toContain(ENV_TOKEN);
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

  it('refuses a token file that group or others can read', () => {
    const tokenFile = join(configDir, 'fleet-tokens.json');
    writeTokenFile(tokenFile);
    expectPastTokenRead(runHelper());

    chmodSync(tokenFile, 0o640);
    expectRefused(runHelper());
  });

  it('refuses a token file reached through a symlink', () => {
    const target = join(configDir, 'tokens-target.json');
    writeTokenFile(target);
    expectPastTokenRead(runHelper({ WHATSOUP_FLEET_TOKEN_FILE: target }));

    symlinkSync(target, join(configDir, 'fleet-tokens.json'));
    expectRefused(runHelper());
  });

  it('refuses a token folder that group or others can open', () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    expectPastTokenRead(runHelper());

    chmodSync(configDir, 0o755);
    expectRefused(runHelper());
  });

  it('refuses a token folder reached through a symlink', () => {
    const realDir = privateDir(join(home, 'real-config'));
    writeTokenFile(join(realDir, 'fleet-tokens.json'));
    expectPastTokenRead(runHelper({ WHATSOUP_FLEET_TOKEN_FILE: join(realDir, 'fleet-tokens.json') }));

    rmSync(configDir, { recursive: true });
    symlinkSync(realDir, configDir);
    expectRefused(runHelper());
  });

  it('refuses a token file and folder owned by another user', () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    // The test can only create files it owns, so a preload makes the helper
    // see another uid. The control preload keeps the real uid and shows that
    // the preload alone changes nothing.
    const sameUid = join(home, 'uid-same.mjs');
    const otherUid = join(home, 'uid-other.mjs');
    writeFileSync(sameUid, 'const realUid = process.getuid();\nprocess.getuid = () => realUid;\n');
    writeFileSync(otherUid, 'const realUid = process.getuid();\nprocess.getuid = () => realUid + 1;\n');

    expectPastTokenRead(runHelper({}, ['--import', pathToFileURL(sameUid).href]));
    expectRefused(runHelper({}, ['--import', pathToFileURL(otherUid).href]));
  });

  it('refuses a token file whose active token is not 64 lowercase hex characters', () => {
    const tokenFile = join(configDir, 'fleet-tokens.json');
    writeTokenFile(tokenFile);
    expectPastTokenRead(runHelper());

    writeTokenFile(tokenFile, { active: FILE_TOKEN.toUpperCase() });
    expectRefused(runHelper());
  });
});
