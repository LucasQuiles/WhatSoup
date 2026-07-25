/**
 * GET /api/lines/:name/live-sessions — the live session inspector
 * (terminal Stage A, part 1; MAP: docs/proposals/2026-07-20-terminal-leg-map.md).
 *
 * Joins a scoped, read-only `ps` probe against the instance's
 * session_checkpoints via claude_pid — answering the #1861/#1870 question
 * "which generation is ACTUALLY alive vs which row claims to be":
 *   - `resumable-but-pid-dead`  — checkpoint claims active/suspended, process gone
 *   - `pid-alive-after-end`     — row ended/orphaned but the process LIVES
 *                                 (the #1861 stale-retention class, surfaced in warn)
 *
 * Zero input path: the probe is a read-only `ps` snapshot (execFileSync, no
 * shell — platform.ts discipline), never a write/exec channel. The probe is
 * injectable (deps.probeProcesses) for tests. Fail-closed: a probe failure
 * returns 200 + probeError — never fabricated liveness.
 *
 * Deliberately narrow imports (http + child_process + type-only
 * discovery/db-reader) so this handler's module graph stays off the
 * config/agent-config-validator chain.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { jsonResponse, requireInstance } from '../../lib/http.ts';
import type { FleetDiscovery } from '../discovery.ts';
import type { FleetDbReader } from '../db-reader.ts';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  state: string;
  etimeSeconds: number;
  args: string;
}

/**
 * Parse a `ps` elapsed-time field (`[[dd-]hh:]mm:ss`) into seconds.
 *
 * Returns null for anything that is not that shape, so a malformed column
 * cannot become NaN — `NaN` survives `?? null` (it is not nullish) and would
 * reach API consumers as a number that fails every comparison.
 */
export function parseEtimeSeconds(raw: string): number | null {
  const m = raw.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const days = m[1] ? Number(m[1]) : 0;
  const hours = m[2] ? Number(m[2]) : 0;
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  if (minutes > 59 || seconds > 59) return null;
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

/** Parse `ps -eo pid=,ppid=,stat=,etime=,args=` output (headerless). */
export function parsePsTable(text: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+((?:\d+-)?(?:\d+:)?\d+:\d+)\s+(.+)$/);
    if (!m) continue;
    const etimeSeconds = parseEtimeSeconds(m[4]!);
    if (etimeSeconds === null) continue;
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      state: m[3]!,
      etimeSeconds,
      args: m[5]!,
    });
  }
  return out;
}

/**
 * The real scoped probe: claude processes only, own user, read-only.
 *
 * Uses `etime`, not `etimes`. `etimes` (elapsed seconds) is a GNU procps-ng
 * extension: BSD `ps` on macOS rejects it with `ps: etimes: keyword not found`
 * AND still exits non-zero while printing the remaining columns, so the field
 * silently disappears from the table. Since this fleet server explicitly
 * supports macOS (`platform.ts` `macos-launchd`), that made every live-sessions
 * probe fail there. `etime` is the field BOTH procps-ng and BSD implement, so
 * using it needs no platform branch at all — one code path that is also correct
 * on any third `ps` (busybox, docker images) that implements only the POSIX
 * field.
 */
export const PS_PROBE_ARGS: readonly string[] = ['-eo', 'pid=,ppid=,stat=,etime=,args='];

function probeClaudeProcesses(): ProcessInfo[] {
  const text = execFileSync(
    'ps',
    [...PS_PROBE_ARGS],
    { encoding: 'utf8', timeout: 5_000 },
  );
  return parsePsTable(text).filter((p) => /(^|\/)claude( |$)/.test(p.args));
}

export interface LiveSessionsDeps {
  discovery: FleetDiscovery;
  dbReader: FleetDbReader;
  /** Injectable for tests; defaults to the real scoped ps probe. */
  probeProcesses?: () => ProcessInfo[];
}

type Anomaly = 'resumable-but-pid-dead' | 'pid-alive-after-end' | null;

export async function handleGetLiveSessions(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: LiveSessionsDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const observedAt = new Date().toISOString();
  const probe = deps.probeProcesses ?? probeClaudeProcesses;

  let processes: ProcessInfo[];
  try {
    processes = probe();
  } catch {
    jsonResponse(res, 200, { observedAt, probeError: true });
    return;
  }
  const byPid = new Map(processes.map((p) => [p.pid, p]));

  const read = deps.dbReader.getCheckpoints(instance.name, instance.dbPath);
  if (!read.ok) {
    jsonResponse(res, 200, { observedAt, readError: true });
    return;
  }

  let anomalyCount = 0;
  const sessions = read.data.map((row) => {
    const proc = row.claudePid !== null ? byPid.get(row.claudePid) : undefined;
    const pidAlive = row.claudePid === null ? null : proc !== undefined;
    let anomaly: Anomaly = null;
    if (row.claudePid !== null) {
      if (row.resumable && proc === undefined) {
        anomaly = 'resumable-but-pid-dead';
      } else if (!row.resumable && proc !== undefined) {
        anomaly = 'pid-alive-after-end';
      }
    }
    if (anomaly !== null) anomalyCount += 1;
    return {
      conversationKey: row.conversationKey,
      sessionStatus: row.sessionStatus,
      resumable: row.resumable,
      claudePid: row.claudePid,
      pidAlive,
      pidState: proc?.state ?? null,
      pidEtimeSeconds: proc?.etimeSeconds ?? null,
      anomaly,
    };
  });

  jsonResponse(res, 200, { observedAt, sessions, anomalyCount });
}
