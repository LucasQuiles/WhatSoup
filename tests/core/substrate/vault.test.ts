import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, rmSync, unlinkSync, readdirSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';
import { createBead } from '../../../src/core/substrate/beads.ts';
import { upsertEntity, captureObservation } from '../../../src/core/substrate/entities.ts';
import { regenerateVault, projectBead, projectEntity } from '../../../src/core/substrate/vault.ts';

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
