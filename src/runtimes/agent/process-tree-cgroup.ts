import { open, opendir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { systemClock } from '../../lib/clock.ts';
import type { ProcessTreeDiagnosticFailureCode } from './process-tree-contract.ts';

export const PROCESS_TREE_CGROUP_MAX_DEPTH = 32;
export const PROCESS_TREE_CGROUP_MAX_ENTRIES = 4_096;
export const PROCESS_TREE_CGROUP_MAX_BYTES = 4 * 1_024 * 1_024;
export const PROCESS_TREE_CGROUP_MAX_TIME_MS = 250;

export interface CgroupDirectoryEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface BoundedCgroupText {
  readonly text: string;
  readonly byteLength: number;
  readonly truncated: boolean;
}

export interface BoundedCgroupDirectory {
  readonly entries: readonly CgroupDirectoryEntry[];
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

export interface CgroupDirectoryHandle {
  read(): Promise<CgroupDirectoryEntry | null>;
  close(): Promise<void>;
}

export interface CgroupObservationIo {
  readText(path: string, maxBytes: number, signal?: AbortSignal): Promise<BoundedCgroupText>;
  readDirectory(
    path: string,
    maxEntries: number,
    signal?: AbortSignal,
  ): Promise<BoundedCgroupDirectory>;
}

/** Injected readers must stop their own work when the required signal aborts. */
export type CgroupMemberPidReader = (signal: AbortSignal) =>
  | readonly number[]
  | null
  | Promise<readonly number[] | null>;

export type CgroupMemberObservation =
  | {
      readonly state: 'complete';
      readonly memberPids: readonly number[];
    }
  | {
      readonly state: 'not_applicable';
    }
  | {
      readonly state: 'unavailable' | 'inconclusive';
      readonly diagnosticCode: ProcessTreeDiagnosticFailureCode;
    };

function incomplete(
  state: 'unavailable' | 'inconclusive',
  diagnosticCode: ProcessTreeDiagnosticFailureCode,
): CgroupMemberObservation {
  return { state, diagnosticCode };
}

function validPathEntry(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\');
}

function parseMemberPids(
  text: string,
  members: Set<number>,
  now: () => number,
  deadlineAtMs: number,
  signal?: AbortSignal,
): 'valid' | 'invalid' | 'limit' | 'timeout' {
  for (const [index, rawLine] of text.split('\n').entries()) {
    if (index % 256 === 0 && (signal?.aborted || now() >= deadlineAtMs)) return 'timeout';
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (!/^\d+$/.test(line)) return 'invalid';
    const pid = Number(line);
    if (!Number.isSafeInteger(pid) || pid <= 0) return 'invalid';
    members.add(pid);
    if (members.size > PROCESS_TREE_CGROUP_MAX_ENTRIES) return 'limit';
  }
  return 'valid';
}

export async function readBoundedCgroupDirectory(
  handle: CgroupDirectoryHandle,
  maxEntries: number,
  signal?: AbortSignal,
): Promise<BoundedCgroupDirectory> {
  const entries: CgroupDirectoryEntry[] = [];
  let truncated = false;
  let timedOut = false;
  try {
    while (true) {
      if (signal?.aborted) {
        timedOut = true;
        break;
      }
      const entry = await handle.read();
      if (signal?.aborted) {
        timedOut = true;
        break;
      }
      if (entry === null) break;
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
  } finally {
    await handle.close();
  }
  return { entries, truncated, timedOut };
}

export async function collectCgroupMemberPids(
  root: string,
  io: CgroupObservationIo,
  options: {
    readonly initialBytes?: number;
    readonly deadlineAtMs?: number;
    readonly now?: () => number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<CgroupMemberObservation> {
  const now = options.now ?? (() => systemClock.now());
  const signal = options.signal;
  const deadlineAtMs = options.deadlineAtMs ?? now() + PROCESS_TREE_CGROUP_MAX_TIME_MS;
  let bytesRead = options.initialBytes ?? 0;
  let entriesRead = 0;
  if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) {
    return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_INPUT_INVALID');
  }
  if (bytesRead > PROCESS_TREE_CGROUP_MAX_BYTES) {
    return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_LIMIT_BYTES');
  }

  const members = new Set<number>();
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  try {
    while (queue.length > 0) {
      if (signal?.aborted || now() >= deadlineAtMs) {
        return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_LIMIT_TIME');
      }
      const current = queue.shift();
      if (!current) break;
      const remainingBytes = PROCESS_TREE_CGROUP_MAX_BYTES - bytesRead;
      const procs = await io.readText(join(current.path, 'cgroup.procs'), remainingBytes, signal);
      if (signal?.aborted) {
        return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_LIMIT_TIME');
      }
      if (
        !Number.isSafeInteger(procs.byteLength)
        || procs.byteLength < 0
        || procs.byteLength > remainingBytes
        || procs.truncated
      ) {
        return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_LIMIT_BYTES');
      }
      bytesRead += procs.byteLength;
      const memberParse = parseMemberPids(procs.text, members, now, deadlineAtMs, signal);
      if (memberParse === 'timeout') {
        return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_LIMIT_TIME');
      }
      if (memberParse === 'limit') {
        return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_LIMIT_ENTRIES');
      }
      if (memberParse === 'invalid') {
        return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_INPUT_INVALID');
      }
      if (now() >= deadlineAtMs) {
        return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_LIMIT_TIME');
      }

      const remainingEntries = PROCESS_TREE_CGROUP_MAX_ENTRIES - entriesRead;
      const directory = await io.readDirectory(current.path, remainingEntries, signal);
      if (signal?.aborted) {
        return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_LIMIT_TIME');
      }
      if (
        typeof directory !== 'object'
        || directory === null
        || !Array.isArray(directory.entries)
        || typeof directory.truncated !== 'boolean'
        || typeof directory.timedOut !== 'boolean'
      ) {
        return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_INPUT_INVALID');
      }
      if (directory.timedOut) {
        return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_LIMIT_TIME');
      }
      if (directory.truncated || directory.entries.length > remainingEntries) {
        return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_LIMIT_ENTRIES');
      }
      const entries = directory.entries;
      entriesRead += entries.length;
      for (const entry of entries) {
        if (
          typeof entry !== 'object'
          || entry === null
          || typeof entry.name !== 'string'
          || typeof entry.isDirectory !== 'boolean'
          || !validPathEntry(entry.name)
        ) {
          return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_INPUT_INVALID');
        }
        if (!entry.isDirectory) continue;
        const depth = current.depth + 1;
        if (depth > PROCESS_TREE_CGROUP_MAX_DEPTH) {
          return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_LIMIT_DEPTH');
        }
        queue.push({ path: join(current.path, entry.name), depth });
      }
    }
  } catch {
    return incomplete('unavailable', 'PROCESS_TREE_CGROUP_OBSERVATION_UNAVAILABLE');
  }
  return { state: 'complete', memberPids: [...members].sort((left, right) => left - right) };
}

const nodeCgroupIo: CgroupObservationIo = {
  async readText(path, maxBytes, signal) {
    let handle;
    try {
      handle = await open(path, 'r');
      const chunks: Buffer[] = [];
      let byteLength = 0;
      while (byteLength <= maxBytes) {
        if (signal?.aborted) {
          return { text: '', byteLength, truncated: true };
        }
        const capacity = Math.min(64 * 1_024, maxBytes + 1 - byteLength);
        const buffer = Buffer.allocUnsafe(Math.max(1, capacity));
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
        if (signal?.aborted) {
          return { text: '', byteLength, truncated: true };
        }
        if (bytesRead === 0) break;
        chunks.push(buffer.subarray(0, bytesRead));
        byteLength += bytesRead;
        if (byteLength > maxBytes) break;
      }
      const bytes = Buffer.concat(chunks, byteLength);
      if (byteLength > maxBytes) {
        return { text: '', byteLength, truncated: true };
      }
      return {
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        byteLength,
        truncated: byteLength > maxBytes,
      };
    } finally {
      await handle?.close();
    }
  },
  async readDirectory(path, maxEntries, signal) {
    const directory = await opendir(path, { bufferSize: Math.max(1, Math.min(32, maxEntries + 1)) });
    return readBoundedCgroupDirectory({
      async read() {
        const entry = await directory.read();
        return entry === null ? null : {
          name: entry.name,
          isDirectory: entry.isDirectory(),
        };
      },
      async close() {
        await directory.close();
      },
    }, maxEntries, signal);
  },
};

async function observeServiceCgroupMembers(
  deadlineAtMs: number,
  signal: AbortSignal,
): Promise<CgroupMemberObservation> {
  if (process.platform !== 'linux') {
    return { state: 'not_applicable' };
  }
  try {
    const self = await nodeCgroupIo.readText(
      '/proc/self/cgroup',
      PROCESS_TREE_CGROUP_MAX_BYTES,
      signal,
    );
    if (signal.aborted) {
      return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_LIMIT_TIME');
    }
    if (self.truncated || self.byteLength > PROCESS_TREE_CGROUP_MAX_BYTES) {
      return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_LIMIT_BYTES');
    }
    const unified = self.text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('0::'));
    if (unified.length !== 1) {
      return { state: 'not_applicable' };
    }
    const relativePath = unified[0].slice('0::'.length);
    if (!relativePath.startsWith('/') || !/whatsoup/i.test(relativePath)) {
      return { state: 'not_applicable' };
    }
    const cgroupRoot = resolve('/sys/fs/cgroup');
    const serviceRoot = resolve(cgroupRoot, `.${relativePath}`);
    const fromRoot = relative(cgroupRoot, serviceRoot);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
      return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_INPUT_INVALID');
    }
    return collectCgroupMemberPids(serviceRoot, nodeCgroupIo, {
      initialBytes: self.byteLength,
      deadlineAtMs,
      signal,
    });
  } catch {
    return incomplete('unavailable', 'PROCESS_TREE_CGROUP_OBSERVATION_UNAVAILABLE');
  }
}

function validateInjectedMembers(value: readonly number[] | null): CgroupMemberObservation {
  if (value === null) {
    return { state: 'not_applicable' };
  }
  try {
    if (!Array.isArray(value)) {
      return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_INPUT_INVALID');
    }
    if (value.length > PROCESS_TREE_CGROUP_MAX_ENTRIES) {
      return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_LIMIT_ENTRIES');
    }
    const members = new Set<number>();
    for (const pid of value) {
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_INPUT_INVALID');
      }
      members.add(pid);
    }
    return { state: 'complete', memberPids: [...members].sort((left, right) => left - right) };
  } catch {
    return incomplete('inconclusive', 'PROCESS_TREE_CGROUP_INPUT_INVALID');
  }
}

export async function observeCgroupMemberPids(
  reader?: CgroupMemberPidReader,
): Promise<CgroupMemberObservation> {
  const deadlineAtMs = systemClock.now() + PROCESS_TREE_CGROUP_MAX_TIME_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<CgroupMemberObservation>((resolveTimeout) => {
    timer = setTimeout(() => {
      controller.abort();
      resolveTimeout(incomplete('inconclusive', 'PROCESS_TREE_CGROUP_LIMIT_TIME'));
    }, PROCESS_TREE_CGROUP_MAX_TIME_MS);
    timer.unref?.();
  });
  const operation = reader
    ? Promise.resolve()
        .then(() => reader(controller.signal))
        .then(validateInjectedMembers)
        .catch(() => incomplete('unavailable', 'PROCESS_TREE_CGROUP_OBSERVATION_UNAVAILABLE'))
    : observeServiceCgroupMembers(deadlineAtMs, controller.signal);
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
