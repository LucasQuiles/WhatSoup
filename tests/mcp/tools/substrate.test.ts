import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
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
  'get_profile', 'list_entities', 'merge_entities', 'forget_observation',
  'regenerate_vault',
];

const adminPhone = '1001';
const adminActor = `${adminPhone}@s.whatsapp.net`;
const guestActor = '1002@s.whatsapp.net';

const adminSession: SessionContext = { tier: 'global', actorJid: adminActor };
const guestSession: SessionContext = { tier: 'global', actorJid: guestActor };

// Helper: parse the single-content-block JSON payload that registry.call() returns.
function parseResult(r: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  if (r.isError) throw new Error(r.content[0]?.text ?? 'tool error');
  return JSON.parse(r.content[0].text);
}

describe('substrate MCP tools', () => {
  let dbPath: string; let vaultPath: string; let db: Database; let registry: ToolRegistry;

  beforeEach(() => {
    dbPath = tmpFile();
    vaultPath = tmpDir();
    db = new Database(dbPath); db.open();
    registry = new ToolRegistry();
    registerSubstrateTools(registry, {
      db: db.raw,
      dbWrapper: db,
      adminPhones: new Set<string>([adminPhone]),
      memory: {
        adminJid: adminPhone, vaultPath,
        observationConfidenceMin: 0.4,
        sweep: { beadProposeMin: 0.55, beadUpdateMin: 0.8, lookbackHours: 48, reviewByDays: 7 },
        watchTtl: { defaultHours: 24, maxHours: 72 },
      },
    });
  });
  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(vaultPath)) rmSync(vaultPath, { recursive: true, force: true });
  });

  it('registers all 19 tools', () => {
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
      report_chat: '1003@s.whatsapp.net',
    }, adminSession));
    expect(res.trigger_id).toBeGreaterThan(0);
    const triggers = parseResult(await registry.call('list_triggers', { bead_id: res.bead_id }, adminSession));
    expect(triggers.triggers[0].status).toBe('active');
    await registry.call('pause_trigger', { id: res.trigger_id }, adminSession);
    const after = parseResult(await registry.call('list_triggers', { bead_id: res.bead_id }, adminSession));
    expect(after.triggers[0].status).toBe('paused');
  });

  it('create_agent_job rejects invalid trigger input without leaving a bead', async () => {
    const res = await registry.call('create_agent_job', {
      prompt: 'daily digest',
      schedule: { kind: 'schedule.cron' },
      report_chat: '1003@s.whatsapp.net',
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

  it('create_watch rejects invalid criteria without leaving a bead', async () => {
    const res = await registry.call('create_watch', {
      source: 'poll.url',
      criteria: { url: 'not-a-url', hash_mode: 'text' },
      report_chat: '1003@s.whatsapp.net',
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
