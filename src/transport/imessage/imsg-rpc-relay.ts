import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, rename, unlink } from 'node:fs/promises';
import net, { type Server, type Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import type { Readable, Writable } from 'node:stream';

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 103;
const PROVIDER_GRACE_MS = 250;
const PROVIDER_KILL_MS = 1_000;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PATTERN = /\b(\d+\.\d+\.\d+)\b/;
const ALLOWED_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'NODE_PATH',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'TMPDIR',
] as const;

interface SocketIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
}

interface RelaySession {
  readonly client: Socket;
  readonly child: ChildProcessWithoutNullStreams;
  readonly stopped: Promise<void>;
  stop(closeClient: boolean): void;
}

export interface ImsgRpcRelayOptions {
  readonly socketPath: string;
  readonly imsgBinary: string;
  readonly supportedVersions: readonly string[];
  readonly maxLineBytes?: number;
}

export interface ImsgRpcRelay {
  readonly ready: Promise<void>;
  readonly stopped: Promise<void>;
  close(): Promise<void>;
}

function allowedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function validateOptions(options: ImsgRpcRelayOptions): number {
  if (!isAbsolute(options.socketPath)) throw new Error('imsg relay socket path must be absolute');
  if (Buffer.byteLength(options.socketPath, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error('imsg relay socket path exceeds the UNIX socket path limit');
  }
  if (!isAbsolute(options.imsgBinary)) throw new Error('imsg binary path must be absolute');
  if (options.supportedVersions.length === 0
    || options.supportedVersions.some((version) => !/^\d+\.\d+\.\d+$/.test(version))) {
    throw new Error('imsg relay requires at least one exact supported version');
  }
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new Error('imsg relay maxLineBytes must be a positive safe integer');
  }
  return maxLineBytes;
}

async function verifyProviderVersion(options: ImsgRpcRelayOptions): Promise<void> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(options.imsgBinary, ['--version'], {
      encoding: 'utf8',
      env: allowedEnvironment(),
      maxBuffer: 64 * 1024,
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    }, (error, output) => {
      if (error) {
        reject(new Error('imsg version probe failed'));
        return;
      }
      resolve(output);
    });
  });
  const version = VERSION_PATTERN.exec(stdout)?.[1];
  if (version === undefined || !options.supportedVersions.includes(version)) {
    throw new Error(`unsupported imsg version${version === undefined ? '' : ` ${version}`}`);
  }
}

async function probeExistingSocket(socketPath: string): Promise<'active' | 'stale'> {
  return new Promise((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    let settled = false;
    const finish = (result: 'active' | 'stale'): void => {
      if (settled) return;
      settled = true;
      probe.destroy();
      resolve(result);
    };
    probe.once('connect', () => finish('active'));
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
        finish('stale');
        return;
      }
      if (!settled) {
        settled = true;
        reject(new Error(`cannot verify existing imsg relay socket (${error.code ?? 'unknown error'})`));
      }
    });
  });
}

async function prepareSocketPath(socketPath: string): Promise<void> {
  let existing;
  try {
    existing = await lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (existing.isSymbolicLink()) throw new Error('imsg relay socket path is a symbolic link');
  if (!existing.isSocket()) throw new Error('imsg relay socket path is not a socket');
  const expectedUid = process.getuid?.();
  if (expectedUid === undefined || existing.uid !== expectedUid) {
    throw new Error('imsg relay socket path is not owned by the current user');
  }
  if (await probeExistingSocket(socketPath) === 'active') {
    throw new Error('imsg relay socket path is already active');
  }
  const confirmed = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (confirmed === null) return;
  if (!confirmed.isSocket()
    || confirmed.dev !== existing.dev
    || confirmed.ino !== existing.ino
    || confirmed.uid !== existing.uid) {
    throw new Error('imsg relay socket path changed during stale-socket validation');
  }
  await unlink(socketPath);
}

async function unlinkOwnedSocket(socketPath: string, identity: SocketIdentity | null): Promise<void> {
  if (identity === null) return;
  const current = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (current === null) return;
  if (!current.isSocket()
    || current.dev !== identity.dev
    || current.ino !== identity.ino
    || current.uid !== identity.uid) return;
  await unlink(socketPath);
}

async function protectReplacementDuringClose(
  socketPath: string,
  identity: SocketIdentity | null,
): Promise<string | null> {
  if (identity === null) return null;
  const current = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (current === null) return null;
  if (current.isSocket()
    && current.dev === identity.dev
    && current.ino === identity.ino
    && current.uid === identity.uid) return null;
  const preservedPath = `${socketPath}.preserved-${randomUUID()}`;
  await rename(socketPath, preservedPath);
  return preservedPath;
}

async function restoreReplacement(socketPath: string, preservedPath: string | null): Promise<void> {
  if (preservedPath === null) return;
  const current = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (current !== null) {
    throw new Error('imsg relay socket path changed while restoring a preserved replacement');
  }
  await rename(preservedPath, socketPath);
}

function forwardBoundedLines(
  source: Readable,
  destination: Writable,
  maxLineBytes: number,
  onViolation: () => void,
): void {
  let lineBytes = 0;
  source.on('data', (raw: Buffer | string) => {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    for (const byte of chunk) {
      if (byte === 0x0a) {
        lineBytes = 0;
      } else {
        lineBytes += 1;
        if (lineBytes > maxLineBytes) {
          onViolation();
          return;
        }
      }
    }
    if (!destination.destroyed && !destination.write(chunk)) {
      source.pause();
      destination.once('drain', () => {
        if (!source.destroyed) source.resume();
      });
    }
  });
}

function createSession(
  client: Socket,
  options: ImsgRpcRelayOptions,
  maxLineBytes: number,
  onStopped: (session: RelaySession) => void,
): RelaySession {
  const child = spawn(options.imsgBinary, ['rpc'], {
    env: allowedEnvironment(),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.resume();

  let stopping = false;
  let finished = false;
  let termTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });

  const finalize = (): void => {
    if (finished) return;
    finished = true;
    if (termTimer !== undefined) clearTimeout(termTimer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (!client.destroyed) client.end();
    onStopped(session);
    resolveStopped();
  };

  const stop = (closeClient: boolean): void => {
    if (closeClient && !client.destroyed) client.destroy();
    if (stopping) return;
    stopping = true;
    child.stdin.end();
    termTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }, PROVIDER_GRACE_MS);
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      finalize();
    }, PROVIDER_KILL_MS);
  };

  const session: RelaySession = { client, child, stopped, stop };
  forwardBoundedLines(client, child.stdin, maxLineBytes, () => stop(true));
  forwardBoundedLines(child.stdout, client, maxLineBytes, () => stop(true));
  client.once('end', () => stop(false));
  client.once('error', () => stop(true));
  client.once('close', () => stop(false));
  child.once('error', () => {
    stop(true);
    finalize();
  });
  child.once('close', finalize);
  child.stdout.once('end', () => stop(false));
  return session;
}

export function startImsgRpcRelay(options: ImsgRpcRelayOptions): ImsgRpcRelay {
  const maxLineBytes = validateOptions(options);
  let closing = false;
  let server: Server | null = null;
  let activeSession: RelaySession | null = null;
  let socketIdentity: SocketIdentity | null = null;
  let closePromise: Promise<void> | null = null;
  let stoppedSettled = false;
  let resolveStopped: () => void = () => undefined;
  let rejectStopped: (error: Error) => void = () => undefined;
  const stopped = new Promise<void>((resolve, reject) => {
    resolveStopped = resolve;
    rejectStopped = reject;
  });
  void stopped.catch(() => undefined);

  const settleStopped = (error?: Error): void => {
    if (stoppedSettled) return;
    stoppedSettled = true;
    if (error === undefined) resolveStopped();
    else rejectStopped(error);
  };

  const shutdown = async (): Promise<void> => {
    const session = activeSession;
    session?.stop(true);
    const serverToClose = server;
    const preservedReplacement = await protectReplacementDuringClose(options.socketPath, socketIdentity);
    if (serverToClose !== null) {
      try {
        await new Promise<void>((resolve) => {
          if (!serverToClose.listening) {
            resolve();
            return;
          }
          serverToClose.close(() => resolve());
        });
      } finally {
        await restoreReplacement(options.socketPath, preservedReplacement);
      }
    } else {
      await restoreReplacement(options.socketPath, preservedReplacement);
    }
    if (session !== null) await session.stopped;
    await unlinkOwnedSocket(options.socketPath, socketIdentity);
  };

  const ready = (async () => {
    await verifyProviderVersion(options);
    if (closing) throw new Error('imsg relay closed during startup');
    await prepareSocketPath(options.socketPath);
    if (closing) throw new Error('imsg relay closed during startup');
    server = net.createServer({ allowHalfOpen: true }, (client) => {
      if (closing || activeSession !== null) {
        client.destroy();
        return;
      }
      const session = createSession(client, options, maxLineBytes, (stoppedSession) => {
        if (activeSession === stoppedSession) activeSession = null;
      });
      activeSession = session;
    });
    let startupServerError: Error | null = null;
    let onStartupServerError: ((error: Error) => void) | null = null;
    await new Promise<void>((resolve, reject) => {
      const currentServer = server;
      if (currentServer === null) {
        reject(new Error('imsg relay server initialization failed'));
        return;
      }
      onStartupServerError = (error: Error): void => {
        startupServerError = error;
        reject(error);
      };
      currentServer.once('error', onStartupServerError);
      currentServer.listen(options.socketPath, () => {
        resolve();
      });
    });
    await chmod(options.socketPath, 0o600);
    const stat = await lstat(options.socketPath);
    if (!stat.isSocket()) throw new Error('imsg relay failed to create a UNIX socket');
    socketIdentity = { dev: stat.dev, ino: stat.ino, uid: stat.uid };
    if (startupServerError !== null) throw startupServerError;
    const currentServer = server;
    if (currentServer === null || onStartupServerError === null) {
      throw new Error('imsg relay server initialization failed');
    }
    currentServer.off('error', onStartupServerError);
    currentServer.on('error', () => {
      if (closing) return;
      closing = true;
      const runtimeFailure = new Error('imsg relay server failed after startup');
      closePromise = (async () => {
        try {
          await shutdown();
        } finally {
          settleStopped(runtimeFailure);
        }
      })();
      void closePromise.catch(() => undefined);
    });
  })().catch(async (error: unknown) => {
    closing = true;
    try {
      await shutdown();
      settleStopped();
    } catch {
      settleStopped(new Error('imsg relay cleanup failed during startup'));
    }
    throw error;
  });

  return {
    ready,
    stopped,
    close(): Promise<void> {
      if (closePromise !== null) return closePromise;
      closing = true;
      closePromise = (async () => {
        await ready.catch(() => undefined);
        try {
          await shutdown();
          settleStopped();
        } catch (error) {
          settleStopped(new Error('imsg relay shutdown failed'));
          throw error;
        }
      })();
      void closePromise.catch(() => undefined);
      return closePromise;
    },
  };
}
