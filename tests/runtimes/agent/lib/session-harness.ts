// Shared real-process harness for the B1, B2, and X6 regression probes.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../../../../src/core/database.ts';
import { ensureAgentSchema } from '../../../../src/runtimes/agent/session-db.ts';
import { SessionManager } from '../../../../src/runtimes/agent/session.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_PROVIDER = join(HERE, '..', 'bin', 'fake-provider.mjs');

export interface FakeConfig {
  runId: string;
  pidFile?: string;
  sessionId: string;
  protocol?: 'claude' | 'opencode';
  lateSessionId?: string;
  graceMs?: number;
  spawnGrandchildren?: boolean;
  grandchildrenIgnoreSigterm?: boolean;
  crashAfterMs?: number;
  crashCode?: number;
  handleSigterm?: boolean;
  ignoreSigterm?: boolean;
}

export function makeMemoryDb(): Database {
  const db = new Database(':memory:');
  db.open();
  ensureAgentSchema(db);
  return db;
}

export function makeMessenger(): { messenger: any; sent: Array<{ jid: string; text: string }> } {
  const sent: Array<{ jid: string; text: string }> = [];
  const messenger = {
    sendMessage: async (jid: string, text: string) => {
      sent.push({ jid, text });
      return { waMessageId: null };
    },
    sendMedia: async () => ({ waMessageId: null }),
  };
  return { messenger, sent };
}

export interface BuildManagerOpts {
  db: Database;
  messenger: any;
  chatJid: string;
  onEvent?: (event: unknown) => void;
  onCrash?: (info: unknown) => void;
  notifyUser?: (msg: string) => void;
  fakeConfig: FakeConfig;
}

export function buildManager(opts: BuildManagerOpts): { mgr: SessionManager; gen: () => number } {
  const { db, messenger, chatJid, onEvent, onCrash, notifyUser, fakeConfig } = opts;
  const mgr = new SessionManager({
    db,
    messenger,
    chatJid,
    onEvent: (onEvent ?? (() => {})) as any,
    onCrash: onCrash as any,
    notifyUser: notifyUser as any,
    provider: 'claude-cli',
    configSystemPrompt: 'Lifecycle regression probe system prompt.',
  });
  let generation = 0;
  (mgr as any).getProviderBinary = () => process.execPath;
  (mgr as any).getProviderArgs = () => {
    generation += 1;
    const perGeneration: FakeConfig = {
      ...fakeConfig,
      sessionId: `${fakeConfig.sessionId}-gen${generation}`,
      lateSessionId: generation === 1 ? fakeConfig.lateSessionId : undefined,
    };
    return [FAKE_PROVIDER, JSON.stringify(perGeneration)];
  };
  return { mgr, gen: () => generation };
}

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

export function killPid(pid: number | null | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error: any) {
    if (error?.code === 'ESRCH') return;
    throw error;
  }
}

export function psAll(): string {
  return execFileSync('ps', ['-Aww', '-o', 'pid,ppid,pgid,command'], { encoding: 'utf8' });
}

export function psForPid(pid: number): { raw: string; pid: number; ppid: number; pgid: number } | null {
  try {
    const raw = execFileSync('ps', ['-ww', '-o', 'pid,ppid,pgid,command', '-p', String(pid)], {
      encoding: 'utf8',
    });
    const line = raw.trim().split('\n').slice(1)[0];
    if (!line) return null;
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s/);
    if (!match) return { raw, pid, ppid: -1, pgid: -1 };
    return { raw, pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) };
  } catch {
    return null;
  }
}

export function censusRowsMatching(
  needle: string,
): Array<{ pid: number; ppid: number; pgid: number; command: string }> {
  const rows: Array<{ pid: number; ppid: number; pgid: number; command: string }> = [];
  for (const line of psAll().split('\n')) {
    if (!line.includes(needle)) continue;
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4],
    });
  }
  return rows;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  stepMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}
