import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  privateJournalPath,
  readPrivateV1JournalSync,
  writePrivateJournalSync,
} from '../lib/private-journal.ts';
import { forceEnsurePrivateDirectorySync } from '../lib/private-fs.ts';
import { acquireProcessLock, releaseProcessLock } from '../lib/process-lock.ts';
import { xdgDir } from './paths.ts';
import type { SilenceStoreReasonClass } from './silence-manager.ts';

export const SILENCE_REGISTRY_EPISODE_FILENAME = 'silence-registry-episode.json';
export const SILENCE_REGISTRY_EPISODE_FAILOVER_FILENAME = 'silence-registry-episode-failover.json';
export const SILENCE_REGISTRY_EPISODE_PENDING_RETRY_MS = 30_000;

type EpisodePhase = 'closed' | 'onset_pending' | 'open' | 'recovery_pending';
type FailureReadBasis = 'last_known_good' | 'none';
type EpisodeStoreOwner = 'primary' | 'failover';
const ISO_UTC_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

interface SilenceRegistryEpisodeState {
  v: 1;
  /** Present only in the sticky failover ledger. */
  owner?: 'failover';
  phase: EpisodePhase;
  episodeId: string | null;
  updatedAt: string;
  reasonClass: SilenceStoreReasonClass | null;
  readBasis: FailureReadBasis | null;
  recoveryFrom: 'onset_pending' | 'open' | null;
}

export type SilenceRegistryEpisodeRead =
  | { status: 'available'; phase: EpisodePhase }
  | { status: 'journal_unreadable' };

export type SilenceRegistryEpisodePreparation =
  | { status: 'available'; action: 'suppressed' }
  | { status: 'available'; action: 'emit_onset'; episodeId: string }
  | { status: 'available'; action: 'emit_recovery'; episodeId: string }
  | { status: 'journal_unreadable' };

export type SilenceRegistryEpisodeSettlement =
  | { status: 'available'; settled: boolean }
  | { status: 'journal_unreadable' };

export interface SilenceRegistryEpisodeStorePort {
  read(): SilenceRegistryEpisodeRead;
  prepareOnset(
    observation: { reasonClass: SilenceStoreReasonClass; readBasis: FailureReadBasis },
    now?: number,
  ): SilenceRegistryEpisodePreparation;
  confirmOnset(episodeId: string, now?: number): SilenceRegistryEpisodeSettlement;
  prepareRecovery(now?: number): SilenceRegistryEpisodePreparation;
  confirmRecovery(episodeId: string, now?: number): SilenceRegistryEpisodeSettlement;
}

function runningUnderVitest(): boolean {
  return process.env['VITEST'] === 'true'
    || process.env['VITEST_POOL_ID'] !== undefined
    || process.env['VITEST_WORKER_ID'] !== undefined;
}

function defaultStateRoot(): string {
  if (runningUnderVitest()) {
    const worker = process.env['VITEST_POOL_ID'] ?? process.env['VITEST_WORKER_ID'] ?? 'main';
    return join(tmpdir(), 'whatsoup-vitest-silence-registry-episodes', worker, String(process.pid));
  }
  return join(xdgDir('XDG_STATE_HOME', '.local/state'), 'whatsoup', 'fleet');
}

/** Private state path for the fleet-global silence-registry alert lifecycle. */
export function silenceRegistryEpisodePath(stateRoot = defaultStateRoot()): string {
  return privateJournalPath(stateRoot, SILENCE_REGISTRY_EPISODE_FILENAME);
}

/** Private fallback ledger retained after failover and never automatically reconciled. */
export function silenceRegistryEpisodeFailoverPath(stateRoot = defaultStateRoot()): string {
  return privateJournalPath(stateRoot, SILENCE_REGISTRY_EPISODE_FAILOVER_FILENAME);
}

function freshState(now: number, owner: EpisodeStoreOwner = 'primary'): SilenceRegistryEpisodeState {
  return {
    v: 1,
    ...(owner === 'failover' ? { owner: 'failover' as const } : {}),
    phase: 'closed',
    episodeId: null,
    updatedAt: new Date(now).toISOString(),
    reasonClass: null,
    readBasis: null,
    recoveryFrom: null,
  };
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_UTC_TIMESTAMP_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth[month - 1]!
    && hour <= 23
    && minute <= 59
    && second <= 59
    && Number.isFinite(Date.parse(value));
}

function isEpisodeId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function isReasonClass(value: unknown): value is SilenceStoreReasonClass {
  return value === 'invalid_json'
    || value === 'invalid_document'
    || value === 'missing_after_observed'
    || value === 'permission_denied'
    || value === 'read_failed';
}

function parseState(value: Record<string, unknown>, owner: EpisodeStoreOwner): SilenceRegistryEpisodeState | null {
  const phase = value['phase'];
  const episodeId = value['episodeId'];
  const reasonClass = value['reasonClass'];
  const readBasis = value['readBasis'];
  const recoveryFrom = value['recoveryFrom'];
  if (owner === 'failover' ? value['owner'] !== 'failover' : value['owner'] !== undefined) {
    return null;
  }
  if (
    !['closed', 'onset_pending', 'open', 'recovery_pending'].includes(String(phase))
    || !isIsoTimestamp(value['updatedAt'])
    || !(['last_known_good', 'none', null] as const).includes(readBasis as FailureReadBasis | null)
    || !(['onset_pending', 'open', null] as const).includes(recoveryFrom as 'onset_pending' | 'open' | null)
  ) {
    return null;
  }
  if (phase === 'closed') {
    return episodeId === null && reasonClass === null && readBasis === null && recoveryFrom === null
      ? {
          v: 1,
          ...(owner === 'failover' ? { owner: 'failover' as const } : {}),
          phase: 'closed',
          episodeId: null,
          updatedAt: value['updatedAt'],
          reasonClass: null,
          readBasis: null,
          recoveryFrom: null,
        }
      : null;
  }
  if (
    !isEpisodeId(episodeId)
    || !isReasonClass(reasonClass)
    || (readBasis !== 'last_known_good' && readBasis !== 'none')
  ) {
    return null;
  }
  if (phase === 'recovery_pending') {
    if (recoveryFrom !== 'onset_pending' && recoveryFrom !== 'open') return null;
  } else if (recoveryFrom !== null) {
    return null;
  }
  return {
    v: 1,
    ...(owner === 'failover' ? { owner: 'failover' as const } : {}),
    phase: phase as Exclude<EpisodePhase, 'closed'>,
    episodeId,
    updatedAt: value['updatedAt'],
    reasonClass,
    readBasis,
    recoveryFrom: recoveryFrom as 'onset_pending' | 'open' | null,
  };
}

function loadState(statePath: string, now: number, owner: EpisodeStoreOwner):
  | { status: 'available'; state: SilenceRegistryEpisodeState; missing: boolean }
  | { status: 'journal_unreadable' } {
  const label = owner === 'failover'
    ? 'silence registry episode failover state'
    : 'silence registry episode state';
  const source = readPrivateV1JournalSync(statePath, label);
  if (source.status === 'journal_unreadable') return { status: 'journal_unreadable' };
  if (source.version === 'missing') return { status: 'available', state: freshState(now, owner), missing: true };
  const state = parseState(source.value, owner);
  return state === null ? { status: 'journal_unreadable' } : { status: 'available', state, missing: false };
}

function persistState(statePath: string, state: SilenceRegistryEpisodeState, owner: EpisodeStoreOwner): boolean {
  try {
    writePrivateJournalSync(
      statePath,
      state,
      owner === 'failover' ? 'silence registry episode failover state' : 'silence registry episode state',
    );
    return true;
  } catch {
    return false;
  }
}

function isRetryDue(updatedAt: string, now: number): boolean {
  const elapsedMs = now - Date.parse(updatedAt);
  // A persisted timestamp in the future means wall time moved backward across
  // restart. Reissue once immediately and record the new local time so that
  // normal pending-rate limiting resumes instead of suppressing for an
  // unbounded clock catch-up interval.
  return elapsedMs < 0 || elapsedMs >= SILENCE_REGISTRY_EPISODE_PENDING_RETRY_MS;
}

/**
 * Small private state machine for the one control-plane incident raised when
 * fleet silence storage cannot provide a current read. It contains no rule
 * values, names, paths, or raw errors; unreadable journals are never replaced.
 *
 * When the primary journal is unreadable, a separately persisted failover
 * ledger becomes the sticky lifecycle owner. It is never reconciled back into
 * the primary: a regular-looking primary can still be stale, and writing it
 * would erase the unreadable artifact that prompted failover.
 */
interface ActiveEpisodeState {
  status: 'available';
  state: SilenceRegistryEpisodeState;
  statePath: string;
  owner: EpisodeStoreOwner;
}

type ResolvedEpisodeState = ActiveEpisodeState | { status: 'primary_unreadable' } | { status: 'journal_unreadable' };

export class SilenceRegistryEpisodeStore implements SilenceRegistryEpisodeStorePort {
  // Fields are declared and assigned rather than written as constructor
  // parameter properties: WhatSoup runs .ts directly under Node's strip-only
  // mode, which rejects parameter properties outright.
  private readonly statePath: string;
  private readonly failoverStatePath: string;

  constructor(
    statePath = silenceRegistryEpisodePath(),
    failoverStatePath = join(dirname(statePath), SILENCE_REGISTRY_EPISODE_FAILOVER_FILENAME),
  ) {
    this.statePath = statePath;
    this.failoverStatePath = failoverStatePath;
  }

  read(): SilenceRegistryEpisodeRead {
    const loaded = this.resolveState(Date.now());
    return loaded.status === 'available'
      ? { status: 'available', phase: loaded.state.phase }
      : { status: 'journal_unreadable' };
  }

  prepareOnset(
    observation: { reasonClass: SilenceStoreReasonClass; readBasis: FailureReadBasis },
    now = Date.now(),
  ): SilenceRegistryEpisodePreparation {
    return this.withLock(() => {
      const loaded = this.resolveState(now);
      if (loaded.status === 'journal_unreadable') return loaded;
      const active = loaded.status === 'primary_unreadable'
        ? {
            status: 'available' as const,
            state: freshState(now, 'failover'),
            statePath: this.failoverStatePath,
            owner: 'failover' as const,
          }
        : loaded;
      const { state } = active;
      if (state.phase === 'open' || state.phase === 'recovery_pending') {
        return { status: 'available', action: 'suppressed' };
      }
      if (state.phase === 'onset_pending' && !isRetryDue(state.updatedAt, now)) {
        return { status: 'available', action: 'suppressed' };
      }

      const episodeId = state.episodeId ?? randomUUID();
      const next: SilenceRegistryEpisodeState = {
        ...state,
        phase: 'onset_pending',
        episodeId,
        updatedAt: new Date(now).toISOString(),
        reasonClass: observation.reasonClass,
        readBasis: observation.readBasis,
        recoveryFrom: null,
      };
      if (!persistState(active.statePath, next, active.owner)) return { status: 'journal_unreadable' };
      return { status: 'available', action: 'emit_onset', episodeId };
    });
  }

  confirmOnset(episodeId: string, now = Date.now()): SilenceRegistryEpisodeSettlement {
    return this.withLock(() => {
      const loaded = this.resolveState(now);
      if (loaded.status !== 'available') return { status: 'journal_unreadable' };
      const { state } = loaded;
      if (state.phase === 'open' && state.episodeId === episodeId) {
        return { status: 'available', settled: true };
      }
      if (state.phase !== 'onset_pending' || state.episodeId !== episodeId) {
        return { status: 'available', settled: false };
      }
      const next: SilenceRegistryEpisodeState = { ...state, phase: 'open', updatedAt: new Date(now).toISOString() };
      return persistState(loaded.statePath, next, loaded.owner)
        ? { status: 'available', settled: true }
        : { status: 'journal_unreadable' };
    });
  }

  prepareRecovery(now = Date.now()): SilenceRegistryEpisodePreparation {
    return this.withLock(() => {
      const loaded = this.resolveState(now);
      if (loaded.status !== 'available') return { status: 'journal_unreadable' };
      const { state } = loaded;
      if (state.phase === 'closed') return { status: 'available', action: 'suppressed' };
      if (state.phase === 'recovery_pending' && !isRetryDue(state.updatedAt, now)) {
        return { status: 'available', action: 'suppressed' };
      }
      const recoveryFrom = state.phase === 'recovery_pending'
        ? state.recoveryFrom
        : state.phase;
      const next: SilenceRegistryEpisodeState = {
        ...state,
        phase: 'recovery_pending',
        updatedAt: new Date(now).toISOString(),
        recoveryFrom,
      };
      if (!persistState(loaded.statePath, next, loaded.owner)) return { status: 'journal_unreadable' };
      return { status: 'available', action: 'emit_recovery', episodeId: next.episodeId! };
    });
  }

  confirmRecovery(episodeId: string, now = Date.now()): SilenceRegistryEpisodeSettlement {
    return this.withLock(() => {
      const loaded = this.resolveState(now);
      if (loaded.status !== 'available') return { status: 'journal_unreadable' };
      const { state } = loaded;
      if (state.phase === 'closed') return { status: 'available', settled: true };
      if (state.phase !== 'recovery_pending' || state.episodeId !== episodeId) {
        return { status: 'available', settled: false };
      }
      return persistState(loaded.statePath, freshState(now, loaded.owner), loaded.owner)
        ? { status: 'available', settled: true }
        : { status: 'journal_unreadable' };
    });
  }

  private resolveState(now: number): ResolvedEpisodeState {
    // The sibling is authoritative once it exists, including after it reaches
    // `closed`: a primary which later appears readable may be stale. Never
    // reconcile or overwrite either source here.
    const failover = loadState(this.failoverStatePath, now, 'failover');
    if (failover.status === 'journal_unreadable') return failover;
    if (!failover.missing) {
      return {
        status: 'available',
        state: failover.state,
        statePath: this.failoverStatePath,
        owner: 'failover',
      };
    }

    const primary = loadState(this.statePath, now, 'primary');
    if (primary.status === 'journal_unreadable') return { status: 'primary_unreadable' };
    return {
      status: 'available',
      state: primary.state,
      statePath: this.statePath,
      owner: 'primary',
    };
  }

  private withLock<T>(
    operation: () => T,
  ): T | { status: 'journal_unreadable' } {
    try {
      forceEnsurePrivateDirectorySync(dirname(this.statePath), 'silence registry episode state directory');
      // One common lock serializes primary and sticky failover ownership selection.
      const lock = acquireProcessLock(`${this.statePath}.lock`, { reclaimDeadSameBoot: true });
      try {
        return operation();
      } finally {
        releaseProcessLock(lock);
      }
    } catch {
      return { status: 'journal_unreadable' };
    }
  }
}

export function createSilenceRegistryEpisodeStore(statePath?: string): SilenceRegistryEpisodeStore {
  return new SilenceRegistryEpisodeStore(statePath);
}
