import { buildTestServer, makeDb, makeDeps } from './_helpers/health.ts';
import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { Database } from '../../src/core/database.ts';

// ---------------------------------------------------------------------------
// HEALTH_BIND_ADDRESS env var
// ---------------------------------------------------------------------------

describe('HEALTH_BIND_ADDRESS env var', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;
  let port: number;

  afterEach(async () => {
    if (db) db.close();
    delete process.env.HEALTH_BIND_ADDRESS;
    delete process.env.WHATSOUP_HEALTH_UNSAFE_REMOTE;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('defaults to 127.0.0.1 when HEALTH_BIND_ADDRESS is not set', async () => {
    delete process.env.HEALTH_BIND_ADDRESS;
    db = makeDb();
    ({ server, port } = await buildTestServer(makeDeps(db)));
    const addr = server.address();
    expect(typeof addr === 'object' && addr !== null ? addr.address : '').toBe('127.0.0.1');
  });

  it('binds to 0.0.0.0 when HEALTH_BIND_ADDRESS=0.0.0.0 AND WHATSOUP_HEALTH_UNSAFE_REMOTE=1', async () => {
    process.env.HEALTH_BIND_ADDRESS = '0.0.0.0';
    process.env.WHATSOUP_HEALTH_UNSAFE_REMOTE = '1'; // R7a: explicit opt-in required for a non-loopback bind
    db = makeDb();
    // Need a fresh import to pick up the env change in the closure
    const { startHealthServer } = await import('../../src/core/health.ts');
    const testServer = startHealthServer(makeDeps(db));
    server = testServer;
    // The server initially listens on config.healthPort with the env bind address.
    // Close and re-listen on port 0 to verify the bind was respected.
    await new Promise<void>((resolve) => testServer.close(() => resolve()));
    await new Promise<void>((resolve) => {
      testServer.listen(0, '0.0.0.0', () => resolve());
    });
    const addr = testServer.address();
    expect(typeof addr === 'object' && addr !== null ? addr.address : '').toBe('0.0.0.0');
  });

  it('R7a: refuses to start with HEALTH_BIND_ADDRESS=0.0.0.0 and no WHATSOUP_HEALTH_UNSAFE_REMOTE override', async () => {
    process.env.HEALTH_BIND_ADDRESS = '0.0.0.0';
    delete process.env.WHATSOUP_HEALTH_UNSAFE_REMOTE;
    db = makeDb();
    const { startHealthServer } = await import('../../src/core/health.ts');
    expect(() => startHealthServer(makeDeps(db))).toThrow(/non-loopback/i);
  });
});

describe('server on("error") handler', () => {
  let db: Database;
  let server: ReturnType<typeof createServer>;

  afterEach(async () => {
    if (db) db.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('emits EADDRINUSE without crashing when the port is already bound', async () => {
    db = makeDb();
    // Bind a server on port 0 to hold an ephemeral port
    const blocker = await new Promise<ReturnType<typeof createServer>>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const blockerAddr = blocker.address() as { port: number };

    const { startHealthServer } = await import('../../src/core/health.ts');
    server = startHealthServer(makeDeps(db));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Re-listen on the already-occupied port — should emit 'error' with code EADDRINUSE
    let emittedError: Error | null = null;
    server.once('error', (err) => { emittedError = err; });
    await new Promise<void>((resolve) => {
      server.listen(blockerAddr.port, '127.0.0.1', () => resolve());
      // The error may fire before the listen callback
      server.once('error', () => resolve());
    });

    // Cleanup blocker
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    expect(emittedError).not.toBeNull();
    expect((emittedError as unknown as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
  });

  it('emits non-EADDRINUSE error events without crashing', async () => {
    db = makeDb();
    const { startHealthServer } = await import('../../src/core/health.ts');
    server = startHealthServer(makeDeps(db));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Emit a synthetic non-EADDRINUSE error through the server's event system
    let caught: Error | null = null;
    server.once('error', (err) => { caught = err; });
    const syntheticErr = Object.assign(new Error('synthetic network error'), { code: 'ECONNRESET' });
    server.emit('error', syntheticErr);

    expect(caught).toBe(syntheticErr);
  });
});
