import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';

export interface MockReqOptions {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
  url?: string;
}

export type MockRes = ServerResponse & {
  _status: number;
  _headers: Record<string, string>;
  _body: string;
};

export function mockReq({
  body = '',
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
    if (body) writable.write(body);
    writable.end();
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
  };
  return res as unknown as MockRes;
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

export function makeDeps<T extends Record<string, unknown> = Record<string, unknown>>(overrides: Partial<T> = {}): T {
  const base = {
    discovery: {
      getInstance: vi.fn(() => undefined),
      getInstances: vi.fn(() => new Map()),
    },
    realtime: { publish: vi.fn() },
    serviceManager: mockServiceManager(),
  };
  const typedOverrides = overrides as {
    discovery?: Record<string, unknown>;
    realtime?: Record<string, unknown>;
    serviceManager?: Record<string, unknown>;
  };

  return {
    ...base,
    ...overrides,
    discovery: { ...base.discovery, ...typedOverrides.discovery },
    realtime: { ...base.realtime, ...typedOverrides.realtime },
    serviceManager: { ...base.serviceManager, ...typedOverrides.serviceManager },
  } as T;
}
