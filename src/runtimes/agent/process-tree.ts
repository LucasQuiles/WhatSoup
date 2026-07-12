import { execFileSync } from 'node:child_process';

export interface ProcessTreeTarget {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
}

export interface KillSessionTreeOptions {
  readonly generationMarker: string;
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
}

interface ProcessCensusRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly startedAt: string;
  readonly command: string;
}

interface OwnedProcessIdentity extends ProcessCensusRow {
  readonly depth: number;
  readonly generationMarker: string;
}

interface TerminationContext {
  readonly generationMarker: string;
  readonly promise: Promise<void>;
}

interface OwnedExitCheck {
  readonly survivors: readonly OwnedProcessIdentity[];
  readonly ambiguous: readonly OwnedProcessIdentity[];
  readonly verified: boolean;
  readonly censusError: unknown | null;
}

interface OwnedInspection {
  readonly survivors: readonly OwnedProcessIdentity[];
  readonly ambiguous: readonly OwnedProcessIdentity[];
}

const DEFAULT_TERM_GRACE_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const RECHECK_INTERVAL_MS = 25;
const activeTerminations = new Map<number, TerminationContext>();

function parseProcessCensus(output: string): ProcessCensusRow[] {
  const rows: ProcessCensusRow[] = [];
  for (const line of output.split('\n').slice(1)) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)\s*$/,
    );
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      startedAt: match[4],
      command: match[5],
    });
  }
  return rows;
}

function readProcessCensus(): ProcessCensusRow[] {
  const output = execFileSync(
    'ps',
    ['-ww', '-eo', 'pid,ppid,pgid,lstart,command'],
    { encoding: 'utf8', timeout: 2_000, maxBuffer: 16 * 1024 * 1024 },
  );
  return parseProcessCensus(output);
}

function uniqueRowForPid(rows: readonly ProcessCensusRow[], pid: number): ProcessCensusRow | null {
  const matches = rows.filter((row) => row.pid === pid);
  return matches.length === 1 ? matches[0] : null;
}

function snapshotOwnedTree(
  rows: readonly ProcessCensusRow[],
  rootPid: number,
  generationMarker: string,
): OwnedProcessIdentity[] {
  const root = uniqueRowForPid(rows, rootPid);
  if (!root) return [];

  const childrenByParent = new Map<number, ProcessCensusRow[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row);
    childrenByParent.set(row.ppid, children);
  }

  const owned: OwnedProcessIdentity[] = [];
  const queue: Array<{ row: ProcessCensusRow; depth: number }> = [{ row: root, depth: 0 }];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next.row.pid)) continue;
    seen.add(next.row.pid);
    owned.push({ ...next.row, depth: next.depth, generationMarker });
    for (const child of childrenByParent.get(next.row.pid) ?? []) {
      queue.push({ row: child, depth: next.depth + 1 });
    }
  }
  return owned;
}

function sameProcess(
  row: ProcessCensusRow,
  owned: OwnedProcessIdentity,
  generationMarker: string,
): boolean {
  return row.pid === owned.pid &&
    row.startedAt === owned.startedAt &&
    row.command === owned.command &&
    owned.generationMarker === generationMarker;
}

function inspectOwned(
  rows: readonly ProcessCensusRow[],
  owned: readonly OwnedProcessIdentity[],
  generationMarker: string,
): OwnedInspection {
  const survivors: OwnedProcessIdentity[] = [];
  const ambiguous: OwnedProcessIdentity[] = [];
  for (const identity of owned) {
    const matches = rows.filter((row) => row.pid === identity.pid);
    if (matches.length === 0) continue;
    if (matches.length !== 1) {
      ambiguous.push(identity);
      continue;
    }
    const current = matches[0];
    if (current.startedAt !== identity.startedAt) continue;
    if (!sameProcess(current, identity, generationMarker)) {
      ambiguous.push(identity);
      continue;
    }
    survivors.push(identity);
  }
  return { survivors, ambiguous };
}

function targetPid(target: number | ProcessTreeTarget): number {
  const pid = typeof target === 'number' ? target : target.pid;
  if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 1) {
    throw new Error(`Cannot reap invalid session process PID ${String(pid)}`);
  }
  return pid as number;
}

function signalPid(
  target: number | ProcessTreeTarget,
  rootPid: number,
  pid: number,
  signal: NodeJS.Signals,
): void {
  try {
    if (typeof target !== 'number' && pid === rootPid) {
      target.kill(signal);
    } else {
      process.kill(pid, signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function signalOwned(
  target: number | ProcessTreeTarget,
  rootPid: number,
  rows: readonly ProcessCensusRow[],
  owned: readonly OwnedProcessIdentity[],
  signal: NodeJS.Signals,
  generationMarker: string,
): void {
  const root = uniqueRowForPid(rows, rootPid);
  const ownedRoot = owned.find((identity) => identity.pid === rootPid) ?? null;
  const self = uniqueRowForPid(rows, process.pid);
  const safeGroup = root !== null &&
    ownedRoot !== null &&
    sameProcess(root, ownedRoot, generationMarker) &&
    self !== null &&
    root.pgid === root.pid &&
    root.pgid !== self.pgid;
  let groupSignalled = false;

  if (safeGroup) {
    try {
      process.kill(-root.pgid, signal);
      groupSignalled = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        groupSignalled = false;
      }
    }
  }

  for (const identity of [...owned].sort((left, right) => right.depth - left.depth)) {
    const current = uniqueRowForPid(rows, identity.pid);
    if (groupSignalled && current?.pgid === root?.pgid) continue;
    signalPid(target, rootPid, identity.pid, signal);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOwnedExit(
  owned: readonly OwnedProcessIdentity[],
  generationMarker: string,
  timeoutMs: number,
): Promise<OwnedExitCheck> {
  const deadline = Date.now() + timeoutMs;
  let survivors: readonly OwnedProcessIdentity[] = owned;
  let ambiguous: readonly OwnedProcessIdentity[] = [];
  let censusError: unknown | null = null;
  do {
    try {
      const inspection = inspectOwned(readProcessCensus(), owned, generationMarker);
      survivors = inspection.survivors;
      ambiguous = inspection.ambiguous;
      censusError = null;
      if (survivors.length === 0 && ambiguous.length === 0) {
        return { survivors: [], ambiguous: [], verified: true, censusError: null };
      }
    } catch (error) {
      survivors = owned;
      ambiguous = [];
      censusError = error;
    }
    if (Date.now() >= deadline) {
      return { survivors, ambiguous, verified: censusError === null, censusError };
    }
    await delay(Math.min(RECHECK_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  } while (true);
}

async function runTermination(
  target: number | ProcessTreeTarget,
  rootPid: number,
  owned: readonly OwnedProcessIdentity[],
  preCensusAvailable: boolean,
  signal: NodeJS.Signals,
  options: KillSessionTreeOptions,
): Promise<void> {
  if (owned.length === 0) {
    const reason = preCensusAvailable ? 'root row missing or ambiguous' : 'census unavailable';
    throw new Error(
      `Refusing to signal session process tree ${options.generationMarker}: pre-signal ${reason}`,
    );
  }

  try {
    const firstCensus = readProcessCensus();
    const firstInspection = inspectOwned(firstCensus, owned, options.generationMarker);
    if (firstInspection.ambiguous.length > 0) {
      throw new Error(
        `Refusing to signal session process tree ${options.generationMarker}: identity became ambiguous`,
      );
    }
    signalOwned(
      target,
      rootPid,
      firstCensus,
      firstInspection.survivors,
      signal,
      options.generationMarker,
    );
  } catch (error) {
    throw new Error(
      `Refusing to signal session process tree ${options.generationMarker}: pre-signal recensus unavailable`,
      { cause: error },
    );
  }

  if (signal === 'SIGTERM') {
    const termCheck = await waitForOwnedExit(
      owned,
      options.generationMarker,
      options.termGraceMs ?? DEFAULT_TERM_GRACE_MS,
    );
    if (termCheck.ambiguous.length > 0) {
      throw new Error(
        `Refusing to escalate session process tree ${options.generationMarker}: identity became ambiguous`,
      );
    }
    if (termCheck.survivors.length > 0) {
      try {
        const killCensus = readProcessCensus();
        const killInspection = inspectOwned(
          killCensus,
          termCheck.survivors,
          options.generationMarker,
        );
        if (killInspection.ambiguous.length > 0) {
          throw new Error('process identity became ambiguous before escalation');
        }
        signalOwned(
          target,
          rootPid,
          killCensus,
          killInspection.survivors,
          'SIGKILL',
          options.generationMarker,
        );
      } catch (error) {
        throw new Error(
          `Refusing to escalate session process tree ${options.generationMarker}: recensus unavailable`,
          { cause: error },
        );
      }
    }
  }

  const finalCheck = await waitForOwnedExit(
    owned,
    options.generationMarker,
    options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
  );
  if (!finalCheck.verified) {
    throw new Error(
      `Unable to prove session process tree ${options.generationMarker} empty: final census unavailable`,
      { cause: finalCheck.censusError },
    );
  }
  if (finalCheck.ambiguous.length > 0) {
    throw new Error(
      `Unable to prove session process tree ${options.generationMarker} empty: ambiguous live identity`,
    );
  }
  if (finalCheck.survivors.length > 0) {
    throw new Error(
      `Session process tree ${options.generationMarker} still has live PIDs: ` +
        finalCheck.survivors.map((row) => row.pid).join(', '),
    );
  }
}

export function killSessionTree(
  target: number | ProcessTreeTarget,
  signal: NodeJS.Signals,
  options: KillSessionTreeOptions,
): Promise<void> {
  if (options.generationMarker.trim() === '') {
    return Promise.reject(new Error('Session process-tree generation marker must be non-empty'));
  }
  let rootPid: number;
  try {
    rootPid = targetPid(target);
  } catch (error) {
    return Promise.reject(error);
  }
  const existing = activeTerminations.get(rootPid);
  if (existing) {
    if (existing.generationMarker !== options.generationMarker) {
      return Promise.reject(new Error(
        `Refusing process-tree lease change for active PID ${rootPid}: ` +
          `${existing.generationMarker} -> ${options.generationMarker}`,
      ));
    }
    return existing.promise;
  }

  let owned: OwnedProcessIdentity[];
  let preCensusAvailable = false;
  try {
    owned = snapshotOwnedTree(readProcessCensus(), rootPid, options.generationMarker);
    preCensusAvailable = true;
  } catch (error) {
    owned = [];
  }

  let context: TerminationContext;
  const promise = runTermination(target, rootPid, owned, preCensusAvailable, signal, options)
    .finally(() => {
      if (activeTerminations.get(rootPid) === context) activeTerminations.delete(rootPid);
    });
  context = {
    generationMarker: options.generationMarker,
    promise,
  };
  activeTerminations.set(rootPid, context);
  return promise;
}
