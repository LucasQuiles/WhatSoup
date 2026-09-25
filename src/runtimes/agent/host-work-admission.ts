import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isNonEmptyString } from '../../lib/type-guards.ts';

const MAX_ADMISSION_RECORD_BYTES = 8 * 1024;

export class HostWorkAdmissionError extends Error {
  constructor() {
    super('Host work admission rejected before provider start');
    this.name = 'HostWorkAdmissionError';
  }
}

/** The wrapper may still own a descendant; callers must retain its admission lane. */
export class HostWorkAdmissionCleanupError extends Error {
  constructor(cause: unknown) {
    super('Host work admission cleanup could not be proved', { cause });
    this.name = 'HostWorkAdmissionCleanupError';
  }
}

export interface HostWorkAdmissionOptions {
  binary: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Existing provider-canary digest, rechecked by the host gate immediately before exec. */
  expectedExecutableSha256?: string;
  signal?: AbortSignal;
  onSpawned?: (child: ChildProcess) => void;
  onAbort: (child: ChildProcess) => Promise<void>;
}

/** Admission is deliberately opt-in so non-systemd and non-Linux hosts retain direct spawn. */
export function isHostWorkAdmissionEnabled(
  // env-allowed: default param passes env into the pure opt-in predicate at the call boundary
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'linux' && env.WHATSOUP_WORK_ADMISSION === 'systemd';
}

function hostWorkAdmissionHelper(): string | null {
  // env-allowed: host-owned helper path read late so the opt-in stays inert unless set
  const helper = process.env.WHATSOUP_WORK_ADMISSION_HELPER;
  if (!helper || !isAbsolute(helper)) return null;
  try {
    const metadata = statSync(helper);
    return metadata.isFile() && (metadata.mode & 0o111) !== 0 ? helper : null;
  } catch {
    return null;
  }
}

function hostRuntimeEnvironment(): { runtimeDir: string; sessionBus: string } | null {
  try {
    const uid = userInfo().uid;
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 0) return null;
    const runtimeDir = `/run/user/${uid}`;
    return { runtimeDir, sessionBus: `unix:path=${runtimeDir}/bus` };
  } catch {
    return null;
  }
}

function validAdmissionRecord(line: string): boolean {
  try {
    const record: unknown = JSON.parse(line);
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    const value = record as Record<string, unknown>;
    const keys = Object.keys(value).sort();
    return value.state === 'admitted'
      && isNonEmptyString(value.unit)
      && value.unit.length <= 256
      && /^[A-Za-z0-9_.:@-]+$/.test(value.unit)
      && keys.length === 2
      && keys[0] === 'state'
      && keys[1] === 'unit';
  } catch {
    return false;
  }
}

/**
 * Start the local resource wrapper and release the caller only after it has
 * admitted the scoped provider on fd 3. The caller owns termination so its
 * existing process-tree proof applies equally while the wrapper is queued.
 */
export function spawnHostWorkAdmitted(options: HostWorkAdmissionOptions): Promise<ChildProcess> {
  return new Promise<ChildProcess>((resolve, reject) => {
    if (
      options.expectedExecutableSha256 !== undefined
      && !/^[a-f0-9]{64}$/.test(options.expectedExecutableSha256)
    ) {
      reject(new HostWorkAdmissionError());
      return;
    }
    const helper = hostWorkAdmissionHelper();
    const runtime = hostRuntimeEnvironment();
    if (helper === null || runtime === null) {
      reject(new HostWorkAdmissionError());
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(helper, [
        '--profile', 'agent',
        '--class', 'interactive',
        '--notify-fd', '3',
        ...(options.expectedExecutableSha256 === undefined
          ? []
          : ['--expected-executable-sha256', options.expectedExecutableSha256]),
        '--',
        options.binary,
        ...options.args,
      ], {
        cwd: options.cwd,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        env: {
          ...options.env,
          XDG_RUNTIME_DIR: runtime.runtimeDir,
          DBUS_SESSION_BUS_ADDRESS: runtime.sessionBus,
        },
      });
    } catch {
      reject(new HostWorkAdmissionError());
      return;
    }

    let settled = false;
    let terminating: Promise<void> | null = null;
    let receivedBytes = 0;
    let line = '';
    let recordComplete = false;
    const decoder = new StringDecoder('utf8');
    const notify = child.stdio[3];

    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', onAbort);
      child.removeListener('error', onEarlyExit);
      child.removeListener('exit', onEarlyExit);
      notify?.removeListener('data', onData);
      notify?.removeListener('end', onNotifyEnd);
      notify?.removeListener('error', onEarlyExit);
    };
    const terminate = (): Promise<void> => {
      if (terminating === null) {
        terminating = Promise.resolve().then(() => options.onAbort(child));
      }
      return terminating;
    };
    const fail = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void terminate().then(
        () => reject(new HostWorkAdmissionError()),
        (cleanupError: unknown) => reject(new HostWorkAdmissionCleanupError(cleanupError)),
      );
    };
    const onEarlyExit = (): void => fail();
    const onAbort = (): void => fail();
    const onNotifyEnd = (): void => {
      if (!recordComplete) {
        fail();
        return;
      }
      settled = true;
      cleanup();
      resolve(child);
    };
    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (recordComplete) {
        if (bytes.length > 0) fail();
        return;
      }
      const newline = bytes.indexOf(0x0a);
      const admittedBytes = newline === -1 ? bytes.length : newline;
      if (receivedBytes + admittedBytes > MAX_ADMISSION_RECORD_BYTES) {
        fail();
        return;
      }
      receivedBytes += admittedBytes;
      line += decoder.write(newline === -1 ? bytes : bytes.subarray(0, newline));
      if (newline === -1) return;
      if (!validAdmissionRecord(line) || bytes.length !== newline + 1) {
        fail();
        return;
      }
      recordComplete = true;
    };

    if (!notify || typeof notify.on !== 'function') {
      fail();
      return;
    }

    try {
      options.onSpawned?.(child);
    } catch {
      fail();
      return;
    }
    child.on('error', onEarlyExit);
    child.on('exit', onEarlyExit);
    notify.on('data', onData);
    notify.on('end', onNotifyEnd);
    notify.on('error', onEarlyExit);
    if (options.signal?.aborted) {
      fail();
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true });
    }
  });
}
