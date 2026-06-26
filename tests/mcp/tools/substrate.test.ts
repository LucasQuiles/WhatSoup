import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { registerSubstrateTools } from '../../../src/mcp/tools/substrate.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import { createBead, getBead } from '../../../src/core/substrate/beads.ts';
import { captureObservation, upsertEntity } from '../../../src/core/substrate/entities.ts';

function tmpFile() { return join(tmpdir(), `sub-${randomBytes(8).toString('hex')}.db`); }
function tmpDir() { return join(tmpdir(), `sub-vault-${randomBytes(8).toString('hex')}`); }

const EXPECTED_TOOLS = [
  'create_agent_job', 'create_watch', 'capture_task', 'capture_observation',
  'list_beads', 'get_bead', 'update_bead', 'complete_bead', 'cancel_bead',
  'approve_proposal', 'reject_proposal',
  'list_triggers', 'pause_trigger', 'extend_trigger',
  'get_profile', 'list_entities', 'add_alias', 'merge_entities', 'forget_observation',
  'regenerate_vault',
];

const adminPhone = 'admin-user';
const adminActor = `${adminPhone}@s.whatsapp.net`;
const guestActor = 'guest-user@s.whatsapp.net';

const adminSession: SessionContext = { tier: 'global', actorJid: adminActor };
const guestSession: SessionContext = { tier: 'global', actorJid: guestActor };

// Helper: parse the single-content-block JSON payload that registry.call() returns.
function parseResult(r: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  if (r.isError) throw new Error(r.content[0]?.text ?? 'tool error');
  return JSON.parse(r.content[0].text);
}

function registerDefaultTools(
  registry: ToolRegistry,
  db: Database,
  vaultPath: string,
  overrides: {
    dbWrapper?: Database;
    observationConfidenceMin?: number;
    enableUrlWatch?: boolean;
  } = {},
) {
  registerSubstrateTools(registry, {
    db: db.raw,
    dbWrapper: overrides.dbWrapper ?? db,
    adminPhones: new Set<string>([adminPhone]),
    enableUrlWatch: overrides.enableUrlWatch ?? false,
    memory: {
      adminJid: adminPhone,
      vaultPath,
      observationConfidenceMin: overrides.observationConfidenceMin ?? 0.4,
      sweep: { beadProposeMin: 0.55, beadUpdateMin: 0.8, lookbackHours: 48, reviewByDays: 7 },
      watchTtl: { defaultHours: 24, maxHours: 72 },
    },
  });
}

describe('substrate MCP tools', () => {
  let dbPath: string; let vaultPath: string; let db: Database; let registry: ToolRegistry;

  beforeEach(() => {
    dbPath = tmpFile();
    vaultPath = tmpDir();
    db = new Database(dbPath); db.open();
    registry = new ToolRegistry();
    registerDefaultTools(registry, db, vaultPath);
  });
  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(vaultPath)) rmSync(vaultPath, { recursive: true, force: true });
  });

  it('registers all 20 tools', () => {
    const names = registry.listTools(adminSession).map(t => t.name);
    for (const name of EXPECTED_TOOLS) expect(names).toContain(name);
  });

  it('guest (non-admin actorJid) is rejected on capture_task', async () => {
    const res = await registry.call('capture_task', { title: 'x' }, guestSession);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/admin/i);
  });

  it('regenerate_vault is admin gated', async () => {
    const res = await registry.call('regenerate_vault', {}, guestSession);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/admin/i);
  });

  it('missing actorJid is rejected on capture_task with actionable error', async () => {
    const res = await registry.call('capture_task', { title: 'x' }, { tier: 'global' });
    expect(res.isError).toBe(true);
    // The error must distinguish "no actorJid" from "wrong actor".
    expect(res.content[0].text).toMatch(/no actorJid|must populate actorJid/i);
  });

  it('resolves @lid actorJid through lid_mappings for admin check', async () => {
    // Seed a lid_mapping row that maps an @lid value to the admin's phone JID.
    // When an admin sends from @lid, resolvePhoneFromJid should translate it
    // to the phone digits, and the admin gate should pass.
    // lid_mappings.lid is the bare LID number (no @lid suffix); phone_jid is
    // the full personal JID.  resolveLid strips the @domain before querying.
    db.raw.prepare(
      `INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)`
    ).run('admin-lid', `${adminPhone}@s.whatsapp.net`);
    const lidSession: SessionContext = { tier: 'global', actorJid: 'admin-lid@lid' };
    const res = parseResult(await registry.call('capture_task', { title: 'via @lid' }, lidSession));
    expect(res.bead_id).toBeGreaterThan(0);
  });

  it('rejects unresolved @lid actorJid (admin gate fails closed on LID miss)', async () => {
    // Raw @lid number with no lid_mappings row — resolvePhoneFromJid returns
    // the LID number as fallback, which is NOT on the admin list → reject.
    const lidSession: SessionContext = { tier: 'global', actorJid: 'missing-lid@lid' };
    const res = await registry.call('capture_task', { title: 'x' }, lidSession);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not on the instance admin list/i);
  });

  it('fails closed when LID admin resolution throws', async () => {
    const throwingWrapper = {
      raw: {
        prepare: () => {
          throw new Error('lid resolver unavailable');
        },
      },
    } as unknown as Database;
    const gatedRegistry = new ToolRegistry();
    registerDefaultTools(gatedRegistry, db, vaultPath, { dbWrapper: throwingWrapper });

    const res = await gatedRegistry.call(
      'capture_task',
      { title: 'blocked by resolver failure' },
      { tier: 'global', actorJid: 'admin-lid@lid' },
    );

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('caller phone "unresolved"');
  });

  it('capture_task round-trip', async () => {
    const res = parseResult(await registry.call('capture_task', { title: 'test task' }, adminSession));
    expect(res.bead_id).toBeGreaterThan(0);
    const list = parseResult(await registry.call('list_beads', { owner_jid: adminPhone }, adminSession));
    expect(list.beads.map((b: { title: string }) => b.title)).toContain('test task');
  });

  it('regenerate_vault projects existing beads and entities', async () => {
    const task = createBead(db.raw, {
      kind: 'task',
      title: 'vault task',
      ownerJid: adminPhone,
      actor: 'test',
    });
    const entity = upsertEntity(db.raw, { canonicalName: 'Alex', kind: 'person' });
    captureObservation(db.raw, {
      entityRef: { entityId: entity.id },
      kind: 'fact',
      text: 'prefers morning reviews',
      confidence: 0.9,
      sourceKind: 'manual',
    });
    expect(existsSync(join(vaultPath, 'Profiles/person', 'Alex.md'))).toBe(false);

    const res = parseResult(await registry.call('regenerate_vault', {}, adminSession));

    expect(res).toEqual({ beads: 1, entities: 1 });
    expect(existsSync(join(vaultPath, 'Beads/active', `task-${task.id}.md`))).toBe(true);
    expect(existsSync(join(vaultPath, 'Profiles/person', 'Alex.md'))).toBe(true);
  });

  it('capture_task projects the created bead', async () => {
    const res = parseResult(await registry.call('capture_task', { title: 'project now' }, adminSession));
    const file = join(vaultPath, 'Beads/active', `task-${res.bead_id}.md`);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('# project now');
  });

  it('contains bead projection failures without failing the mutation', async () => {
    const blockedVaultPath = tmpFile();
    writeFileSync(blockedVaultPath, 'not a directory');
    const blockedRegistry = new ToolRegistry();
    registerDefaultTools(blockedRegistry, db, blockedVaultPath);

    try {
      const res = parseResult(await blockedRegistry.call('capture_task', { title: 'project later' }, adminSession));

      expect(res.bead_id).toBeGreaterThan(0);
      expect(getBead(db.raw, res.bead_id)?.bead.title).toBe('project later');
    } finally {
      if (existsSync(blockedVaultPath)) unlinkSync(blockedVaultPath);
    }
  });

  it('complete_bead moves the projected bead to completed', async () => {
    const res = parseResult(await registry.call('capture_task', { title: 'finish me' }, adminSession));
    const activeFile = join(vaultPath, 'Beads/active', `task-${res.bead_id}.md`);
    expect(existsSync(activeFile)).toBe(true);

    await registry.call('complete_bead', { id: res.bead_id, note: 'done' }, adminSession);

    expect(existsSync(join(vaultPath, 'Beads/completed', `task-${res.bead_id}.md`))).toBe(true);
    expect(existsSync(activeFile)).toBe(false);
  });

  it('update_bead rewrites the projected bead', async () => {
    const res = parseResult(await registry.call('capture_task', { title: 'old title' }, adminSession));
    const file = join(vaultPath, 'Beads/active', `task-${res.bead_id}.md`);

    await registry.call('update_bead', { id: res.bead_id, fields: { title: 'new title' } }, adminSession);

    expect(readFileSync(file, 'utf8')).toContain('# new title');
    expect(readFileSync(file, 'utf8')).not.toContain('# old title');
  });

  it('cancel_bead moves the projected bead to cancelled', async () => {
    const res = parseResult(await registry.call('capture_task', { title: 'cancel me' }, adminSession));
    const activeFile = join(vaultPath, 'Beads/active', `task-${res.bead_id}.md`);

    await registry.call('cancel_bead', { id: res.bead_id, reason: 'duplicate' }, adminSession);

    expect(existsSync(join(vaultPath, 'Beads/cancelled', `task-${res.bead_id}.md`))).toBe(true);
    expect(existsSync(activeFile)).toBe(false);
  });

  it('create_agent_job + list_triggers + pause_trigger', async () => {
    const res = parseResult(await registry.call('create_agent_job', {
      prompt: 'daily digest',
      schedule: { kind: 'schedule.cron', expr: '0 8 * * *' },
      report_chat: 'digest-report@s.whatsapp.net',
    }, adminSession));
    expect(res.trigger_id).toBeGreaterThan(0);
    const triggers = parseResult(await registry.call('list_triggers', { bead_id: res.bead_id }, adminSession));
    expect(triggers.triggers[0].status).toBe('active');
    await registry.call('pause_trigger', { id: res.trigger_id }, adminSession);
    const after = parseResult(await registry.call('list_triggers', { bead_id: res.bead_id }, adminSession));
    expect(after.triggers[0].status).toBe('paused');
  });

  it('create_agent_job supports one-shot at-time schedules', async () => {
    const fireAt = Math.floor(Date.now() / 1000) + 3600;

    const res = parseResult(await registry.call('create_agent_job', {
      prompt: 'one-shot digest',
      schedule: { kind: 'schedule.at_time', fire_at: fireAt },
      report_chat: 'report-chat@s.whatsapp.net',
    }, adminSession));

    const triggers = parseResult(await registry.call('list_triggers', { bead_id: res.bead_id }, adminSession));
    expect(triggers.triggers[0]).toMatchObject({
      id: res.trigger_id,
      kind: 'schedule.at_time',
      next_fire_at: fireAt,
    });
    expect(JSON.parse(triggers.triggers[0].spec_json)).toEqual({ fire_at: fireAt });
  });

  it('create_agent_job rejects invalid trigger input without leaving a bead', async () => {
    const res = await registry.call('create_agent_job', {
      prompt: 'daily digest',
      schedule: { kind: 'schedule.cron' },
      report_chat: 'digest-report@s.whatsapp.net',
    }, adminSession);

    expect(res.isError).toBe(true);
    const beads = parseResult(await registry.call('list_beads', { owner_jid: adminPhone }, adminSession));
    const triggers = parseResult(await registry.call('list_triggers', {}, adminSession));
    expect(beads.beads).toEqual([]);
    expect(triggers.triggers).toEqual([]);
  });

  it('create_watch clamps TTL to max', async () => {
    const now = Math.floor(Date.now() / 1000);
    const res = parseResult(await registry.call('create_watch', {
      source: 'poll.email',
      criteria: { source: 'gmail', sender: 'sender-example-invalid' },
      report_chat: 'test@s.whatsapp.net',
      ttl_hours: 200,
    }, adminSession));
    expect(res.terminal_at - now).toBeLessThanOrEqual(72 * 3600 + 5);
  });

  it('extend_trigger updates terminal_at within policy', async () => {
    const watch = parseResult(await registry.call('create_watch', {
      source: 'poll.email',
      criteria: { source: 'gmail', sender: 'sender-example-invalid' },
      report_chat: 'watch-report@s.whatsapp.net',
      ttl_hours: 1,
    }, adminSession));
    const requestedUntil = Math.floor(Date.now() / 1000) + 48 * 3600;

    const res = parseResult(await registry.call('extend_trigger', {
      id: watch.trigger_id,
      until: requestedUntil,
    }, adminSession));

    expect(res).toEqual({ ok: true });
    const triggers = parseResult(await registry.call('list_triggers', { bead_id: watch.bead_id }, adminSession));
    expect(triggers.triggers[0].terminal_at).toBe(requestedUntil);
  });

  it('create_watch rejects invalid criteria without leaving a bead', async () => {
    // enableUrlWatch is OFF by default; a poll.url source is rejected at the
    // disabled gate before zod even runs. Either way no bead/trigger persists.
    const res = await registry.call('create_watch', {
      source: 'poll.url',
      criteria: { url: 'not-a-url', hash_mode: 'text' },
      report_chat: 'watch-report@s.whatsapp.net',
    }, adminSession);

    expect(res.isError).toBe(true);
    const beads = parseResult(await registry.call('list_beads', { owner_jid: adminPhone }, adminSession));
    const triggers = parseResult(await registry.call('list_triggers', {}, adminSession));
    expect(beads.beads).toEqual([]);
    expect(triggers.triggers).toEqual([]);
  });

  it('create_watch with source:poll.url throws at creation when enableUrlWatch is OFF (never persists)', async () => {
    const res = await registry.call('create_watch', {
      source: 'poll.url',
      criteria: { url: 'https://example.com/feed', hash_mode: 'text' },
      report_chat: 'watch-report@s.whatsapp.net',
    }, adminSession);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/url watch is disabled|enableUrlWatch/i);
    const beads = parseResult(await registry.call('list_beads', { owner_jid: adminPhone }, adminSession));
    const triggers = parseResult(await registry.call('list_triggers', {}, adminSession));
    expect(beads.beads).toEqual([]);
    expect(triggers.triggers).toEqual([]);
  });

  it('create_watch with source:poll.url persists when enableUrlWatch is ON', async () => {
    const r2 = new ToolRegistry();
    registerDefaultTools(r2, db, vaultPath, { enableUrlWatch: true });
    const res = parseResult(await r2.call('create_watch', {
      source: 'poll.url',
      criteria: { url: 'https://example.com/feed', hash_mode: 'text' },
      report_chat: 'watch-report@s.whatsapp.net',
    }, adminSession));
    expect(res.trigger_id).toBeGreaterThan(0);
    const triggers = parseResult(await r2.call('list_triggers', { bead_id: res.bead_id }, adminSession));
    expect(triggers.triggers[0].kind).toBe('poll.url');
  });

  it('create_watch with source:poll.shell is rejected at creation (removed from the enum)', async () => {
    const res = await registry.call('create_watch', {
      source: 'poll.shell',
      criteria: { argv: ['/bin/true'], fire_when: 'exit_zero' },
      report_chat: 'watch-report@s.whatsapp.net',
    }, adminSession);

    expect(res.isError).toBe(true);
    const beads = parseResult(await registry.call('list_beads', { owner_jid: adminPhone }, adminSession));
    const triggers = parseResult(await registry.call('list_triggers', {}, adminSession));
    expect(beads.beads).toEqual([]);
    expect(triggers.triggers).toEqual([]);
  });

  it('approve_proposal rejects protected overrides without activating the proposal', async () => {
    const proposal = createBead(db.raw, {
      kind: 'task',
      title: 'review this',
      ownerJid: adminPhone,
      status: 'proposed',
      actor: 'test',
    });

    const res = await registry.call('approve_proposal', {
      id: proposal.id,
      overrides: { status: 'completed' },
    }, adminSession);

    expect(res.isError).toBe(true);
    expect(getBead(db.raw, proposal.id)?.bead.status).toBe('proposed');
  });

  it('approve_proposal succeeds with optional overrides and reject_proposal cancels with reason', async () => {
    const approve = createBead(db.raw, {
      kind: 'task',
      title: 'approve this',
      ownerJid: adminPhone,
      status: 'proposed',
      actor: 'test',
    });
    const reject = createBead(db.raw, {
      kind: 'task',
      title: 'reject this',
      ownerJid: adminPhone,
      status: 'proposed',
      actor: 'test',
    });
    const approveWithOverrides = createBead(db.raw, {
      kind: 'task',
      title: 'approve with overrides',
      ownerJid: adminPhone,
      status: 'proposed',
      actor: 'test',
    });

    expect(parseResult(await registry.call('approve_proposal', { id: approve.id }, adminSession))).toEqual({ ok: true });
    expect(parseResult(await registry.call('approve_proposal', {
      id: approveWithOverrides.id,
      overrides: { title: 'approved title' },
    }, adminSession))).toEqual({ ok: true });
    expect(parseResult(await registry.call('reject_proposal', { id: reject.id, reason: 'not needed' }, adminSession))).toEqual({ ok: true });

    expect(getBead(db.raw, approve.id)?.bead.status).toBe('active');
    expect(getBead(db.raw, approveWithOverrides.id)?.bead.title).toBe('approved title');
    const rejected = getBead(db.raw, reject.id);
    expect(rejected?.bead.status).toBe('cancelled');
    expect(rejected?.events.at(-1)?.payload_json).toContain('not needed');
  });

  it('get_bead and get_profile return null payloads for missing records', async () => {
    const bead = parseResult(await registry.call('get_bead', { id: 9999 }, adminSession));
    const profile = parseResult(await registry.call('get_profile', {
      entity_ref: { canonical_name: 'Missing Person', kind: 'person' },
    }, adminSession));

    expect(bead).toEqual({ bead: null });
    expect(profile).toEqual({ profile: null });
  });

  it('get_bead returns the bead with events when present', async () => {
    const created = parseResult(await registry.call('capture_task', { title: 'inspect me' }, adminSession));

    const res = parseResult(await registry.call('get_bead', { id: created.bead_id }, adminSession));

    expect(res.bead.title).toBe('inspect me');
    expect(res.events.map((event: { event_type: string }) => event.event_type)).toContain('status_change');
  });

  it('capture_observation + get_profile', async () => {
    await registry.call('capture_observation', {
      entity_ref: { canonical_name: 'Alex', kind: 'person' },
      kind: 'fact', text: 'prefers mornings', confidence: 0.9,
    }, adminSession);
    const profile = parseResult(await registry.call('get_profile', {
      entity_ref: { canonical_name: 'Alex', kind: 'person' },
    }, adminSession));
    expect(profile.entity.canonical_name).toBe('Alex');
    expect(profile.observations.map((o: { text: string }) => o.text)).toContain('prefers mornings');
  });

  it('capture_observation skips low-confidence observations without creating entities', async () => {
    const res = parseResult(await registry.call('capture_observation', {
      entity_ref: { canonical_name: 'Low Confidence', kind: 'person' },
      kind: 'fact',
      text: 'should not persist',
      confidence: 0.39,
    }, adminSession));

    expect(res).toEqual({ skipped: true, reason: 'confidence < observation_confidence_min (0.4)' });
    const profile = parseResult(await registry.call('get_profile', {
      entity_ref: { canonical_name: 'Low Confidence', kind: 'person' },
    }, adminSession));
    expect(profile).toEqual({ profile: null });
  });

  it('capture_observation projects the affected entity profile', async () => {
    await registry.call('capture_observation', {
      entity_ref: { canonical_name: 'Jordan', kind: 'person' },
      kind: 'note',
      text: 'likes precise review notes',
      confidence: 0.8,
    }, adminSession);

    const file = join(vaultPath, 'Profiles/person', 'Jordan.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('likes precise review notes');
  });

  it('contains entity projection failures without failing the observation mutation', async () => {
    const blockedVaultPath = tmpFile();
    writeFileSync(blockedVaultPath, 'not a directory');
    const blockedRegistry = new ToolRegistry();
    registerDefaultTools(blockedRegistry, db, blockedVaultPath);

    try {
      const res = parseResult(await blockedRegistry.call('capture_observation', {
        entity_ref: { canonical_name: 'Projection Blocked', kind: 'person' },
        kind: 'note',
        text: 'still persisted',
        confidence: 0.8,
      }, adminSession));

      expect(res.observation_id).toBeGreaterThan(0);
      expect(res.entity_id).toBeGreaterThan(0);
      const profile = parseResult(await registry.call('get_profile', {
        entity_ref: { entity_id: res.entity_id },
      }, adminSession));
      expect(profile.observations.map((o: { text: string }) => o.text)).toContain('still persisted');
    } finally {
      if (existsSync(blockedVaultPath)) unlinkSync(blockedVaultPath);
    }
  });

  it('list_entities filters by kind and text match', async () => {
    upsertEntity(db.raw, { canonicalName: 'Alpha Project', kind: 'project' });
    upsertEntity(db.raw, { canonicalName: 'Alpha Person', kind: 'person' });
    upsertEntity(db.raw, { canonicalName: 'Beta Project', kind: 'project' });

    const res = parseResult(await registry.call('list_entities', {
      kind: 'project',
      text_match: 'alpha',
      limit: 5,
    }, adminSession));

    expect(res.entities.map((entity: { canonical_name: string }) => entity.canonical_name)).toEqual(['Alpha Project']);
  });

  it('add_alias attaches an alias surfaced by get_profile', async () => {
    const entity = upsertEntity(db.raw, { canonicalName: 'Casey', kind: 'person' });

    const res = parseResult(await registry.call('add_alias', {
      entity_ref: { entity_id: entity.id },
      alias: 'cz',
      alias_kind: 'nickname',
      source: 'manual',
    }, adminSession));
    expect(res).toEqual({ entity_id: entity.id, alias: 'cz', alias_kind: 'nickname' });

    const profile = parseResult(await registry.call('get_profile', {
      entity_ref: { entity_id: entity.id },
    }, adminSession));
    expect(profile.aliases.map((a: { alias: string }) => a.alias)).toContain('cz');
  });

  it('add_alias returns an error for an unresolvable entity_ref', async () => {
    const res = await registry.call('add_alias', {
      entity_ref: { canonical_name: 'Nobody', kind: 'person' },
      alias: 'ghost',
      alias_kind: 'handle',
    }, adminSession);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/entity not found/i);
  });

  it('add_alias is admin gated', async () => {
    const entity = upsertEntity(db.raw, { canonicalName: 'Gated', kind: 'person' });
    const res = await registry.call('add_alias', {
      entity_ref: { entity_id: entity.id },
      alias: 'g',
      alias_kind: 'nickname',
    }, guestSession);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/admin/i);
  });

  it('forget_observation reprojects the affected entity profile', async () => {
    const res = parseResult(await registry.call('capture_observation', {
      entity_ref: { canonical_name: 'Taylor', kind: 'person' },
      kind: 'note',
      text: 'temporary profile note',
      confidence: 0.8,
    }, adminSession));
    const file = join(vaultPath, 'Profiles/person', 'Taylor.md');
    expect(readFileSync(file, 'utf8')).toContain('temporary profile note');

    await registry.call('forget_observation', { id: res.observation_id, reason: 'stale' }, adminSession);

    expect(readFileSync(file, 'utf8')).not.toContain('temporary profile note');
  });

  it('forget_observation is a no-op when the observation id is missing', async () => {
    const res = parseResult(await registry.call('forget_observation', { id: 9999, reason: 'already gone' }, adminSession));

    expect(res).toEqual({ ok: true });
  });

  it('merge_entities removes stale loser profile projection', async () => {
    const from = upsertEntity(db.raw, { canonicalName: 'Old Name', kind: 'person' });
    const into = upsertEntity(db.raw, { canonicalName: 'New Name', kind: 'person' });
    await registry.call('regenerate_vault', {}, adminSession);
    const staleFile = join(vaultPath, 'Profiles/person', 'Old-Name.md');
    expect(existsSync(staleFile)).toBe(true);

    await registry.call('merge_entities', { from_id: from.id, into_id: into.id }, adminSession);

    expect(existsSync(staleFile)).toBe(false);
    expect(existsSync(join(vaultPath, 'Profiles/person', 'New-Name.md'))).toBe(true);
  });
});
