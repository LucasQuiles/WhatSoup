// src/core/substrate/vault.ts
import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createChildLogger } from '../../logger.ts';
import { privateWriteError } from '../../lib/private-fs.ts';
import { listBeads, getBead } from './beads.ts';
import { getProfile, listEntities } from './entities.ts';
import type { BeadRow, EntityRow, ObservationRow } from './types.ts';

const log = createChildLogger('substrate:vault');

/**
 * Write one projection file, converting a raw filesystem errno into a logged,
 * structured failure.
 *
 * Both projection writers funnel through here rather than each wrapping their
 * own `writeFileSync`: the guard is identical at both sites and the only thing
 * that differs is which projection was being written.
 *
 * The failure is logged AND rethrown on purpose. Swallowing it would leave the
 * vault silently missing a projection with no operator signal — the failure mode
 * #2359 calls out — while rethrowing alone gives the caller an errno with no
 * indication that a vault projection was its source. `unlinkSync` in this module
 * is best-effort by contrast, because a stale projection that is already gone is
 * the expected case, not a fault.
 */
function writeProjection(file: string, body: string, projection: 'bead' | 'entity'): void {
  try {
    writeFileSync(file, body, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code ?? 'EIO';
    log.error({ err, code, path: file, projection }, 'vault projection write failed');
    const wrapped = privateWriteError(
      `vault projection unavailable: cannot write ${projection} projection ${file}`,
      code,
    );
    wrapped.path = file;
    throw wrapped;
  }
}

const PROJECTED_FOLDERS = [
  'Profiles/person', 'Profiles/org', 'Profiles/project',
  'Profiles/place', 'Profiles/topic', 'Profiles/other',
  'Beads/active', 'Beads/proposed', 'Beads/completed', 'Beads/cancelled',
  'Digests',
];

function ensureFolders(vaultPath: string): void {
  for (const f of PROJECTED_FOLDERS) mkdirSync(join(vaultPath, f), { recursive: true });
}

function safeSlug(s: string): string {
  return s.replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
}

function beadStatusFolder(status: BeadRow['status']): string | null {
  switch (status) {
    case 'active': case 'paused': case 'failed': return 'Beads/active';
    case 'proposed':  return 'Beads/proposed';
    case 'completed': return 'Beads/completed';
    case 'cancelled': return 'Beads/cancelled';
    default: return null;
  }
}

function removeStaleBeadFiles(vaultPath: string, bead: BeadRow, keepFolder: string): void {
  for (const folder of ['Beads/active', 'Beads/proposed', 'Beads/completed', 'Beads/cancelled']) {
    if (folder === keepFolder) continue;
    try {
      unlinkSync(join(vaultPath, folder, `${bead.kind}-${bead.id}.md`));
    } catch {
      // Missing stale projections are expected on first write.
    }
  }
}

function beadFrontMatter(bead: BeadRow, entityNames: string[]): string {
  const iso = (t: number | null) => (t == null ? 'null' : new Date(t * 1000).toISOString());
  return [
    '---',
    `id: ${bead.kind}-${bead.id}`,
    `kind: ${bead.kind}`,
    `status: ${bead.status}`,
    `owner: ${bead.owner_jid}`,
    `created: ${iso(bead.created_at)}`,
    `updated: ${iso(bead.updated_at)}`,
    `chat_jid: ${bead.chat_jid ?? 'null'}`,
    `source_message_pk: ${bead.source_message_pk ?? 'null'}`,
    `due_at: ${iso(bead.due_at)}`,
    `priority: ${bead.priority}`,
    `entities: [${entityNames.map(n => JSON.stringify(n)).join(', ')}]`,
    '---', '',
  ].join('\n');
}

function entityFrontMatter(entity: EntityRow): string {
  const iso = (t: number) => new Date(t * 1000).toISOString();
  return [
    '---',
    `id: entity-${entity.id}`,
    `kind: ${entity.kind}`,
    `canonical_name: ${entity.canonical_name}`,
    `contact_jid: ${entity.contact_jid ?? 'null'}`,
    `group_jid: ${entity.group_jid ?? 'null'}`,
    `created: ${iso(entity.created_at)}`,
    `updated: ${iso(entity.updated_at)}`,
    '---', '',
  ].join('\n');
}

export interface ProjectBeadArgs { vaultPath: string; beadId: number; }

export function projectBead(db: DatabaseSync, args: ProjectBeadArgs): string | null {
  ensureFolders(args.vaultPath);
  const r = getBead(db, args.beadId);
  if (!r) return null;
  const folder = beadStatusFolder(r.bead.status);
  if (!folder) return null;
  removeStaleBeadFiles(args.vaultPath, r.bead, folder);
  const entityRows = db.prepare(
    `SELECT e.canonical_name FROM bead_entity_refs r
     JOIN entities e ON e.id = r.entity_id
     WHERE r.bead_id = ? ORDER BY e.canonical_name`
  ).all(args.beadId) as Array<{ canonical_name: string }>;
  const file = join(args.vaultPath, folder, `${r.bead.kind}-${r.bead.id}.md`);
  const body = [
    beadFrontMatter(r.bead, entityRows.map(x => x.canonical_name)),
    `# ${r.bead.title}`, '',
    r.bead.body ?? '',
    '',
    '## Recent events',
    ...r.events.slice(-10).map(e => `- ${new Date(e.created_at * 1000).toISOString()} · **${e.event_type}** by ${e.actor}`),
    '',
  ].join('\n');
  writeProjection(file, body, 'bead');
  return file;
}

export interface ProjectEntityArgs { vaultPath: string; entityId: number; }

export function removeEntityProjection(db: DatabaseSync, args: ProjectEntityArgs): void {
  const entity = db.prepare(`SELECT kind, canonical_name FROM entities WHERE id = ?`).get(args.entityId) as Pick<EntityRow, 'kind' | 'canonical_name'> | undefined;
  if (!entity) return;
  try {
    unlinkSync(join(args.vaultPath, `Profiles/${entity.kind}`, `${safeSlug(entity.canonical_name)}.md`));
  } catch {
    // Missing stale projections are expected when the vault has not been generated.
  }
}

export function projectEntity(db: DatabaseSync, args: ProjectEntityArgs): string | null {
  ensureFolders(args.vaultPath);
  const profile = getProfile(db, { entityId: args.entityId });
  if (!profile) return null;
  const folder = `Profiles/${profile.entity.kind}`;
  const file = join(args.vaultPath, folder, `${safeSlug(profile.entity.canonical_name)}.md`);
  const obsLines = profile.observations.map(
    (o: ObservationRow) => `- (${o.confidence.toFixed(2)}) **${o.kind}** — ${o.text} _[${o.source_kind}${o.source_message_pk != null ? `:msg${o.source_message_pk}` : ''}]_`
  );
  const aliasLines = profile.aliases.map(a => `- **${a.alias_kind}**: ${a.alias}${a.source ? ` _(${a.source})_` : ''}`);
  const beadLines = profile.linkedBeadIds.map(id => `- bead ${id}`);
  const body = [
    entityFrontMatter(profile.entity),
    `# ${profile.entity.canonical_name}`, '',
    '## Aliases',
    aliasLines.length ? aliasLines.join('\n') : '_(none)_',
    '',
    '## Observations',
    obsLines.length ? obsLines.join('\n') : '_(none)_',
    '',
    '## Linked beads',
    beadLines.length ? beadLines.join('\n') : '_(none)_',
    '',
  ].join('\n');
  writeProjection(file, body, 'entity');
  return file;
}

export interface RegenerateVaultArgs { vaultPath: string; }

export function regenerateVault(db: DatabaseSync, args: RegenerateVaultArgs): { beads: number; entities: number } {
  ensureFolders(args.vaultPath);
  const allBeads = listBeads(db, { limit: 5000 });
  for (const b of allBeads) projectBead(db, { vaultPath: args.vaultPath, beadId: b.id });
  const allEntities = listEntities(db, { limit: 5000 });
  for (const e of allEntities) projectEntity(db, { vaultPath: args.vaultPath, entityId: e.id });
  return { beads: allBeads.length, entities: allEntities.length };
}
