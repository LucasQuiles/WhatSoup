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
import { createContext, runInContext, type Context } from 'node:vm';

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

// The helper's size bound, a guard against a wrong file; a real token file is
// under 1 KiB. The round before set 64 KiB, which main did not have.
const MAX_TOKEN_FILE_BYTES = 1024 * 1024;
const EARLIER_BOUND_BYTES = 64 * 1024;

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

function runHelperAsync(env: NodeJS.ProcessEnv, nodeArgs: string[] = []): Promise<HelperRun> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [...nodeArgs, HELPER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

// --- CDP stand-in: GET /json, PUT /json/new and one WebSocket per page target.
// It keeps the tab's live document and runs every Runtime.evaluate expression
// and the unlock function in a node:vm context made from that document as it
// is at that moment, with a fetch that records each page request. A test can
// move the document at a chosen step, as a navigation the helper did not
// cause would. ---

interface CdpTab {
  id: string;
  url: string;
}

interface MockCdpConfig {
  /** Answers to GET /json, in request order; the last answer repeats. */
  lists: CdpTab[][];
  /** Answer of the page's own POST /api/auth-ticket probe. */
  authTicket: 'valid' | 'locked';
  /** Live document when the helper connects; default: the connected tab's URL. */
  liveUrl?: string;
  /** The live document moves to settleUrl after this many expression evaluations. */
  settleAfter?: number;
  settleUrl?: string;
  /** The live document moves here right after the session probe is answered. */
  moveAfterProbe?: string;
  /** The live document moves here when the helper asks for the window object, before that call is evaluated. */
  moveOnWindow?: string;
  /** The live document moves here right after the window object is answered, before the unlock call. */
  moveAfterWindow?: string;
  /** The page's unlock request rejects with this text. */
  unlockFetchError?: string;
  /** The unlock call throws in the page with this text. */
  unlockException?: string;
}

interface PageRequest {
  /** The URL exactly as the page code passed it to fetch. */
  url: string;
  path: string;
  method: string;
  authorization: string | null;
  mode: string | null;
  /** The live document the request was made from. */
  documentUrl: string;
}

interface MockCdpRecord {
  /** WebSocket paths the helper connected to, in order. */
  connectionPaths: string[];
  /** First argument of every Runtime.callFunctionOn (the unlock call). */
  tokensSent: unknown[];
  /** First argument of each unlock call that ran in a document. */
  tokensDelivered: unknown[];
  /** Every text frame the helper sent. */
  frames: string[];
  /** Every fetch the page made. */
  requests: PageRequest[];
  /** URLs the helper asked PUT /json/new to open. */
  newTabs: string[];
  /** URLs passed to Page.navigate. */
  navigations: string[];
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
  params?: {
    expression?: string;
    url?: string;
    returnByValue?: boolean;
    objectId?: string;
    functionDeclaration?: string;
    arguments?: Array<{ value?: unknown }>;
  };
}

interface LiveDocument {
  url: string;
  /** Raised on every move; the window object id names it. */
  generation: number;
  evaluations: number;
  moves: Set<string>;
}

type CdpAnswer = { result: unknown } | { error: { code: number; message: string } };

interface PageFetchInit {
  method?: string;
  headers?: Record<string, string>;
  mode?: string;
}

// The page's `window` inside the vm context; an evaluation that yields it is
// answered with an object id, as CDP answers a remote object.
const PAGE_WINDOW = Object.freeze({ pageWindow: true });

function pageContext(live: LiveDocument, config: MockCdpConfig, record: MockCdpRecord): Context {
  const documentUrl = live.url;
  const location = new URL(documentUrl);
  const pageFetch = (input: unknown, init: PageFetchInit = {}): Promise<{ ok: boolean; status: number }> => {
    let path: string;
    try {
      path = new URL(String(input), documentUrl).pathname;
    } catch {
      return Promise.reject(new Error('bad request URL'));
    }
    record.requests.push({
      url: String(input),
      path,
      method: init.method ?? 'GET',
      authorization: init.headers?.Authorization ?? null,
      mode: init.mode ?? null,
      documentUrl,
    });
    if (path === '/api/auth-ticket') {
      return Promise.resolve(config.authTicket === 'valid' ? { ok: true, status: 200 } : { ok: false, status: 401 });
    }
    if (config.unlockFetchError) return Promise.reject(new Error(config.unlockFetchError));
    return Promise.resolve({ ok: true, status: 200 });
  };
  return createContext({
    location: { origin: location.origin, href: location.href, pathname: location.pathname },
    document: { readyState: 'complete' },
    fetch: pageFetch,
    window: PAGE_WINDOW,
  });
}

function moveOnce(live: LiveDocument, key: string, url: string | undefined): void {
  if (url === undefined || live.moves.has(key)) return;
  live.moves.add(key);
  live.url = url;
  live.generation += 1;
}

async function answerCdp(live: LiveDocument, config: MockCdpConfig, record: MockCdpRecord, message: CdpMessage): Promise<CdpAnswer> {
  const params = message.params ?? {};
  if (message.method === 'Page.navigate') {
    record.navigations.push(String(params.url));
    live.url = String(params.url);
    live.generation += 1;
    return { result: {} };
  }
  if (message.method === 'Runtime.callFunctionOn') {
    const values = (params.arguments ?? []).map((argument) => argument.value);
    record.tokensSent.push(values[0]);
    // As in a browser, a window object of an earlier document is gone, so the
    // call fails and no document receives its arguments.
    if (params.objectId !== `window-${live.generation}`) {
      return { error: { code: -32000, message: 'Cannot find context with specified id' } };
    }
    record.tokensDelivered.push(values[0]);
    if (config.unlockException) {
      const text = config.unlockException;
      return { result: { result: { type: 'object' }, exceptionDetails: { text, exception: { description: text } } } };
    }
    const context = pageContext(live, config, record);
    const unlock = runInContext(`(${params.functionDeclaration ?? ''})`, context) as (...args: unknown[]) => unknown;
    return { result: { result: { value: await unlock.apply(context, values) } } };
  }
  if (message.method !== 'Runtime.evaluate') return { result: {} };
  const expression = params.expression ?? '';
  if (params.returnByValue !== true) {
    // The window lookup, evaluated in the live document like any expression.
    // A navigation can commit right before it (moveOnWindow) or right after
    // its answer (moveAfterWindow).
    moveOnce(live, 'window', config.moveOnWindow);
    let found: unknown;
    try {
      found = runInContext(expression, pageContext(live, config, record));
    } catch (error) {
      return { result: { result: { type: 'undefined' }, exceptionDetails: { text: String(error) } } };
    }
    const answer = found === PAGE_WINDOW
      ? { type: 'object', objectId: `window-${live.generation}` }
      : found === null ? { type: 'object', subtype: 'null', value: null } : { type: typeof found, value: found };
    moveOnce(live, 'after-window', config.moveAfterWindow);
    return { result: { result: answer } };
  }
  live.evaluations += 1;
  if (live.evaluations > (config.settleAfter ?? 0)) moveOnce(live, 'settle', config.settleUrl);
  let value: unknown;
  try {
    value = await runInContext(expression, pageContext(live, config, record));
  } catch (error) {
    return { result: { result: { type: 'undefined' }, exceptionDetails: { text: String(error) } } };
  }
  if (expression.includes('/api/auth-ticket')) moveOnce(live, 'probe', config.moveAfterProbe);
  return { result: { result: { value } } };
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
  const record: MockCdpRecord = {
    connectionPaths: [],
    tokensSent: [],
    tokensDelivered: [],
    frames: [],
    requests: [],
    newTabs: [],
    navigations: [],
  };
  const sockets = new Set<Duplex>();
  const tabUrls = new Map<string, string>();
  const live: LiveDocument = { url: 'about:blank', generation: 0, evaluations: 0, moves: new Set() };
  let config: MockCdpConfig = { lists: [], authTicket: 'valid' };
  let listRequests = 0;
  let port = 0;
  const tabJson = (tab: CdpTab) => ({
    id: tab.id,
    type: 'page',
    url: tab.url,
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${tab.id}`,
  });

  const server = createServer((request, response) => {
    const url = request.url ?? '';
    if (url.startsWith('/json/new?')) {
      // A new tab reports about:blank until the helper navigates it.
      record.newTabs.push(decodeURIComponent(url.slice('/json/new?'.length)));
      tabUrls.set('new', 'about:blank');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(tabJson({ id: 'new', url: 'about:blank' })));
      return;
    }
    if (url !== '/json') {
      response.writeHead(404).end();
      return;
    }
    const list = config.lists[Math.min(listRequests, config.lists.length - 1)] ?? [];
    listRequests += 1;
    for (const tab of list) if (!tabUrls.has(tab.id)) tabUrls.set(tab.id, tab.url);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(list.map(tabJson)));
  });
  server.on('connection', (socket) => { sockets.add(socket); });
  server.on('upgrade', (request, socket, head) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    record.connectionPaths.push(request.url ?? '');
    live.url = config.liveUrl ?? tabUrls.get((request.url ?? '').split('/').pop() ?? '') ?? 'about:blank';
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
        void answerCdp(live, config, record, message).then((answer) => sendFrame(socket, { id: message.id, ...answer }));
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

function unlockRequests(cdp: MockCdp): PageRequest[] {
  return cdp.record.requests.filter((request) => request.path === '/api/console-session');
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
// that, adds what blocks a misdirected read or a hang (leaf symlink,
// non-regular file, a file swapped twice, a read past 1 MiB), and checks
// neither the owner nor the folder.
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

  it('accepts a token file over the earlier 64 KiB bound, up to 1 MiB, and refuses one byte more', () => {
    const tokenFile = join(configDir, 'fleet-tokens.json');
    writePaddedTokenFile(tokenFile, EARLIER_BOUND_BYTES + 1);
    expectPastTokenRead(runHelper());

    writePaddedTokenFile(tokenFile, MAX_TOKEN_FILE_BYTES);
    expectPastTokenRead(runHelper());

    writePaddedTokenFile(tokenFile, MAX_TOKEN_FILE_BYTES + 1);
    expectRefused(runHelper(), 'too-large');
  });

  it('accepts a private token file owned by another user, before and after the open, as main did', () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));

    const otherOwnerBefore = statPreload('lstat-owner', 'lstatSync', "if (String(target).endsWith('fleet-tokens.json')) stat.uid += 1;");
    expectPastTokenRead(runHelper({}, ['--import', otherOwnerBefore]));
    expectPastTokenRead(runHelper({}, ['--import', statPreload('fstat-owner', 'fstatSync', 'stat.uid += 1;')]));
  });

  it('reads a token file replaced between the check and the open once more, as an atomic rotation does', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    // Only the first opened descriptor shows another inode: the file was
    // renamed over between the lstat and the open, then stays put.
    const swapOnce = statPreload('fstat-swap-once', 'fstatSync', 'if (!globalThis.swapSeen) { globalThis.swapSeen = true; stat.ino += 1; }');
    const cdp = await startMockCdp((origin) => ({ lists: [[{ id: 'fleet', url: `${origin}/` }]], authTicket: 'locked' }));
    try {
      const result = await runHelperAsync(cdpEnv(cdp), ['--import', swapOnce]);

      expect(result).toEqual({ status: 0, stdout: 'unlocked\n', stderr: '' });
      expect(cdp.record.tokensSent).toEqual([FILE_TOKEN]);
    } finally {
      await cdp.close();
    }
  });

  it('refuses a token file whose opened inode differs from the checked one on the second read too', () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    expectPastTokenRead(runHelper({}, ['--import', statPreload('fstat-control', 'fstatSync', '')]));

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
  it('accepts an https FLEET on a configured remote host and plain http on any loopback address', () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));

    for (const fleetUrl of [
      'https://console.example.invalid',
      'https://console.example.invalid:8443/agents/',
      'http://127.0.0.2:9227',
      'http://[::1]:9227',
      'http://localhost.:9227',
      // IPv4-mapped loopback literals; the URL parser writes them as [::ffff:7f00:1].
      'http://[::ffff:127.0.0.1]:9227',
      'http://[0:0:0:0:0:ffff:7f00:2]:9227',
    ]) {
      expectPastTokenRead(runHelper({ FLEET: fleetUrl }));
    }
  });

  it('refuses a plain-http FLEET on a host that is not a loopback address, names the fix and contacts no CDP', () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));

    // The helper looks up no names: a host name that may resolve to loopback
    // is refused as well, and the operator writes a loopback address instead.
    for (const fleetUrl of [
      'http://localhost.example.invalid:9227/agents',
      'http://console.localhost:9227',
      'http://[::ffff:192.0.2.10]:9227',
    ]) {
      expect(runHelper({ FLEET: fleetUrl }))
        .toEqual({ status: 1, stdout: 'insecure-fleet-url: use https, or a loopback address\n', stderr: '' });
    }
  });

  it('refuses a FLEET that is not an http or https URL', () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));

    for (const fleetUrl of ['not a url', 'file:///fleet', 'data:text/html,fleet']) {
      expect(runHelper({ FLEET: fleetUrl })).toEqual({ status: 1, stdout: 'invalid-fleet-url\n', stderr: '' });
    }
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

  it('withholds the token from a document that left the fleet origin after the session probe', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    const cdp = await startMockCdp((origin) => ({
      lists: [[{ id: 'fleet', url: `${origin}/` }]],
      authTicket: 'locked',
      moveAfterProbe: 'http://example.invalid/',
    }));
    try {
      const result = await runHelperAsync(cdpEnv(cdp));

      expect(result).toEqual({ status: 1, stdout: 'origin-mismatch\n', stderr: '' });
      // The check before the unlock call stops it: the token never reaches the page.
      expect(cdp.record.tokensSent).toEqual([]);
      expect(cdp.record.frames.join('\n')).not.toContain(FILE_TOKEN);
    } finally {
      await cdp.close();
    }
  });

  it('opens and navigates a new tab to the FLEET path with one trailing slash', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    for (const fleetPath of ['/agents', '/agents/']) {
      const cdp = await startMockCdp((origin) => ({
        // No tab is open; once the helper opens one, CDP lists it on the target.
        lists: [[], [{ id: 'new', url: `${origin}/agents/` }]],
        authTicket: 'locked',
      }));
      try {
        const result = await runHelperAsync(cdpEnv(cdp, { FLEET: `${cdp.origin}${fleetPath}` }));

        expect(result).toEqual({ status: 0, stdout: 'unlocked\n', stderr: '' });
        expect(cdp.record.newTabs).toEqual([`${cdp.origin}/agents/`]);
        expect(cdp.record.navigations).toEqual([`${cdp.origin}/agents/`]);
        expect(cdp.record.connectionPaths).toEqual(['/devtools/page/new']);
        expect(cdp.record.tokensSent).toEqual([FILE_TOKEN]);
      } finally {
        await cdp.close();
      }
    }
  });

  it('waits until the live document is on the FLEET path, not only on the fleet origin', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    const cdp = await startMockCdp((origin) => ({
      // CDP already reports the target while an earlier page of the same origin is live.
      lists: [[{ id: 'fleet', url: `${origin}/agents` }]],
      authTicket: 'locked',
      liveUrl: `${origin}/other`,
      settleAfter: 4,
      settleUrl: `${origin}/agents/`,
    }));
    try {
      const result = await runHelperAsync(cdpEnv(cdp, { FLEET: `${cdp.origin}/agents` }));

      expect(result).toEqual({ status: 0, stdout: 'unlocked\n', stderr: '' });
      expect(unlockRequests(cdp).map((request) => request.documentUrl)).toEqual([`${cdp.origin}/agents/`]);
    } finally {
      await cdp.close();
    }
  });

  it('accepts a console that the FLEET path redirects to on the same origin, as main did', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    const cdp = await startMockCdp((origin) => ({
      // No tab is open. The new tab's FLEET page redirects on the same origin
      // to a path that begins with the FLEET path text, and CDP then lists it there.
      lists: [[], [{ id: 'new', url: `${origin}/agents-v2/` }]],
      authTicket: 'locked',
      settleUrl: `${origin}/agents-v2/`,
    }));
    try {
      const result = await runHelperAsync(cdpEnv(cdp, { FLEET: `${cdp.origin}/agents` }));

      expect(result).toEqual({ status: 0, stdout: 'unlocked\n', stderr: '' });
      expect(cdp.record.navigations).toEqual([`${cdp.origin}/agents/`]);
      expect(unlockRequests(cdp).map((request) => request.documentUrl)).toEqual([`${cdp.origin}/agents-v2/`]);
      expect(unlockRequests(cdp).map((request) => request.url)).toEqual([`${cdp.origin}/api/console-session`]);
    } finally {
      await cdp.close();
    }
  });
});

describe('whatsoup-console-unlock.mjs unlock call', () => {
  const PAGE_TEXT = 'page-error-canary';

  it('sends the unlock request to the absolute fleet endpoint in same-origin mode', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    const cdp = await startMockCdp((origin) => ({ lists: [[{ id: 'fleet', url: `${origin}/agents/` }]], authTicket: 'locked' }));
    try {
      const result = await runHelperAsync(cdpEnv(cdp, { FLEET: `${cdp.origin}/agents` }));

      expect(result).toEqual({ status: 0, stdout: 'unlocked\n', stderr: '' });
      expect(unlockRequests(cdp)).toEqual([{
        url: `${cdp.origin}/api/console-session`,
        path: '/api/console-session',
        method: 'POST',
        authorization: `Bearer ${FILE_TOKEN}`,
        mode: 'same-origin',
        documentUrl: `${cdp.origin}/agents/`,
      }]);
    } finally {
      await cdp.close();
    }
  });

  it('sends the token in no frame when the document changes before the window lookup', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    const cdp = await startMockCdp((origin) => ({
      lists: [[{ id: 'fleet', url: `${origin}/` }]],
      authTicket: 'locked',
      // A navigation commits after the last tab check, before the helper asks for window.
      moveOnWindow: 'http://example.invalid/',
    }));
    try {
      const result = await runHelperAsync(cdpEnv(cdp));

      // The window lookup itself checks the origin and carries no token.
      expect(result).toEqual({ status: 1, stdout: 'origin-mismatch\n', stderr: '' });
      expect(cdp.record.tokensSent).toEqual([]);
      expect(cdp.record.frames.join('\n')).not.toContain(FILE_TOKEN);
      expect(unlockRequests(cdp)).toEqual([]);
    } finally {
      await cdp.close();
    }
  });

  it('fails the unlock call, and no document receives the token, when a navigation commits after the window lookup', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    const cdp = await startMockCdp((origin) => ({
      lists: [[{ id: 'fleet', url: `${origin}/` }]],
      authTicket: 'locked',
      moveAfterWindow: 'http://example.invalid/',
    }));
    try {
      const result = await runHelperAsync(cdpEnv(cdp));

      // The call names the checked document's window object, which is gone.
      expect(result).toEqual({ status: 1, stdout: 'err:empty-cdp-result\n', stderr: '' });
      expect(cdp.record.tokensDelivered).toEqual([]);
      expect(unlockRequests(cdp)).toEqual([]);
    } finally {
      await cdp.close();
    }
  });

  it('prints a fixed outcome, not the page error text, when the unlock request fails', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    const cdp = await startMockCdp((origin) => ({
      lists: [[{ id: 'fleet', url: `${origin}/` }]],
      authTicket: 'locked',
      unlockFetchError: PAGE_TEXT,
    }));
    try {
      expect(await runHelperAsync(cdpEnv(cdp))).toEqual({ status: 1, stdout: 'unlock-exc\n', stderr: '' });
    } finally {
      await cdp.close();
    }
  });

  it('prints a fixed outcome, not the page exception text, when the unlock call throws', async () => {
    writeTokenFile(join(configDir, 'fleet-tokens.json'));
    const cdp = await startMockCdp((origin) => ({
      lists: [[{ id: 'fleet', url: `${origin}/` }]],
      authTicket: 'locked',
      unlockException: PAGE_TEXT,
    }));
    try {
      expect(await runHelperAsync(cdpEnv(cdp))).toEqual({ status: 1, stdout: 'err:unlock-exception\n', stderr: '' });
    } finally {
      await cdp.close();
    }
  });
});
