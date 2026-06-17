import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, rmSync, unlinkSync, readdirSync, writeFileSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';
import { createBead } from '../../../src/core/substrate/beads.ts';
import { upsertEntity, captureObservation } from '../../../src/core/substrate/entities.ts';
import {
  regenerateVault, projectBead, projectEntity, removeEntityProjection,
} from '../../../src/core/substrate/vault.ts';

function tmpDir() { return join(tmpdir(), `vault-${randomBytes(8).toString('hex')}`); }
function tmpFile() { return join(tmpdir(), `sub-${randomBytes(8).toString('hex')}.db`); }

describe('vault projector', () => {
  let dbPath: string; let vaultPath: string; let db: Database;
  beforeEach(() => { dbPath = tmpFile(); vaultPath = tmpDir(); db = new Database(dbPath); db.open(); });
  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(vaultPath)) rmSync(vaultPath, { recursive: true, force: true });
  });

  it('regenerateVault creates expected folders; Digests/ is empty', () => {
    regenerateVault(db.raw, { vaultPath });
    for (const d of ['Profiles/person','Profiles/org','Beads/active','Beads/proposed','Beads/completed','Beads/cancelled','Digests']) {
      expect(existsSync(join(vaultPath, d))).toBe(true);
    }
    expect(readdirSync(join(vaultPath, 'Digests'))).toHaveLength(0);
  });

  it('projectBead writes file with front-matter', () => {
    const bead = createBead(db.raw, {
      kind: 'task', title: 'call Alex', ownerJid: 'mw',
      chatJid: 'user-1@s.whatsapp.net', sourceMessagePk: 42, actor: 'inline',
    });
    regenerateVault(db.raw, { vaultPath });
    projectBead(db.raw, { vaultPath, beadId: bead.id });
    const file = join(vaultPath, 'Beads/active', `task-${bead.id}.md`);
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, 'utf8');
    expect(content).toContain(`id: task-${bead.id}`);
    expect(content).toContain(`kind: task`);
    expect(content).toContain(`status: active`);
    expect(content).toContain(`owner: mw`);
    expect(content).toContain(`source_message_pk: 42`);
    expect(content).toContain(`# call Alex`);
  });

  it('projectBead removes stale files from prior status folders', () => {
    const bead = createBead(db.raw, {
      kind: 'task',
      title: 'move me',
      ownerJid: '1001@s.whatsapp.net',
      actor: 'test',
    });

    regenerateVault(db.raw, { vaultPath });
    const activeFile = join(vaultPath, 'Beads/active', `task-${bead.id}.md`);
    expect(existsSync(activeFile)).toBe(true);

    db.raw.prepare(`UPDATE beads SET status = 'completed' WHERE id = ?`).run(bead.id);
    projectBead(db.raw, { vaultPath, beadId: bead.id });

    const completedFile = join(vaultPath, 'Beads/completed', `task-${bead.id}.md`);
    expect(existsSync(completedFile)).toBe(true);
    expect(existsSync(activeFile)).toBe(false);
  });

  it('projectEntity writes profile with observations', () => {
    const e = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Alex' });
    captureObservation(db.raw, {
      entityRef: { entityId: e.id }, kind: 'fact',
      text: 'prefers morning meetings', confidence: 0.9, sourceKind: 'manual',
    });
    regenerateVault(db.raw, { vaultPath });
    projectEntity(db.raw, { vaultPath, entityId: e.id });
    const file = join(vaultPath, 'Profiles/person', `Alex.md`);
    const content = readFileSync(file, 'utf8');
    expect(content).toContain('# Alex');
    expect(content).toContain('prefers morning meetings');
  });

  it('regenerateVault is idempotent', () => {
    regenerateVault(db.raw, { vaultPath });
    expect(() => regenerateVault(db.raw, { vaultPath })).not.toThrow();
  });
});

describe('vault.ts uncovered-branch coverage', () => {
  let dbPath: string; let vaultPath: string; let db: Database;
  beforeEach(() => { dbPath = tmpFile(); vaultPath = tmpDir(); db = new Database(dbPath); db.open(); });
  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(vaultPath)) rmSync(vaultPath, { recursive: true, force: true });
  });

  it('projectBead returns null when bead does not exist', () => {
    regenerateVault(db.raw, { vaultPath });
    const out = projectBead(db.raw, { vaultPath, beadId: 99999 });
    expect(out).toBe(null);
  });

  it('removeStaleBeadFiles swallows ENOENT on first write of a proposed bead (catch branch)', () => {
    const bead = createBead(db.raw, {
      kind: 'task', status: 'proposed', title: 'never seen',
      ownerJid: '15550000002@s.whatsapp.net', actor: 'inline',
    });
    const out = projectBead(db.raw, { vaultPath, beadId: bead.id });
    expect(out).toBe(join(vaultPath, 'Beads/proposed', `task-${bead.id}.md`));
    // proposed file written; no stale file existed in active/completed/cancelled
    expect(existsSync(out as string)).toBe(true);
    expect(readFileSync(out as string, 'utf8')).toContain('status: proposed');
  });

  it('projectBead embeds linked entity names in front-matter (entityRows non-empty branch)', () => {
    const alex = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Alex Rivera' });
    const sam = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Sam Patel' });
    const bead = createBead(db.raw, {
      kind: 'task', title: 'review with team', ownerJid: '15550000003@s.whatsapp.net', actor: 'inline',
    });
    const now = Math.floor(Date.now() / 1000);
    db.raw.prepare(
      `INSERT INTO bead_entity_refs (bead_id, entity_id, role, created_at) VALUES (?, ?, 'subject', ?)`,
    ).run(bead.id, sam.id, now);
    db.raw.prepare(
      `INSERT INTO bead_entity_refs (bead_id, entity_id, role, created_at) VALUES (?, ?, 'mentioned', ?)`,
    ).run(bead.id, alex.id, now);

    const out = projectBead(db.raw, { vaultPath, beadId: bead.id });
    expect(out).not.toBe(null);
    const content = readFileSync(out as string, 'utf8');
    // Ordered by canonical_name ascending: Alex Rivera, Sam Patel
    expect(content).toContain('entities: ["Alex Rivera", "Sam Patel"]');
  });

  it('projectEntity returns null when entity does not exist', () => {
    regenerateVault(db.raw, { vaultPath });
    const out = projectEntity(db.raw, { vaultPath, entityId: 99999 });
    expect(out).toBe(null);
  });

  it('projectEntity renders aliases and linked-bead sections when present', () => {
    const e = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Jordan Lee' });
    db.raw.prepare(
      `INSERT INTO entity_aliases (entity_id, alias, alias_kind, source, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(e.id, 'Jordo', 'nickname', 'manual', Math.floor(Date.now() / 1000));
    const bead = createBead(db.raw, {
      kind: 'task', title: 'intro call', ownerJid: '15550000004@s.whatsapp.net', actor: 'inline',
    });
    db.raw.prepare(
      `INSERT INTO bead_entity_refs (bead_id, entity_id, role, created_at) VALUES (?, ?, 'subject', ?)`,
    ).run(bead.id, e.id, Math.floor(Date.now() / 1000));

    const out = projectEntity(db.raw, { vaultPath, entityId: e.id });
    expect(out).not.toBe(null);
    const content = readFileSync(out as string, 'utf8');
    expect(content).toContain('# Jordan Lee');
    expect(content).toContain('**nickname**: Jordo');
    expect(content).toContain('- bead ' + bead.id);
  });

  it('removeEntityProjection is a no-op when entity does not exist (early return branch)', () => {
    regenerateVault(db.raw, { vaultPath });
    // Should not throw; nothing to remove.
    removeEntityProjection(db.raw, { vaultPath, entityId: 99999 });
    // No profile files written for an entity that does not exist.
    const personDir = join(vaultPath, 'Profiles/person');
    expect(readdirSync(personDir)).toHaveLength(0);
  });

  it('removeEntityProjection deletes an existing profile file', () => {
    const e = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Casey Ng' });
    const file = projectEntity(db.raw, { vaultPath, entityId: e.id });
    expect(existsSync(file as string)).toBe(true);

    removeEntityProjection(db.raw, { vaultPath, entityId: e.id });
    expect(existsSync(file as string)).toBe(false);
  });

  it('removeEntityProjection swallows ENOENT when no projection exists yet (catch branch)', () => {
    const e = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Riley Quinn' });
    // Materialise folders (removeEntityProjection does not call ensureFolders),
    // but never project this entity → file absent; remove should swallow unlink error.
    regenerateVault(db.raw, { vaultPath });
    expect(() => removeEntityProjection(db.raw, { vaultPath, entityId: e.id })).not.toThrow();
    const personDir = join(vaultPath, 'Profiles/person');
    expect(readdirSync(personDir)).toHaveLength(0);
  });

  it('projectEntity slug-falls-back to untitled for an all-punctuation name (safeSlug branch)', () => {
    const e = upsertEntity(db.raw, { kind: 'other', canonicalName: '!!! ???' });
    const out = projectEntity(db.raw, { vaultPath, entityId: e.id });
    expect(out).toBe(join(vaultPath, 'Profiles/other', 'untitled.md'));
    expect(existsSync(out as string)).toBe(true);
    expect(readFileSync(out as string, 'utf8')).toContain('canonical_name: !!! ???');
  });

  it('regenerateVault reports counts and writes files for both beads and entities', () => {
    createBead(db.raw, {
      kind: 'task', title: 'b1', ownerJid: '15550000005@s.whatsapp.net', actor: 'inline',
    });
    createBead(db.raw, {
      kind: 'project', status: 'proposed', title: 'b2',
      ownerJid: '15550000006@s.whatsapp.net', actor: 'inline',
    });
    upsertEntity(db.raw, { kind: 'org', canonicalName: 'Acme Co' });
    upsertEntity(db.raw, { kind: 'place', canonicalName: 'Reykjavik' });

    const counts = regenerateVault(db.raw, { vaultPath });
    expect(counts).toStrictEqual({ beads: 2, entities: 2 });
    const activeFiles = readdirSync(join(vaultPath, 'Beads/active'));
    const proposedFiles = readdirSync(join(vaultPath, 'Beads/proposed'));
    const orgFiles = readdirSync(join(vaultPath, 'Profiles/org'));
    const placeFiles = readdirSync(join(vaultPath, 'Profiles/place'));
    expect(activeFiles).toHaveLength(1);
    expect(proposedFiles).toHaveLength(1);
    expect(orgFiles).toContain('Acme-Co.md');
    expect(placeFiles).toContain('Reykjavik.md');
  });

  it('projectBead with a cancelled bead routes to Beads/cancelled and clears stale active file', () => {
    const bead = createBead(db.raw, {
      kind: 'task', title: 'doomed', ownerJid: '15550000007@s.whatsapp.net', actor: 'inline',
    });
    // Seed a stale file in 'completed' to exercise the catch-free removal there too.
    const staleCompleted = join(vaultPath, 'Beads/completed', `task-${bead.id}.md`);
    projectBead(db.raw, { vaultPath, beadId: bead.id }); // initial active projection
    // Drop a stale completed file by hand, then transition.
    writeFileSync(staleCompleted, 'stale', 'utf8');
    db.raw.prepare(`UPDATE beads SET status = 'cancelled', cancelled_at = ? WHERE id = ?`)
      .run(Math.floor(Date.now() / 1000), bead.id);

    const out = projectBead(db.raw, { vaultPath, beadId: bead.id });
    expect(out).toBe(join(vaultPath, 'Beads/cancelled', `task-${bead.id}.md`));
    expect(existsSync(out as string)).toBe(true);
    expect(existsSync(staleCompleted)).toBe(false);
    expect(readFileSync(out as string, 'utf8')).toContain('status: cancelled');
  });
});

