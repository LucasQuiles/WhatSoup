import type { Database } from 'better-sqlite3';
import { formatDurationMs } from '../../../../src/lib/capability-grant.ts';
import { MuteSchema, type Domain, type Mute } from '../types.ts';
import type { EventStore } from './events.ts';

export interface MuteCreateInput {
  host: string;
  domain: string;
  expires_at: string;
  reason: string;
  allow_revert_suppression?: boolean;
  created_by: string;
}

export interface MuteStoreOptions {
  now?: () => Date;
  maxDurationMs?: number;
  forbiddenDomains?: readonly string[];
  allowWildcard?: boolean;
  events?: EventStore;
}

interface MuteRow {
  id: number;
  host: string;
  domain: string;
  expires_at: string;
  reason: string;
  allow_revert_suppression: number;
  created_by: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ALWAYS_FORBIDDEN_DOMAINS = ['alerting'] as const;
const EVENT_DOMAINS = new Set(['exposure', 'credential', 'capability', 'change', 'alerting']);

export class MuteStore {
  private readonly db: Database;
  private readonly options: MuteStoreOptions;

  constructor(db: Database, options: MuteStoreOptions = {}) {
    this.db = db;
    this.options = options;
  }

  create(input: MuteCreateInput): number {
    this.validateCreateInput(input);
    const createMute = this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO mutes (host, domain, expires_at, reason, allow_revert_suppression, created_by)
        VALUES (@host, @domain, @expires_at, @reason, @allow_revert_suppression, @created_by)
      `).run({
        host: input.host,
        domain: input.domain,
        expires_at: input.expires_at,
        reason: input.reason,
        allow_revert_suppression: input.allow_revert_suppression ? 1 : 0,
        created_by: input.created_by,
      });
      const id = Number(result.lastInsertRowid);
      this.appendMuteSet(id, input);
      return id;
    });
    return createMute();
  }

  listActive(nowIso: string): Mute[] {
    assertValidIso(nowIso, 'nowIso');
    return this.rowsToMutes(this.db.prepare(`
      SELECT * FROM mutes
      WHERE expires_at > ?
      ORDER BY expires_at ASC, id ASC
    `).all(nowIso) as MuteRow[]);
  }

  listExpiredSince(prevNowIso: string, nowIso: string): Mute[] {
    assertValidIso(prevNowIso, 'prevNowIso');
    assertValidIso(nowIso, 'nowIso');
    return this.rowsToMutes(this.db.prepare(`
      SELECT * FROM mutes
      WHERE expires_at > ? AND expires_at <= ?
      ORDER BY expires_at ASC, id ASC
    `).all(prevNowIso, nowIso) as MuteRow[]);
  }

  recordExpirations(prevNowIso: string, nowIso: string, events = this.options.events): Mute[] {
    const expired = this.listExpiredSince(prevNowIso, nowIso);
    for (const mute of expired) {
      events?.append({
        ts: nowIso,
        kind: 'mute_expire',
        domain: eventDomain(mute.domain),
        severity: 'info',
        scope_id: mute.host,
        payload: {
          mute_id: mute.id,
          host: mute.host,
          domain: mute.domain,
          expired_at: mute.expires_at,
        },
        alerted_to: 'none',
      });
    }
    return expired;
  }

  delete(id: number): void {
    if (!Number.isInteger(id) || id < 0) throw new Error('mute id must be a nonnegative integer');
    this.db.prepare('DELETE FROM mutes WHERE id = ?').run(id);
  }

  private validateCreateInput(input: MuteCreateInput): void {
    for (const key of ['host', 'domain', 'reason', 'created_by'] as const) {
      if (input[key].trim().length === 0) throw new Error(`mute ${key} must not be empty`);
    }
    if (!this.options.allowWildcard && (input.host === '*' || input.domain === '*')) {
      throw new Error('mute wildcard requires explicit allowWildcard option');
    }
    const forbidden = new Set([...ALWAYS_FORBIDDEN_DOMAINS, ...(this.options.forbiddenDomains ?? [])]);
    if (forbidden.has(input.domain)) throw new Error(`mute domain is forbidden: ${input.domain}`);

    const expiresAtMs = parseIso(input.expires_at, 'expires_at');
    const nowMs = (this.options.now ?? (() => new Date()))().getTime();
    if (!Number.isFinite(nowMs)) throw new Error('mute now clock is invalid');
    if (expiresAtMs <= nowMs) throw new Error('mute expires_at must be in the future');
    const maxDurationMs = this.options.maxDurationMs ?? DAY_MS;
    if (expiresAtMs - nowMs > maxDurationMs) {
      throw new Error(
        `mute duration exceeds maximum (requested ${formatDurationMs(expiresAtMs - nowMs)}, max ${formatDurationMs(maxDurationMs)})`,
      );
    }
  }

  private rowsToMutes(rows: MuteRow[]): Mute[] {
    return rows.map((row) => MuteSchema.parse({
      id: row.id,
      host: row.host,
      domain: row.domain,
      expires_at: row.expires_at,
      reason: row.reason,
      allow_revert_suppression: Boolean(row.allow_revert_suppression),
      created_by: row.created_by,
    }));
  }

  private appendMuteSet(id: number, input: MuteCreateInput): void {
    this.options.events?.append({
      ts: (this.options.now ?? (() => new Date()))().toISOString(),
      kind: 'mute_set',
      domain: eventDomain(input.domain),
      scope_id: input.host,
      payload: {
        mute_id: id,
        host: input.host,
        domain: input.domain,
        expires_at: input.expires_at,
        reason: input.reason,
        created_by: input.created_by,
      },
      alerted_to: 'none',
    });
  }
}

function eventDomain(domain: string): Domain | undefined {
  return EVENT_DOMAINS.has(domain) ? domain as Domain : undefined;
}

function assertValidIso(value: string, label: string): void {
  parseIso(value, label);
}

function parseIso(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`mute ${label} must be an ISO timestamp`);
  }
  return parsed;
}
