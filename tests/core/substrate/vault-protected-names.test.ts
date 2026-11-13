/**
 * Vault export file names for entity names that carry a protected link: no
 * file name carries the link, distinct entities keep distinct files, and
 * removal derives the same name as projection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/core/protected-delivery-pins.ts', async (importOriginal) =>
  (await import('../../helpers/protected-delivery-pins.ts')).mockProtectedDeliveryPins(importOriginal as never));

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Database } from '../../../src/core/database.ts';
import { upsertEntity } from '../../../src/core/substrate/entities.ts';
import { projectEntity, removeEntityProjection } from '../../../src/core/substrate/vault.ts';
import { TEST_LINK_HOST } from '../../helpers/protected-delivery-pins.ts';

const link = (fill: string): string => `https://${TEST_LINK_HOST}/s/#v3.${fill.repeat(22)}.${'Z'.repeat(43)}`;

describe('vault entity file names for names that carry a protected link', () => {
  let db: Database;
  let vaultPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    vaultPath = mkdtempSync(join(tmpdir(), 'vault-protected-names-'));
  });

  afterEach(() => {
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  });

  it('writes two entities that differ only by a protected link to two files without the link', () => {
    const first = upsertEntity(db.raw, { kind: 'person', canonicalName: `Person ${link('A')}` });
    const second = upsertEntity(db.raw, { kind: 'person', canonicalName: `Person ${link('B')}` });

    const firstFile = projectEntity(db.raw, { vaultPath, entityId: first.id })!;
    const secondFile = projectEntity(db.raw, { vaultPath, entityId: second.id })!;

    expect(firstFile).not.toBe(secondFile);
    expect(readdirSync(join(vaultPath, 'Profiles/person')).sort()).toEqual([basename(firstFile), basename(secondFile)].sort());
    for (const file of [firstFile, secondFile]) {
      expect(basename(file)).toMatch(/^Person-protected-managed-link-[0-9a-f]{12}\.md$/);
      expect(file).not.toContain('example');
    }
  });

  it('removes only the named entity export', () => {
    const first = upsertEntity(db.raw, { kind: 'person', canonicalName: `Person ${link('A')}` });
    const second = upsertEntity(db.raw, { kind: 'person', canonicalName: `Person ${link('B')}` });
    const firstFile = projectEntity(db.raw, { vaultPath, entityId: first.id })!;
    const secondFile = projectEntity(db.raw, { vaultPath, entityId: second.id })!;

    removeEntityProjection(db.raw, { vaultPath, entityId: first.id });

    expect(existsSync(firstFile)).toBe(false);
    expect(existsSync(secondFile)).toBe(true);
  });

  it('keeps the file name of a name without a link byte for byte', () => {
    const entity = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Casey Ng' });

    expect(projectEntity(db.raw, { vaultPath, entityId: entity.id })).toBe(join(vaultPath, 'Profiles/person', 'Casey-Ng.md'));
  });
});
