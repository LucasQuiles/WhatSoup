import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  loadAllowlist,
  loadSchemaModules,
  scanSqlSchema,
  splitStatements,
  type AllowlistEntry,
  type SchemaModules,
} from '../../scripts/sql-schema-guard.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = trackTmpDirs('sql-schema-guard-');
let schema: SchemaModules;

beforeAll(async () => {
  schema = await loadSchemaModules();
});

/** A throwaway repo root whose src/ holds exactly the given files. */
function tree(files: Record<string, string>): string {
  const root = tmp.make('repo');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

/** A literal against a migrated table, so a fixture never scans zero literals. */
const VALID_ANCHOR = "export const anchor = 'SELECT message_id FROM messages WHERE chat_jid = ?';\n";

describe('sql-schema-guard', () => {
  it('fails the #3607 crash_count statement exactly as it shipped in extendTrigger', () => {
    const root = tree({
      'src/core/substrate/triggers.ts': [
        "import type { DatabaseSync } from 'node:sqlite';",
        'export function reactivate(db: DatabaseSync, now: number, id: number): void {',
        "  db.prepare(`UPDATE bead_triggers SET status='active', next_fire_at=?, crash_count=0, updated_at=? WHERE id=?`).run(now, now, id);",
        '}',
        '',
      ].join('\n'),
    });
    const result = scanSqlSchema({ repoRoot: root, allowlist: [], schema });
    expect(result.status).toBe('block');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: 'missing-name',
      file: 'src/core/substrate/triggers.ts',
      line: 3,
      message: 'no such column: crash_count',
    });
  });

  it('fails a literal that names a table no migration or store creates', () => {
    const root = tree({ 'src/a.ts': "export const q = 'SELECT id FROM no_such_table_anywhere';\n" });
    const result = scanSqlSchema({ repoRoot: root, allowlist: [], schema });
    expect(result.findings.map((finding) => finding.message)).toEqual(['no such table: no_such_table_anywhere']);
  });

  it('passes a literal against a table a store creates at runtime, and still checks its columns', () => {
    const store = [
      'export const DDL = `CREATE TABLE IF NOT EXISTS widget_store (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;',
      "export const read = 'SELECT name FROM widget_store WHERE id = ?';",
      '',
    ].join('\n');
    const clean = scanSqlSchema({ repoRoot: tree({ 'src/store.ts': store }), allowlist: [], schema });
    expect(clean.status).toBe('pass');
    expect(clean.findings).toEqual([]);
    expect(clean.ddlExecuted).toBe(1);
    expect(clean.statementsChecked).toBe(1);

    const stale = scanSqlSchema({
      repoRoot: tree({ 'src/store.ts': `${store}export const bad = 'SELECT colour FROM widget_store';\n` }),
      allowlist: [],
      schema,
    });
    expect(stale.findings.map((finding) => finding.message)).toEqual(['no such column: colour']);
  });

  it('includes columns that a runtime initializer adds with a template string', () => {
    // total_cache_read_tokens is added to agent_sessions by ensureAgentSchema's
    // `ADD COLUMN ${col} ${def}` loop as well as a migration; requested_effort
    // exists only through ensureChatPreferenceSchema's probe loop.
    const root = tree({
      'src/a.ts': "export const q = 'SELECT requested_effort FROM chat_model_preference WHERE chat_jid = ?';\n",
    });
    const result = scanSqlSchema({ repoRoot: root, allowlist: [], schema });
    expect(result.findings).toEqual([]);
  });

  it('skips and reports an allow-listed file that talks to a different database', () => {
    const allowlist: AllowlistEntry[] = [
      { kind: 'separate-database', path: 'src/other-db/', reason: 'fixture: opens its own database file' },
    ];
    const root = tree({
      'src/anchor.ts': VALID_ANCHOR,
      'src/other-db/store.ts': "export const q = 'SELECT x FROM elsewhere_only';\n",
    });
    const result = scanSqlSchema({ repoRoot: root, allowlist, schema });
    expect(result.status).toBe('pass');
    expect(result.skippedAllowlisted).toBe(1);
    expect(result.allowlistUsed).toEqual([{ ...allowlist[0], hits: 1 }]);
  });

  it('fails an allow-list entry that no longer matches anything', () => {
    const allowlist: AllowlistEntry[] = [
      { kind: 'literal', path: 'src/anchor.ts', match: 'gone_table', reason: 'fixture: stale entry' },
    ];
    const result = scanSqlSchema({ repoRoot: tree({ 'src/anchor.ts': VALID_ANCHOR }), allowlist, schema });
    expect(result.findings.map((finding) => finding.kind)).toEqual(['stale-allowlist']);
  });

  it('skips and counts a template with ${} substitutions instead of failing it', () => {
    const root = tree({
      'src/anchor.ts': VALID_ANCHOR,
      'src/dynamic.ts': 'export const q = (col: string) => `SELECT ${col} FROM table_that_does_not_exist`;\n',
    });
    const result = scanSqlSchema({ repoRoot: root, allowlist: [], schema });
    expect(result.status).toBe('pass');
    expect(result.skippedDynamic).toBe(1);
    expect(result.findings).toEqual([]);
  });

  it('fails template-built DDL in a file that is not a registered runtime initializer', () => {
    const root = tree({
      'src/anchor.ts': VALID_ANCHOR,
      'src/adder.ts': 'export const add = (c: string) => `ALTER TABLE messages ADD COLUMN ${c} TEXT`;\n',
    });
    const result = scanSqlSchema({ repoRoot: root, allowlist: [], schema });
    expect(result.findings.map((finding) => `${finding.kind}@${finding.line}`)).toEqual(['dynamic-ddl-uncovered@1']);
  });

  it('checks every statement of a multi-statement literal, not only the first', () => {
    const root = tree({
      'src/a.ts': "export const q = 'SELECT pk FROM messages; SELECT not_a_column FROM messages';\n",
    });
    const result = scanSqlSchema({ repoRoot: root, allowlist: [], schema });
    expect(result.findings.map((finding) => finding.message)).toEqual(['no such column: not_a_column']);
  });

  it('folds a + chain of plain literals before checking it', () => {
    const root = tree({
      'src/a.ts': "export const q = 'SELECT pk, bogus_col ' + 'FROM messages';\n",
    });
    const result = scanSqlSchema({ repoRoot: root, allowlist: [], schema });
    expect(result.findings.map((finding) => finding.message)).toEqual(['no such column: bogus_col']);
  });

  it('refuses to certify a tree with no source files', () => {
    const result = scanSqlSchema({ repoRoot: tree({}), allowlist: [], schema });
    expect(result.status).toBe('inconclusive');
    expect(result.inconclusive.join('\n')).toMatch(/0 source file|root-unreadable/);
  });

  it('exits 2 INCONCLUSIVE from the CLI on an empty tree', () => {
    const root = tree({ 'README.md': 'empty\n' });
    const run = spawnSync(
      process.execPath,
      ['--experimental-strip-types', path.join(REPO_ROOT, 'scripts/sql-schema-guard.ts'), '--root', root],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('INCONCLUSIVE');
  });

  it('keeps a CREATE TRIGGER body together when splitting statements', () => {
    const statements = splitStatements(
      "CREATE TRIGGER t AFTER INSERT ON messages BEGIN UPDATE messages SET content = 'a;b' WHERE id = NEW.id; END; SELECT 1 FROM messages",
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/END$/);
  });

  it('ships an allow-list where every entry has a reason', () => {
    const entries = loadAllowlist();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.reason.trim().length).toBeGreaterThan(10);
  });
});
