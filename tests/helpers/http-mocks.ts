import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { vi, type Mock } from 'vitest';

export interface MockReqOptions {
  body?: string;
  /** Emit each entry as its own 'data' event (e.g. to split a multibyte
   * character across chunk boundaries). Takes precedence over `body`. */
  chunks?: Array<Buffer | string>;
  headers?: Record<string, string>;
  method?: string;
  url?: string;
}

export type MockRes = ServerResponse & {
  _status: number;
  _headers: Record<string, string>;
  _body: string;
};

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K];
};

export interface CommonRouteDeps {
  discovery: {
    getInstance: Mock<(name: string) => unknown | undefined>;
    getInstances: Mock<() => Map<string, unknown>>;
  };
  realtime: {
    publish: Mock<(...args: unknown[]) => unknown>;
  };
  serviceManager: ReturnType<typeof mockServiceManager>;
}

export function mockReq({
  body = '',
  chunks,
  headers = {},
  method = 'GET',
  url = '/',
}: MockReqOptions = {}): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage;
  stream.headers = headers;
  stream.method = method;
  stream.url = url;
  process.nextTick(() => {
    const writable = stream as unknown as PassThrough;
    const parts = chunks ?? (body ? [body] : []);
    const writeNext = (index: number): void => {
      writable.write(parts[index]!);
      if (index + 1 >= parts.length) {
        writable.end();
      } else {
        setImmediate(() => writeNext(index + 1));
      }
    };
    if (parts.length === 0) {
      writable.end();
    } else {
      writeNext(0);
    }
  });
  return stream;
}

export function mockRes(): MockRes {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _body: '',
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      res._headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
      return res;
    },
    end(data?: string | Buffer) {
      if (data) res._body += data.toString();
      return res;
    },
    // ServerResponse is an EventEmitter; createSSEWriter (src/fleet/sse-helpers.ts)
    // attaches an 'error' listener (#2292 L7), so a fake without `on` is an
    // incomplete fake for any consumer that constructs an SSE writer around it.
    on() {
      return res;
    },
  };
  return res as unknown as MockRes;
}

export type MockSseRes = ServerResponse & { _status: number; _chunks: string[]; _ended: boolean };

export function mockSseRes(): MockSseRes {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _chunks: [] as string[],
    _ended: false,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      res._headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
      return res;
    },
    write(chunk: string) {
      res._chunks.push(chunk);
      return true;
    },
    end(data?: string) {
      if (data) res._chunks.push(data);
      res._ended = true;
      return res;
    },
    // ServerResponse is an EventEmitter; createSSEWriter (src/fleet/sse-helpers.ts)
    // attaches an 'error' listener (#2292 L7), so a fake without `on` is an
    // incomplete fake for any consumer that constructs an SSE writer around it.
    on() {
      return res;
    },
  };
  return res as unknown as MockSseRes;
}

function mockServiceManager() {
  return {
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    startFire: vi.fn(),
  };
}

export function makeDeps(): CommonRouteDeps;
export function makeDeps<T extends object>(overrides: DeepPartial<T>): CommonRouteDeps & T;
export function makeDeps<T extends object>(overrides: DeepPartial<T> = {}): CommonRouteDeps & T {
  const base: CommonRouteDeps = {
    discovery: {
      getInstance: vi.fn<(name: string) => unknown | undefined>(() => undefined),
      getInstances: vi.fn<() => Map<string, unknown>>(() => new Map()),
    },
    realtime: { publish: vi.fn<(...args: unknown[]) => unknown>() },
    serviceManager: mockServiceManager(),
  };
  const typedOverrides = overrides as DeepPartial<CommonRouteDeps>;

  return {
    ...base,
    ...overrides,
    discovery: { ...base.discovery, ...typedOverrides.discovery },
    realtime: { ...base.realtime, ...typedOverrides.realtime },
    serviceManager: { ...base.serviceManager, ...typedOverrides.serviceManager },
  } as unknown as CommonRouteDeps & T;
}
