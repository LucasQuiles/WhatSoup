import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSettingsPolicyAdapter,
  createFileGrantStore,
  assertGroupsRespectDenyFloor,
} from '../../src/core/capability-grant-adapter.ts';
import { REQUIRED_DENY } from '../../src/core/settings-template.ts';
import type { GrantRecord } from '../../src/lib/capability-grant.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cap-grant-adapter-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readSettings(): { allow: string[]; deny: string[] } {
  const parsed = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
  return { allow: parsed.permissions.allow, deny: parsed.permissions.deny };
}

describe('createSettingsPolicyAdapter', () => {
  it('reads empty sets when settings.json is absent', async () => {
    const adapter = createSettingsPolicyAdapter(dir);
    const snap = await adapter.read();
    expect(snap.allow.size).toBe(0);
    expect(snap.deny.size).toBe(0);
  });

  it('reads existing permissions.{allow,deny}', async () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ permissions: { allow: ['camera.snap'], deny: ['x.y'], defaultMode: 'bypassPermissions' } }),
    );
    const snap = await createSettingsPolicyAdapter(dir).read();
    expect(snap.allow.has('camera.snap')).toBe(true);
    expect(snap.deny.has('x.y')).toBe(true);
  });

  it('apply adds to allow and removes from deny, persisting to settings.json', async () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ permissions: { allow: [], deny: ['camera.snap'], defaultMode: 'bypassPermissions' } }),
    );
    const adapter = createSettingsPolicyAdapter(dir);
    await adapter.apply({ addAllow: ['camera.snap'], removeAllow: [], addDeny: [], removeDeny: ['camera.snap'] });
    const { allow, deny } = readSettings();
    expect(allow).toContain('camera.snap');
    expect(deny).not.toContain('camera.snap');
  });

  it('re-reads current on-disk state before applying (survives concurrent edits)', async () => {
    const adapter = createSettingsPolicyAdapter(dir);
    await adapter.apply({ addAllow: ['a.one'], removeAllow: [], addDeny: [], removeDeny: [] });
    // A concurrent unrelated edit lands directly on disk.
    const cur = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    cur.permissions.allow.push('b.two');
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(cur));
    // Next apply must preserve the concurrent 'b.two'.
    await adapter.apply({ addAllow: ['c.three'], removeAllow: [], addDeny: [], removeDeny: [] });
    const { allow } = readSettings();
    expect(allow).toEqual(expect.arrayContaining(['a.one', 'b.two', 'c.three']));
  });

  // ─── The load-bearing security assertion ───────────────────────────────────
  it('SECURITY: a delta that removes a REQUIRED_DENY floor entry cannot strip it — the floor survives the persist', async () => {
    const floorEntry = REQUIRED_DENY[0];
    expect(typeof floorEntry).toBe('string');
    const adapter = createSettingsPolicyAdapter(dir);
    // Simulate a grant trying to unlock a floor-denied tool: add to allow AND remove from deny.
    await adapter.apply({ addAllow: [floorEntry], removeAllow: [], addDeny: [], removeDeny: [floorEntry] });
    const { deny } = readSettings();
    // writePermissionsSettings re-unions REQUIRED_DENY on every write — the floor entry is still denied.
    expect(deny).toContain(floorEntry);
  });
});

describe('createFileGrantStore', () => {
  const record: GrantRecord = {
    version: 2,
    armedAtMs: 1000,
    expiresAtMs: 2000,
    group: 'camera',
    capabilities: ['camera.snap'],
    addedToAllow: ['camera.snap'],
    removedFromDeny: [],
  };

  it('round-trips a grant record', async () => {
    const store = createFileGrantStore(join(dir, 'grant.json'));
    expect(await store.read()).toBeNull();
    await store.write(record);
    expect(await store.read()).toEqual(record);
  });

  it('write(null) clears the store', async () => {
    const path = join(dir, 'grant.json');
    const store = createFileGrantStore(path);
    await store.write(record);
    expect(existsSync(path)).toBe(true);
    await store.write(null);
    expect(existsSync(path)).toBe(false);
    expect(await store.read()).toBeNull();
  });

  it('fails closed to null on a malformed store file (not throw)', async () => {
    const path = join(dir, 'grant.json');
    writeFileSync(path, '{ not valid json');
    expect(await createFileGrantStore(path).read()).toBeNull();
  });

  it('writes the record with 0600 permissions', async () => {
    const path = join(dir, 'grant.json');
    await createFileGrantStore(path).write(record);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('assertGroupsRespectDenyFloor', () => {
  it('accepts groups that do not intersect the floor', () => {
    expect(() =>
      assertGroupsRespectDenyFloor({ camera: { capabilities: ['camera.snap', 'camera.clip'] } }),
    ).not.toThrow();
  });

  it('SECURITY: rejects a group that would unlock a REQUIRED_DENY floor entry', () => {
    const floorEntry = REQUIRED_DENY[0];
    expect(() =>
      assertGroupsRespectDenyFloor({ bad: { capabilities: ['camera.snap', floorEntry] } }),
    ).toThrow(/REQUIRED_DENY floor entry/);
  });
});
