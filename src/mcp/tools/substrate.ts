// src/mcp/tools/substrate.ts
// 18-tool MCP surface for the durable-substrate slice (slice 1).
// Admin-gated mutations use SessionContext.actorJid (the sender), NOT deliveryJid
// (the target chat), because in groups deliveryJid is the group JID.

import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import type { Database } from '../../core/database.ts';
import { createChildLogger } from '../../logger.ts';
import type { ToolRegistry } from '../registry.ts';
import type { SessionContext } from '../types.ts';
import { resolvePhoneFromJid } from '../../core/access-list.ts';
import { isAuthenticatedSenderJid } from '../../core/jid-constants.ts';
import {
  createBead, updateBead, completeBead, cancelBead,
  approveProposal, rejectProposal, listBeads, getBead,
  assertMutableBeadFields, activityFeed,
} from '../../core/substrate/beads.ts';
import {
  createTrigger, listTriggers, pauseTrigger, extendTrigger, prepareTrigger,
} from '../../core/substrate/triggers.ts';
import {
  captureObservation, forgetObservation, mergeEntities,
  getProfile, listEntities, addAlias, resolveEntityRef,
} from '../../core/substrate/entities.ts';
import { errorResult } from '../types.ts';
import { nowUnixSec } from '../../core/substrate/time.ts';
import type { EntityRef, TriggerKind } from '../../core/substrate/types.ts';
import { regenerateVault, projectBead, projectEntity, removeEntityProjection } from '../../core/substrate/vault.ts';

const log = createChildLogger('mcp:substrate');

export interface SubstrateDeps {
  db: DatabaseSync;
  /**
   * Database wrapper — required for LID→phone resolution in admin gating.
   * `@lid` JIDs must be translated through `lid_mappings` before being
   * compared against `adminPhones`; bare-regex digit extraction silently
   * fails the admin gate for LID-form callers before their LID mapping
   * is resolved.
   */
  dbWrapper: Database;
  adminPhones: Set<string>;
  /**
   * Gate for `poll.url` watches (F2 Slice B). Defaults OFF — a `create_watch`
   * with `source:'poll.url'` THROWS at creation (never persists) unless an
   * operator explicitly sets `advanced.enableUrlWatch: true` in instance
   * config. Mirrors `advanced.enableRelayMessage`/`enableResync`. The poller
   * re-guards at exec time so a row persisted while ON still fails closed if
   * the flag is later turned OFF.
   */
  enableUrlWatch?: boolean;
  memory: {
    adminJid: string;
    vaultPath: string;
    observationConfidenceMin: number;
    sweep: { beadProposeMin: number; beadUpdateMin: number; lookbackHours: number; reviewByDays: number };
    watchTtl: { defaultHours: number; maxHours: number };
  };
}

function actorPhone(deps: SubstrateDeps, session: SessionContext): string | null {
  const jid = session.actorJid ?? '';
  if (!jid) return null;
  // Route through resolvePhoneFromJid so `@lid` senders map to their real phone
  // number before admin comparison. For `@s.whatsapp.net` JIDs this is a cheap
  // direct extraction; for `@lid` JIDs it consults `lid_mappings`. An unresolved
  // LID falls back to the raw LID number — that won't match an admin phone, so
  // the gate still fails closed.
  try {
    return resolvePhoneFromJid(jid, deps.dbWrapper);
  } catch {
    return null;
  }
}

function assertAdmin(deps: SubstrateDeps, session: SessionContext): void {
  if (!session.actorJid) {
    throw new Error(
      'admin-only tool: session has no actorJid — the runtime must populate actorJid from the sender before dispatching admin-gated tools',
    );
  }
  // QR-143: only WhatsApp-authenticated actors (@s.whatsapp.net/@lid) may be admin.
  // A non-authenticated transport (e.g. @sms) resolves to the SAME bare phone as a
  // WhatsApp admin, but its sender-ID is spoofable — gate on the transport BEFORE
  // the adminPhones match so a spoofed SMS cannot reach admin-gated MCP tools.
  if (!isAuthenticatedSenderJid(session.actorJid)) {
    throw new Error(
      `admin-only tool: actor "${session.actorJid}" is on a non-WhatsApp-authenticated transport and cannot be an admin`,
    );
  }
  const phone = actorPhone(deps, session);
  if (!phone || !deps.adminPhones.has(phone)) {
    throw new Error(
      `admin-only tool: caller phone "${phone ?? 'unresolved'}" is not on the instance admin list`,
    );
  }
}

/**
 * Boolean form of the admin gate for the registry's central sensitive-tool
 * authorizer (R1). Same predicate as assertAdmin — fail-closed on missing
 * actors, non-WhatsApp transports, and unlisted phones.
 */
export function isAdminActor(deps: SubstrateDeps, session: SessionContext): boolean {
  try {
    assertAdmin(deps, session);
    return true;
  } catch (err) {
    // The central gate replies uniformly (non-disclosing) to the caller, so
    // the specific reason (missing LID mapping, non-WhatsApp transport,
    // unlisted phone) would otherwise vanish — an admin lockout must stay
    // diagnosable server-side (F06). Log the actor + cause, deny.
    log.info(
      { actorJid: session.actorJid ?? null, reason: err instanceof Error ? err.message : String(err) },
      'admin predicate denied',
    );
    return false;
  }
}

function projectBeadQuietly(deps: SubstrateDeps, beadId: number): void {
  try {
    projectBead(deps.db, { vaultPath: deps.memory.vaultPath, beadId });
  } catch (err) {
    log.warn({ err, beadId }, 'substrate vault projection failed for bead');
  }
}

function projectEntityQuietly(deps: SubstrateDeps, entityId: number): void {
  try {
    projectEntity(deps.db, { vaultPath: deps.memory.vaultPath, entityId });
  } catch (err) {
    log.warn({ err, entityId }, 'substrate vault projection failed for entity');
  }
}

function removeEntityProjectionQuietly(deps: SubstrateDeps, entityId: number): void {
  try {
    removeEntityProjection(deps.db, { vaultPath: deps.memory.vaultPath, entityId });
  } catch (err) {
    log.warn({ err, entityId }, 'substrate vault projection cleanup failed for entity');
  }
}

function projectObservationEntityQuietly(deps: SubstrateDeps, observationId: number): void {
  const row = deps.db.prepare(
    `SELECT entity_id FROM entity_observations WHERE id = ?`
  ).get(observationId) as { entity_id: number } | undefined;
  if (row) projectEntityQuietly(deps, row.entity_id);
}

const EntityRefSchema = z.object({
  entity_id: z.number().int().positive().optional(),
  contact_jid: z.string().optional(),
  group_jid: z.string().optional(),
  canonical_name: z.string().optional(),
  kind: z.enum(['person','org','project','place','topic','other']).optional(),
});

function toEntityRef(r: z.infer<typeof EntityRefSchema>): EntityRef {
  return {
    entityId: r.entity_id,
    contactJid: r.contact_jid,
    groupJid: r.group_jid,
    canonicalName: r.canonical_name,
    kind: r.kind,
  };
}

export function registerSubstrateTools(registry: ToolRegistry, deps: SubstrateDeps): void {
  // R1: the central sensitive-tool gate rides the same admin predicate as
  // the in-handler assertAdmin checks below (which remain as defense in
  // depth).
  registry.setSensitiveToolAuthorizer((session) => isAdminActor(deps, session));

  registry.register({
    name: 'create_agent_job',
    sensitive: true,
    description: 'Create an agent_job bead + schedule trigger. Admin only.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'unsafe',
    schema: z.object({
      prompt: z.string().min(1),
      title: z.string().optional(),
      schedule: z.object({
        kind: z.enum(['schedule.cron', 'schedule.at_time']),
        expr: z.string().optional(),
        // No upper bound here by design: fire_at is unit-ambiguous
        // (epoch-seconds vs. epoch-milliseconds) at the shape level, and
        // that ambiguity is resolved once, centrally, in
        // triggers.ts:normalizeFireAtSeconds (called from computeNextFireAt)
        // so every current and future creation path gets the same
        // enforcement point rather than duplicating a ceiling per caller
        // (#1757).
        fire_at: z.number().int().positive().optional(),
        tz: z.string().optional(),
      }),
      report_chat: z.string(),
      terminal_at: z.number().int().positive().optional(),
      metadata: z.record(z.unknown()).optional(),
    }),
    handler: async (raw, session) => {
      assertAdmin(deps, session);
      const p = raw as {
        prompt: string; title?: string;
        schedule: { kind: 'schedule.cron' | 'schedule.at_time'; expr?: string; fire_at?: number; tz?: string };
        report_chat: string; terminal_at?: number; metadata?: Record<string, unknown>;
      };
      const spec = p.schedule.kind === 'schedule.cron'
        ? { expr: p.schedule.expr, tz: p.schedule.tz }
        : { fire_at: p.schedule.fire_at };
      const triggerArgs = {
        beadId: 0,
        kind: p.schedule.kind as TriggerKind,
        spec,
        reportChatJid: p.report_chat,
        requestedTerminalAt: p.terminal_at ?? null,
        actor: 'user',
      };
      prepareTrigger(triggerArgs);
      const bead = createBead(deps.db, {
        kind: 'agent_job',
        title: p.title ?? p.prompt.slice(0, 80),
        body: p.prompt,
        ownerJid: deps.memory.adminJid,
        metadata: p.metadata,
        actor: 'user',
      });
      const trigger = createTrigger(deps.db, { ...triggerArgs, beadId: bead.id });
      projectBeadQuietly(deps, bead.id);
      return { bead_id: bead.id, trigger_id: trigger.id };
    },
  });

  registry.register({
    name: 'create_watch',
    sensitive: true,
    description: 'Create a watch bead + poll trigger. Admin only. TTL defaults to config.memory.watchTtl.defaultHours; clamped to maxHours. Wired kinds: poll.sqlite, poll.pinecone, poll.file, poll.url (gated behind advanced.enableUrlWatch, default OFF — rejected at creation when disabled), and schedule.*. poll.email is accepted and persisted but no-op until its executor is wired. event.message is accepted and persisted but is a reserved scaffold (next_fire_at=NULL, never polled) pending a future ingest path. poll.shell is removed from creation (not in this enum; retained internally only for legacy fail-closed handling).',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'unsafe',
    schema: z.object({
      title: z.string().optional(),
      // poll.shell removed from creation (F2 Slice B): not in this enum so
      // creation fails loudly via Zod rather than persisting a dead row. The
      // kind is retained internally (types/SPEC_REGISTRY) only for legacy
      // fail-closed handling of rows persisted before removal.
      source: z.enum(['poll.email','poll.url','poll.file','poll.sqlite','poll.pinecone','event.message']),
      criteria: z.record(z.unknown()),
      interval_seconds: z.number().int().positive().optional(),
      ttl_hours: z.number().positive().optional(),
      report_chat: z.string(),
      on_terminal: z.enum(['notify','silent','reopen_bead']).optional(),
      dedupe_key: z.string().optional(),
    }),
    handler: async (raw, session) => {
      assertAdmin(deps, session);
      const p = raw as {
        title?: string;
        source: TriggerKind;
        criteria: Record<string, unknown>;
        interval_seconds?: number; ttl_hours?: number;
        report_chat: string;
        on_terminal?: 'notify' | 'silent' | 'reopen_bead';
        dedupe_key?: string;
      };
      // poll.url is gated default-OFF (F2 Slice B). Throw BEFORE any bead/trigger
      // is created so a disabled url watch never persists, mirroring the
      // relay_message disabled path. The poller also re-guards at exec time.
      if (p.source === 'poll.url' && !deps.enableUrlWatch) {
        log.warn({ source: p.source }, 'create_watch rejected: url watch is disabled');
        throw new Error('url watch is disabled. Set advanced.enableUrlWatch: true in instance config to enable poll.url watches.');
      }
      const now = nowUnixSec();
      const ttlHours = Math.min(p.ttl_hours ?? deps.memory.watchTtl.defaultHours, deps.memory.watchTtl.maxHours);
      const requestedTerminalAt = now + Math.round(ttlHours * 3600);
      const triggerArgs = {
        beadId: 0,
        kind: p.source,
        spec: p.criteria,
        reportChatJid: p.report_chat,
        intervalSeconds: p.interval_seconds ?? null,
        requestedTerminalAt,
        maxTtlHours: deps.memory.watchTtl.maxHours,
        onTerminal: p.on_terminal,
        dedupeKey: p.dedupe_key,
        actor: 'user',
      };
      prepareTrigger(triggerArgs);
      const bead = createBead(deps.db, {
        kind: 'watch',
        title: p.title ?? `watch:${p.source}`,
        ownerJid: deps.memory.adminJid,
        actor: 'user',
      });
      const trigger = createTrigger(deps.db, { ...triggerArgs, beadId: bead.id });
      projectBeadQuietly(deps, bead.id);
      return { bead_id: bead.id, trigger_id: trigger.id, terminal_at: trigger.terminal_at };
    },
  });

  registry.register({
    name: 'regenerate_vault',
    sensitive: true,
    description: 'Regenerate the Obsidian vault projection from current substrate state. Admin only.',
    scope: 'global',
    targetMode: 'caller-supplied',
    replayPolicy: 'unsafe',
    schema: z.object({}),
    handler: async (_raw, session) => {
      assertAdmin(deps, session);
      return regenerateVault(deps.db, { vaultPath: deps.memory.vaultPath });
    },
  });

  registry.register({
    name: 'capture_task',
    sensitive: true,
    description: 'Create a task bead (no trigger). Admin only.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'unsafe',
    schema: z.object({
      title: z.string().min(1),
      body: z.string().optional(),
      due_at: z.number().int().positive().optional(),
      priority: z.number().int().min(-2).max(2).optional(),
      chat_source_pk: z.number().int().positive().optional(),
      chat_jid: z.string().optional(),
      owner_jid: z.string().optional(),
    }),
    handler: async (raw, session) => {
      assertAdmin(deps, session);
      const p = raw as {
        title: string; body?: string; due_at?: number; priority?: number;
        chat_source_pk?: number; chat_jid?: string; owner_jid?: string;
      };
      const bead = createBead(deps.db, {
        kind: 'task',
        title: p.title, body: p.body ?? null,
        ownerJid: p.owner_jid ?? deps.memory.adminJid,
        chatJid: p.chat_jid ?? null,
        sourceMessagePk: p.chat_source_pk ?? null,
        dueAt: p.due_at ?? null,
        priority: p.priority ?? 0,
        actor: 'user',
      });
      projectBeadQuietly(deps, bead.id);
      return { bead_id: bead.id };
    },
  });

  registry.register({
    name: 'capture_observation',
    sensitive: true,
    description: 'Append an entity observation. Append/supersede semantics — never mutates existing rows. Admin only.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'unsafe',
    schema: z.object({
      entity_ref: EntityRefSchema,
      // Observation kinds are a closed whitelist that mirrors the DB CHECK
      // constraint on entity_observations.kind. Keeping these aligned at the
      // MCP layer gives callers a clear validation error instead of an opaque
      // SQLite CHECK failure at write time.
      kind: z.enum(['preference','fact','relation','status','contact_info','note','other']),
      text: z.string().min(1),
      confidence: z.number().min(0).max(1),
      source_message_pk: z.number().int().positive().optional(),
      supersedes_observation_id: z.number().int().positive().optional(),
      metadata: z.record(z.unknown()).optional(),
    }),
    handler: async (raw, session) => {
      assertAdmin(deps, session);
      const p = raw as {
        entity_ref: z.infer<typeof EntityRefSchema>;
        kind: 'preference'|'fact'|'relation'|'status'|'contact_info'|'note'|'other';
        text: string; confidence: number;
        source_message_pk?: number; supersedes_observation_id?: number;
        metadata?: Record<string, unknown>;
      };
      if (p.confidence < deps.memory.observationConfidenceMin) {
        return { skipped: true, reason: `confidence < observation_confidence_min (${deps.memory.observationConfidenceMin})` };
      }
      const o = captureObservation(deps.db, {
        entityRef: toEntityRef(p.entity_ref),
        kind: p.kind, text: p.text, confidence: p.confidence,
        sourceMessagePk: p.source_message_pk ?? null,
        sourceKind: 'manual',
        supersedesObservationId: p.supersedes_observation_id ?? null,
        metadata: p.metadata,
      });
      projectEntityQuietly(deps, o.entity_id);
      return { observation_id: o.id, entity_id: o.entity_id };
    },
  });

  registry.register({
    name: 'list_beads',
    description: 'List beads with optional filters. review_overdue surfaces status=proposed beads whose review_by_at deadline has passed (#1773) and overrides any status filter with the hardcoded proposed predicate.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'read_only',
    schema: z.object({
      owner_jid: z.string().optional(),
      kind: z.enum(['task','project','observation','agent_job','watch']).optional(),
      status: z.enum(['active','proposed','paused','completed','cancelled','failed']).optional(),
      chat_jid: z.string().optional(),
      due_before: z.number().int().positive().optional(),
      since: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(500).optional(),
      review_overdue: z.boolean().optional(),
    }),
    handler: async (raw) => {
      const p = raw as {
        owner_jid?: string;
        kind?: 'task' | 'project' | 'observation' | 'agent_job' | 'watch';
        status?: 'active' | 'proposed' | 'paused' | 'completed' | 'cancelled' | 'failed';
        chat_jid?: string; due_before?: number; since?: number; limit?: number;
        review_overdue?: boolean;
      };
      return { beads: listBeads(deps.db, {
        ownerJid: p.owner_jid, kind: p.kind, status: p.status, chatJid: p.chat_jid,
        dueBefore: p.due_before, since: p.since, limit: p.limit,
        reviewOverdue: p.review_overdue,
      }) };
    },
  });

  registry.register({
    name: 'get_activity',
    description: 'Return a unified durable-memory timeline of bead events and live entity observations, newest first. Optionally owner-scoped; live-view only (superseded/forgotten observations excluded). Read only.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'read_only',
    schema: z.object({
      owner_jid: z.string().optional(),
      since: z.number().int().positive().optional(),
      limit: z.number().int().positive().max(500).optional(),
    }),
    handler: async (raw) => {
      const p = raw as { owner_jid?: string; since?: number; limit?: number };
      return { activity: activityFeed(deps.db, {
        ownerJid: p.owner_jid, since: p.since, limit: p.limit,
      }) };
    },
  });

  registry.register({
    name: 'get_bead',
    description: 'Return a bead and its recent events.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'read_only',
    schema: z.object({ id: z.number().int().positive() }),
    handler: async (raw) => {
      const p = raw as { id: number };
      const r = getBead(deps.db, p.id);
      if (!r) return { bead: null };
      return { bead: r.bead, events: r.events };
    },
  });

  registry.register({
    name: 'update_bead',
    sensitive: true,
    description: 'Update title/body/due_at/priority/metadata on a bead. Cannot change kind/owner/status. Admin only.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'unsafe',
    schema: z.object({
      id: z.number().int().positive(),
      fields: z.object({
        title: z.string().optional(),
        body: z.string().optional(),
        due_at: z.number().int().positive().optional(),
        priority: z.number().int().min(-2).max(2).optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    }),
    handler: async (raw, session) => {
      assertAdmin(deps, session);
      const p = raw as { id: number; fields: Record<string, unknown> };
      updateBead(deps.db, p.id, { fields: p.fields as never, actor: 'user' });
      projectBeadQuietly(deps, p.id);
      return { ok: true };
    },
  });

  registry.register({
    name: 'complete_bead',
    sensitive: true,
    description: 'Transition a bead to completed. Admin only.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'unsafe',
    schema: z.object({ id: z.number().int().positive(), note: z.string().optional() }),
    handler: async (raw, session) => {
      assertAdmin(deps, session);
      const p = raw as { id: number; note?: string };
      completeBead(deps.db, p.id, { actor: 'user', note: p.note });
      projectBeadQuietly(deps, p.id);
      return { ok: true };
    },
  });

  registry.register({
    name: 'cancel_bead',
    sensitive: true,
    description: 'Transition a bead to cancelled. Admin only.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'unsafe',
    schema: z.object({ id: z.number().int().positive(), reason: z.string().optional() }),
    handler: async (raw, session) => {
      assertAdmin(deps, session);
      const p = raw as { id: number; reason?: string };
      cancelBead(deps.db, p.id, { actor: 'user', reason: p.reason });
      projectBeadQuietly(deps, p.id);
      return { ok: true };
    },
  });

  registry.register({
    name: 'approve_proposal',
    sensitive: true,
    description: 'Promote status=proposed bead to active. Admin only.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'unsafe',
    schema: z.object({ id: z.number().int().positive(), overrides: z.record(z.unknown()).optional() }),
    handler: async (raw, session) => {
      assertAdmin(deps, session);
      const p = raw as { id: number; overrides?: Record<string, unknown> };
      if (p.overrides) assertMutableBeadFields(p.overrides);
      approveProposal(deps.db, p.id, { actor: 'user' });
      if (p.overrides) updateBead(deps.db, p.id, { fields: p.overrides as never, actor: 'user' });
      projectBeadQuietly(deps, p.id);
      return { ok: true };
    },
  });

  registry.register({
    name: 'reject_proposal',
    sensitive: true,
    description: 'Cancel status=proposed bead with rejection reason. Admin only.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'unsafe',
    schema: z.object({ id: z.number().int().positive(), reason: z.string().optional() }),
    handler: async (raw, session) => {
      assertAdmin(deps, session);
      const p = raw as { id: number; reason?: string };
      rejectProposal(deps.db, p.id, { actor: 'user', reason: p.reason });
      projectBeadQuietly(deps, p.id);
      return { ok: true };
    },
  });

  registry.register({
    name: 'list_triggers',
    description: 'List triggers, optionally filtered.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'read_only',
    schema: z.object({
      bead_id: z.number().int().positive().optional(),
      kind: z.string().optional(),
      status: z.enum(['active','paused','expired','cancelled']).optional(),
    }),
    handler: async (raw) => {
      const p = raw as { bead_id?: number; kind?: string; status?: 'active'|'paused'|'expired'|'cancelled' };
      return { triggers: listTriggers(deps.db, { beadId: p.bead_id, kind: p.kind as TriggerKind | undefined, status: p.status }) };
    },
  });

  registry.register({
    name: 'pause_trigger',
    sensitive: true,
    description: 'Pause a trigger. Admin only.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'unsafe',
    schema: z.object({ id: z.number().int().positive() }),
    handler: async (raw, session) => {
      assertAdmin(deps, session);
      const p = raw as { id: number };
      pauseTrigger(deps.db, p.id, { actor: 'user' });
      return { ok: true };
    },
  });

  registry.register({
    name: 'extend_trigger',
    sensitive: true,
    description: 'Push trigger terminal_at forward (clamped to policy max). Admin only.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'unsafe',
    schema: z.object({ id: z.number().int().positive(), until: z.number().int().positive() }),
    handler: async (raw, session) => {
      assertAdmin(deps, session);
      const p = raw as { id: number; until: number };
      extendTrigger(deps.db, p.id, { until: p.until, maxTtlHours: deps.memory.watchTtl.maxHours, actor: 'user' });
      return { ok: true };
    },
  });

  registry.register({
    name: 'get_profile',
    description: 'Return entity + aliases + live observations + linked beads.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'read_only',
    schema: z.object({ entity_ref: EntityRefSchema }),
    handler: async (raw) => {
      const p = raw as { entity_ref: z.infer<typeof EntityRefSchema> };
      const profile = getProfile(deps.db, toEntityRef(p.entity_ref));
      if (!profile) return { profile: null };
      return profile;
    },
  });

  registry.register({
    name: 'list_entities',
    description: 'List entities with optional kind/text_match filter.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'read_only',
    schema: z.object({
      kind: z.enum(['person','org','project','place','topic','other']).optional(),
      text_match: z.string().optional(),
      limit: z.number().int().positive().max(500).optional(),
    }),
    handler: async (raw) => {
      const p = raw as { kind?: 'person'|'org'|'project'|'place'|'topic'|'other'; text_match?: string; limit?: number };
      return { entities: listEntities(deps.db, { kind: p.kind, textMatch: p.text_match, limit: p.limit }) };
    },
  });

  registry.register({
    name: 'add_alias',
    sensitive: true,
    description: 'Add an alias (display_name/handle/email/phone/url/nickname/other) to an entity — the write-half of the aliases surface read by get_profile. Duplicate (entity, alias, kind) rows are ignored. Admin only.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'unsafe',
    schema: z.object({
      entity_ref: EntityRefSchema,
      alias: z.string().min(1),
      // Alias kinds mirror the DB CHECK constraint on entity_aliases.alias_kind
      // and the AliasKind union, so callers get a clear validation error at the
      // MCP layer instead of an opaque SQLite CHECK failure at write time.
      alias_kind: z.enum(['display_name','handle','email','phone','url','nickname','other']),
      source: z.string().optional(),
    }),
    handler: async (raw, session) => {
      assertAdmin(deps, session);
      const p = raw as {
        entity_ref: z.infer<typeof EntityRefSchema>;
        alias: string;
        alias_kind: 'display_name'|'handle'|'email'|'phone'|'url'|'nickname'|'other';
        source?: string;
      };
      // addAlias keys on entity_id, so the caller-supplied ref must resolve to a
      // live entity first. A missing ref is a soft error (toolError envelope),
      // mirroring the read tools that return null for unknown entities rather
      // than throwing.
      const entity = resolveEntityRef(deps.db, toEntityRef(p.entity_ref));
      if (!entity) return errorResult('entity not found for the supplied entity_ref');
      addAlias(deps.db, { entityId: entity.id, alias: p.alias, aliasKind: p.alias_kind, source: p.source });
      projectEntityQuietly(deps, entity.id);
      return { entity_id: entity.id, alias: p.alias, alias_kind: p.alias_kind };
    },
  });

  registry.register({
    name: 'merge_entities',
    sensitive: true,
    description: 'Merge entity A into B; non-destructive. Admin only.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'unsafe',
    schema: z.object({ from_id: z.number().int().positive(), into_id: z.number().int().positive() }),
    handler: async (raw, session) => {
      assertAdmin(deps, session);
      const p = raw as { from_id: number; into_id: number };
      mergeEntities(deps.db, { fromId: p.from_id, intoId: p.into_id });
      removeEntityProjectionQuietly(deps, p.from_id);
      projectEntityQuietly(deps, p.into_id);
      return { ok: true };
    },
  });

  registry.register({
    name: 'forget_observation',
    sensitive: true,
    description: 'Tombstone an observation (forgotten=1 with reason). Admin only.',
    scope: 'global', targetMode: 'caller-supplied', replayPolicy: 'unsafe',
    schema: z.object({ id: z.number().int().positive(), reason: z.string().min(1) }),
    handler: async (raw, session) => {
      assertAdmin(deps, session);
      const p = raw as { id: number; reason: string };
      forgetObservation(deps.db, p.id, p.reason);
      projectObservationEntityQuietly(deps, p.id);
      return { ok: true };
    },
  });
}
