/**
 * Operator drain-now trigger + live session activation (capability-obligation
 * replay, round 22 — the owner-authorized AE1 adapter).
 *
 * The gap (round-15 finding 2): `drainObligationNow` gates and drains ONE named
 * obligation, but nothing in the live runtime invoked it — `activateSession` /
 * `runTick` were unit-stub ports, so after a cold deploy no incident obligation
 * was drainable by any actually-runnable operator action.
 *
 * This module wires both halves WITHOUT widening any agent-reachable surface:
 *
 *  - TRIGGER: a same-UID drop-file protocol. The operator CLI
 *    (`scripts/capability-obligation-drain-now.ts`) writes
 *    `<db-dir>/capability-drain-now/<obligationId>.json`; the obligation
 *    runtime's existing single-flight scan services pending requests at the
 *    start of each tick. No new network surface, no MCP tool an agent session
 *    could call, no schema migration (a migration bumps
 *    CURRENT_SCHEMA_MIGRATION, which is INSIDE every attestation binding — it
 *    would silently invalidate every recorded attestation, fail-closed).
 *    The file channel's trust boundary is the single trusted UID — the same
 *    owner-ratified F4 boundary the staged-copy execution path documents.
 *  - ACTIVATION: the proven proactive-resume activation recipe (capture
 *    ownership → spawn → transition ownership to active), MINUS everything
 *    resume-specific: a FRESH spawn with no checkpoint resume, no
 *    missed-message injection, and no continuation turn. The ONLY turn that
 *    can enter the activated session is the minted obligation turn the
 *    supervisor dispatches — so this cannot emit an unsolicited message, and
 *    the AE1 group rule holds: `drainObligationNow` refuses to activate a
 *    group without a LIVE AS-08 approval, and refuses ANY obligation with no
 *    plausible attestation candidate (pre-activation gate).
 *
 * Fail-closed properties of the file protocol:
 *  - a request is CONSUMED (renamed) before it is serviced — a crash between
 *    consume and act loses the request (operator re-issues), never services it twice;
 *  - unparseable, mismatched, expired, future-dated, or symlinked requests are
 *    consumed and recorded, never serviced;
 *  - at most `maxRequestsPerCycle` requests are serviced per tick.
 */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { systemClock } from '../../lib/clock.ts';

export const DRAIN_NOW_REQUEST_DIRNAME = 'capability-drain-now';
export const DRAIN_NOW_REQUEST_TTL_SECONDS = 900;
export const DRAIN_NOW_MAX_FUTURE_SKEW_SECONDS = 300;
export const DRAIN_NOW_MAX_REQUESTS_PER_CYCLE = 3;
const CONSUMED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CONSUMED_PRUNE_PER_CYCLE = 20;

const REQUEST_FILENAME_RE = /^(\d{1,10})\.json$/;

/** The operator request payload. The filename id MUST match `obligationId`. */
export const drainNowRequestSchema = z
  .object({
    obligationId: z.number().int().positive().max(2_147_483_647),
    requestedAtUnixSec: z.number().int().positive(),
    requestedBy: z.string().min(1).max(128),
    nonce: z.string().min(8).max(64),
  })
  .strict();

export type DrainNowRequest = z.infer<typeof drainNowRequestSchema>;

/**
 * The request drop-dir for a given database path. Both the runtime and the
 * operator CLI derive it from the SAME `--db` path, so no extra configuration
 * can point them at different dirs. An in-memory DB has no dir → null (the
 * servicing loop is inert).
 */
export function drainNowRequestDirForDbPath(dbPath: string): string | null {
  if (dbPath === ':memory:') return null;
  return join(dirname(dbPath), DRAIN_NOW_REQUEST_DIRNAME);
}

// ── live session activation (the AE1 adapter half) ──────────────────────────

/** The minimal session surface activation needs (structural — SessionManager satisfies it). */
export interface ActivatableSession {
  getStatus(): { active: boolean };
  spawnSession(): Promise<void>;
}

export interface OwnedGeneration {
  managerId: string;
  generation: number;
}

/**
 * Primitive closures over the AgentRuntime's private per-chat session
 * machinery. Each is a one-line pass-through at the runtime call site; the
 * ORDER and error handling live here where they are unit-testable.
 */
export interface SessionActivationPorts {
  resolveMapKey: (deliveryJid: string) => string;
  /**
   * resolvePerChatDispatchTarget — non-null ⇒ the session is active, owned,
   * and current (the EXACT predicate the supervisor's dispatch resolution
   * uses). Its cold path constructs an inactive manager when the map has none
   * (#2169), so after a null return the session EXISTS but is not active.
   */
  resolveActiveTarget: (deliveryJid: string) => object | null;
  getSession: (mapKey: string) => ActivatableSession | undefined;
  /** captureOwnedPerChatGeneration — throws when the session is not the owned current one. */
  captureOwnedGeneration: (mapKey: string, session: ActivatableSession) => OwnedGeneration;
  /** activateSpawnedOwnedPerChatSession — transitions ownership to active; throws when superseded. */
  activateSpawnedSession: (
    mapKey: string,
    session: ActivatableSession,
    expected: OwnedGeneration,
  ) => Promise<string>;
}

/**
 * Build the live `activateSession` closure `drainObligationNow` needs: the
 * proactive-resume activation recipe with a FRESH spawn and none of the
 * resume-only side effects. Fail-closed: any throw anywhere reports inactive.
 * The reported post-condition is `resolveActiveTarget(...) !== null` — the
 * SAME predicate the supervisor's dispatch will apply — never the session's
 * own flag alone.
 */
export function buildLiveActivateSession(
  ports: SessionActivationPorts,
): (deliveryJid: string) => Promise<boolean> {
  return async (deliveryJid: string): Promise<boolean> => {
    try {
      if (ports.resolveActiveTarget(deliveryJid) !== null) return true;
      const mapKey = ports.resolveMapKey(deliveryJid);
      const session = ports.getSession(mapKey);
      if (session === undefined) return false;
      if (!session.getStatus().active) {
        const ownership = ports.captureOwnedGeneration(mapKey, session);
        await session.spawnSession();
        await ports.activateSpawnedSession(mapKey, session, ownership);
      }
      return ports.resolveActiveTarget(deliveryJid) !== null;
    } catch {
      // intentional: activation is best-effort and MUST fail closed — the
      // caller reports session_activation_failed and the obligation stays
      // parked; nothing is dispatched on a session of uncertain state.
      return false;
    }
  };
}

// ── drop-file request servicing (the operator trigger half) ─────────────────

export type DrainNowServiceOutcome =
  | { kind: 'drained'; obligationId: number; file: string }
  | { kind: 'refused'; obligationId: number; file: string; reason: string }
  | { kind: 'invalid'; file: string; reason: string };

export interface DrainNowServiceDeps {
  requestDir: string;
  /** drainObligationNow bound to the live deps. */
  drain: (obligationId: number) => Promise<
    { activated: true } | { activated: false; reason: string }
  >;
  maxRequestsPerCycle?: number;
  requestTtlSeconds?: number;
  nowUnixSec?: () => number;
}

/**
 * Service pending operator drain-now requests, at most `maxRequestsPerCycle`,
 * oldest obligation id first. Every considered request is CONSUMED (renamed)
 * before any gate or drain runs; outcomes are recorded next to the consumed
 * file (best-effort). Returns the outcomes for the caller to log. Never
 * throws: a broken drop-dir yields an empty result, and per-request errors
 * are recorded as refusals.
 */
export async function serviceDrainNowRequests(
  deps: DrainNowServiceDeps,
): Promise<DrainNowServiceOutcome[]> {
  const now = deps.nowUnixSec ?? (() => systemClock.nowUnixSec());
  const ttl = deps.requestTtlSeconds ?? DRAIN_NOW_REQUEST_TTL_SECONDS;
  const max = deps.maxRequestsPerCycle ?? DRAIN_NOW_MAX_REQUESTS_PER_CYCLE;

  let names: string[];
  try {
    names = readdirSync(deps.requestDir);
  } catch {
    return []; // no drop-dir → nothing requested (the common case)
  }

  // r22 AE1-review hardening: the drop-dir itself must be trustworthy — a
  // regular directory owned by THIS process's EUID with no group/other write
  // bit. Anything else is refused (fail-closed, surfaced for logging) rather
  // than serviced; the CLI creates the dir 0700, so a legitimate deploy never
  // trips this.
  try {
    const dirStat = lstatSync(deps.requestDir);
    const euid = typeof process.geteuid === 'function' ? process.geteuid() : null;
    if (
      !dirStat.isDirectory()
      || (dirStat.mode & 0o022) !== 0
      || euid === null
      || dirStat.uid !== euid
    ) {
      return [{ kind: 'invalid', file: '.', reason: 'untrusted_request_dir' }];
    }
  } catch {
    return [{ kind: 'invalid', file: '.', reason: 'untrusted_request_dir' }];
  }
  pruneConsumedArtifacts(deps.requestDir, names);

  const pending = names
    .map((name) => {
      const m = REQUEST_FILENAME_RE.exec(name);
      return m === null ? null : { name, id: Number(m[1]) };
    })
    .filter((entry): entry is { name: string; id: number } => entry !== null)
    .sort((a, b) => a.id - b.id)
    .slice(0, max);

  const outcomes: DrainNowServiceOutcome[] = [];
  for (const entry of pending) {
    const requestPath = join(deps.requestDir, entry.name);
    const consumedPath = `${requestPath}.consumed-${now()}`;

    // Symlink refusal BEFORE any read: the drop-dir must contain only regular
    // files (same rule as the resolver-artifact manifest).
    let isRegular = false;
    try {
      isRegular = lstatSync(requestPath).isFile();
    } catch {
      continue; // vanished — nothing to consume
    }

    // CONSUME FIRST (atomic rename): a crash after this point loses the
    // request (operator re-issues) — it can never be serviced twice.
    try {
      renameSync(requestPath, consumedPath);
    } catch {
      continue; // raced/vanished — treat as not ours
    }

    const record = (outcome: DrainNowServiceOutcome): void => {
      outcomes.push(outcome);
      try {
        writeFileSync(
          `${consumedPath}.result.json`,
          `${JSON.stringify({ ...outcome, at: now() })}\n`,
          { flag: 'wx', mode: 0o600 },
        );
      } catch {
        // intentional: a result-file write failure must not fail the service —
        // the outcome is still surfaced to the caller for logging.
      }
    };

    // r22 AE1-review hardening: re-lstat the CONSUMED path — the pre-rename
    // lstat is TOCTOU-racable (same-UID only, but closing it is one syscall).
    // The rename moved whatever the entry was; only a regular file may be read.
    try {
      if (!lstatSync(consumedPath).isFile()) isRegular = false;
    } catch {
      continue; // vanished post-rename — nothing to service
    }
    if (!isRegular) {
      record({ kind: 'invalid', file: entry.name, reason: 'not_a_regular_file' });
      continue;
    }

    let request: DrainNowRequest;
    try {
      const parsed: unknown = JSON.parse(readFileSync(consumedPath, 'utf8'));
      request = drainNowRequestSchema.parse(parsed);
    } catch {
      record({ kind: 'invalid', file: entry.name, reason: 'unparseable_request' });
      continue;
    }
    if (request.obligationId !== entry.id) {
      record({ kind: 'invalid', file: entry.name, reason: 'filename_id_mismatch' });
      continue;
    }
    const age = now() - request.requestedAtUnixSec;
    if (age > ttl) {
      record({ kind: 'refused', obligationId: entry.id, file: entry.name, reason: 'request_expired' });
      continue;
    }
    if (age < -DRAIN_NOW_MAX_FUTURE_SKEW_SECONDS) {
      record({ kind: 'refused', obligationId: entry.id, file: entry.name, reason: 'request_future_dated' });
      continue;
    }

    try {
      const result = await deps.drain(request.obligationId);
      if (result.activated) {
        record({ kind: 'drained', obligationId: entry.id, file: entry.name });
      } else {
        record({ kind: 'refused', obligationId: entry.id, file: entry.name, reason: result.reason });
      }
    } catch (err) {
      record({
        kind: 'refused',
        obligationId: entry.id,
        file: entry.name,
        reason: `drain_threw:${err instanceof Error ? err.name : 'unknown'}`,
      });
    }
  }
  return outcomes;
}

/** Bounded GC of consumed/result artifacts older than the retention window. */
function pruneConsumedArtifacts(requestDir: string, names: readonly string[]): void {
  const cutoff = Date.now() - CONSUMED_RETENTION_MS;
  let pruned = 0;
  for (const name of names) {
    if (pruned >= CONSUMED_PRUNE_PER_CYCLE) return;
    if (!/\.json\.consumed-\d+(\.result\.json)?$/.test(name)) continue;
    const full = join(requestDir, name);
    try {
      if (statSync(full).mtimeMs < cutoff) {
        rmSync(full, { force: true });
        pruned += 1;
      }
    } catch {
      // intentional: GC is best-effort; a stat/rm race never affects servicing.
    }
  }
}

/**
 * Write an operator drain-now request atomically (tmp + rename, never
 * overwriting a pending request). Used by the operator CLI; exported here so
 * the writer and the reader share one protocol definition.
 */
export function writeDrainNowRequest(requestDir: string, request: DrainNowRequest): string {
  drainNowRequestSchema.parse(request);
  mkdirSync(requestDir, { recursive: true, mode: 0o700 });
  const finalPath = join(requestDir, `${request.obligationId}.json`);
  let pendingExists = true;
  try {
    lstatSync(finalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    pendingExists = false;
  }
  if (pendingExists) throw new Error(`a pending drain-now request already exists: ${finalPath}`);
  const tmpPath = join(requestDir, `.tmp-${request.nonce}-${request.obligationId}`);
  writeFileSync(tmpPath, `${JSON.stringify(request)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(tmpPath, finalPath);
  return finalPath;
}
