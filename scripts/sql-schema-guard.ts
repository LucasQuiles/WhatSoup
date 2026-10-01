#!/usr/bin/env node
/**
 * sql-schema-guard.ts — fail when an SQL literal in `src/` names a table or
 * column the bot database does not have (#3610).
 *
 * Motivation: `extendTrigger` shipped `UPDATE bead_triggers SET ... crash_count=0`
 * (#3061) against a table that never had that column. TypeScript does not look
 * inside SQL strings and no test executed the branch, so it survived review and
 * CI for weeks (#3607). The defect class is not specific to substrate, so the
 * guard scans every `.ts` file under `src/` (owner ruling on #3610, option B).
 *
 * HOW THE SCHEMA IS BUILT (executed, not parsed):
 *   1. `new Database(':memory:').open()` runs every registered migration.
 *   2. RUNTIME_SCHEMA_INITIALIZERS run next. They cover the stores whose column
 *      adds are built from template strings, which step 3 cannot see.
 *   3. Every static DDL literal (CREATE TABLE/INDEX/VIEW/TRIGGER, ALTER TABLE
 *      ... ADD COLUMN) found in a scanned file that is not a schema source is
 *      executed, repeated until no further statement succeeds (an index can
 *      depend on a column another file adds). "already exists" and "duplicate
 *      column" are the idempotent no-op outcomes; any other DDL failure is a
 *      finding. DROP and RENAME are never executed.
 *
 * HOW A LITERAL IS CHECKED: SQLite itself compiles it. Each statement of a
 * literal is passed to `prepare`, which resolves tables, columns, aliases, CTEs
 * and subqueries exactly and executes nothing. "no such table", "no such
 * column" and "has no column named" are findings. A statement SQLite cannot
 * compile for any other reason is also a finding (kind `unparseable`) unless an
 * allow-list entry names it, so a literal can never drop out of coverage
 * silently.
 *
 * WHAT IS A LITERAL: a string or no-substitution template whose trimmed text
 * starts with an UPPERCASE SQL statement shape (SELECT ... FROM, INSERT INTO,
 * UPDATE <t> SET, DELETE FROM, WITH, REPLACE INTO, CREATE ..., ALTER TABLE).
 * Uppercase-only is deliberate: every SQL literal in src is uppercase, and a
 * case-insensitive match would pull in English prose ("Select a model from").
 * A `+` chain made only of literals is folded first. A template with `${}`
 * substitutions is dynamic: it is skipped and counted, never failed.
 *
 * THE ALLOW-LIST (`scripts/sql-schema-guard.allowlist.json`) names what is not
 * checked against the bot schema, each entry with a reason:
 *   - `separate-database`: a file or directory that talks to another database.
 *   - `schema-source`: migration files. Their SQL runs against historical
 *     shapes, and step 1 already executes all of it.
 *   - `schema-host`: a file that holds inline migrations AND runtime queries
 *     (src/core/database.ts). Its DDL is not replayed, because step 1 already
 *     ran it and replaying would add intermediate rebuild tables; its other
 *     statements are still checked.
 *   - `literal`: one statement in one file, matched by a SQL substring.
 * An entry that matches nothing fails the guard, so the list cannot go stale.
 *
 * Exit codes: 0 clean, 1 findings, 2 inconclusive (nothing scanned, the
 * source inventory failed, or the schema could not be built).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

import type { Database } from '../src/core/database.ts';
import { inventorySourceFiles, normalizeRepoPath } from './lib/guard-core.ts';

const TAG = 'sql-schema';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, '..');
export const DEFAULT_ALLOWLIST_PATH = path.join(SCRIPT_DIR, 'sql-schema-guard.allowlist.json');

export type AllowlistKind = 'separate-database' | 'schema-source' | 'schema-host' | 'literal';

export interface AllowlistEntry {
  kind: AllowlistKind;
  /** Repo-relative file, or a directory prefix ending in `/`. */
  path: string;
  /** For `literal` entries: a substring of the statement text. */
  match?: string;
  reason: string;
}

/**
 * Stores whose column adds are template strings (`ADD COLUMN ${col} ${def}`),
 * which the static DDL pass cannot execute. The self-check below fails the
 * guard when a scanned file has dynamic DDL and is not listed here.
 */
export const RUNTIME_SCHEMA_INITIALIZERS: ReadonlyArray<{
  readonly file: string;
  readonly exportName: string;
}> = [
  { file: 'src/runtimes/agent/session-db.ts', exportName: 'ensureAgentSchema' },
  { file: 'src/runtimes/agent/chat-preference-db.ts', exportName: 'ensureChatPreferenceSchema' },
];

/** The executed half of the schema: migrations plus runtime initializers. */
export interface SchemaModules {
  openMigratedDatabase(): Database;
  initializers: ReadonlyArray<{ file: string; run: (db: Database) => void }>;
}

/**
 * Import the database and initializer modules at call time. The logger reads
 * LOG_LEVEL when it is first imported, so a static import would print one line
 * per migration into the guard's output (and into `--json`).
 */
export async function loadSchemaModules(): Promise<SchemaModules> {
  const databaseModule = (await import(pathToFileURL(path.join(REPO_ROOT, 'src/core/database.ts')).href)) as {
    Database: new (dbPath: string) => Database;
  };
  const initializers: Array<{ file: string; run: (db: Database) => void }> = [];
  for (const init of RUNTIME_SCHEMA_INITIALIZERS) {
    const mod = (await import(pathToFileURL(path.join(REPO_ROOT, init.file)).href)) as Record<string, unknown>;
    const run = mod[init.exportName];
    if (typeof run !== 'function') throw new Error(`${init.file} does not export ${init.exportName}`);
    initializers.push({ file: init.file, run: run as (db: Database) => void });
  }
  return {
    openMigratedDatabase: () => {
      const db = new databaseModule.Database(':memory:');
      db.open();
      return db;
    },
    initializers,
  };
}

export type FindingKind = 'missing-name' | 'unparseable' | 'ddl-failed' | 'dynamic-ddl-uncovered' | 'stale-allowlist';

export interface SqlSchemaFinding {
  kind: FindingKind;
  file: string;
  line: number;
  message: string;
  sql: string;
}

export interface SqlSchemaReport {
  status: 'pass' | 'block' | 'inconclusive';
  filesScanned: number;
  literalsFound: number;
  statementsChecked: number;
  ddlExecuted: number;
  skippedDynamic: number;
  skippedAllowlisted: number;
  allowlistUsed: Array<AllowlistEntry & { hits: number }>;
  findings: SqlSchemaFinding[];
  inconclusive: string[];
}

interface SqlLiteral {
  file: string;
  line: number;
  text: string;
}

interface FileExtraction {
  literals: SqlLiteral[];
  dynamicSql: number;
  dynamicDdlLines: number[];
}

const SQL_START = new RegExp(
  '^(?:'
    + 'SELECT\\b[\\s\\S]*\\bFROM\\b'
    + '|INSERT\\s+(?:OR\\s+[A-Z]+\\s+)?INTO\\b'
    + '|REPLACE\\s+INTO\\b'
    + '|UPDATE\\s+(?:OR\\s+[A-Z]+\\s+)?[\\w"`\\[\\]]+\\s+SET\\b'
    + '|DELETE\\s+FROM\\b'
    + '|WITH\\s+(?:RECURSIVE\\s+)?\\w+\\s*(?:\\(|AS\\b)'
    + '|CREATE\\s+(?:UNIQUE\\s+|TEMP\\s+|TEMPORARY\\s+|VIRTUAL\\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\\b'
    + '|ALTER\\s+TABLE\\b'
    + ')',
);
const DDL_START = /^(?:CREATE|ALTER)\b/;
const EXECUTABLE_DDL = /^(?:CREATE\s+(?:UNIQUE\s+|TEMP\s+|TEMPORARY\s+|VIRTUAL\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\b|ALTER\s+TABLE\s+\S+\s+ADD\s+(?:COLUMN\s+)?)/i;
const IDEMPOTENT_DDL_ERROR = /already exists|duplicate column name/;
const MISSING_NAME_ERROR = /no such table|no such column|has no column named/;

/** Drop leading `--` and `/* *\/` comments so the statement keyword is first. */
function stripLeadingComments(sql: string): string {
  let text = sql.trimStart();
  for (;;) {
    if (text.startsWith('--')) {
      const end = text.indexOf('\n');
      text = end < 0 ? '' : text.slice(end + 1).trimStart();
    } else if (text.startsWith('/*')) {
      const end = text.indexOf('*/');
      text = end < 0 ? '' : text.slice(end + 2).trimStart();
    } else {
      return text;
    }
  }
}

export function looksLikeSql(text: string): boolean {
  return SQL_START.test(stripLeadingComments(text));
}

/**
 * Split a literal into statements on top-level semicolons. Quotes, brackets and
 * comments are respected; a CREATE TRIGGER body runs to its closing END.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) statements.push(trimmed);
    current = '';
  };
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ';') {
      const head = stripLeadingComments(current).toUpperCase();
      const isTrigger = /^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/.test(head);
      if (isTrigger && !/\bEND\s*$/.test(head)) {
        current += ch;
        i += 1;
        continue;
      }
      flush();
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  flush();
  return statements;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function isPlusChain(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

/** Fold a `+` chain; null when any leaf is not a static string. */
function foldPlusChain(node: ts.Expression): string | null {
  if (ts.isParenthesizedExpression(node)) return foldPlusChain(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (isPlusChain(node)) {
    const left = foldPlusChain(node.left);
    const right = foldPlusChain(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

/** Extract SQL-shaped literals from one TypeScript source file. */
export function extractSqlLiterals(file: string, content: string): FileExtraction {
  const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const literals: SqlLiteral[] = [];
  let dynamicSql = 0;
  const dynamicDdlLines: number[] = [];

  const visit = (node: ts.Node): void => {
    if (isPlusChain(node) && !(node.parent && isPlusChain(node.parent))) {
      const folded = foldPlusChain(node);
      if (folded !== null) {
        if (looksLikeSql(folded)) literals.push({ file, line: lineOf(sourceFile, node), text: folded });
        return;
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (looksLikeSql(node.text)) literals.push({ file, line: lineOf(sourceFile, node), text: node.text });
      return;
    }
    if (ts.isTemplateExpression(node)) {
      // Each substitution becomes a placeholder word so the statement shape
      // (e.g. `SELECT ${cols} FROM t`) is still recognised as SQL.
      const whole = stripLeadingComments(
        node.head.text + node.templateSpans.map((span) => ` __dynamic__ ${span.literal.text}`).join(''),
      );
      if (looksLikeSql(whole)) {
        dynamicSql += 1;
        if (DDL_START.test(whole)) dynamicDdlLines.push(lineOf(sourceFile, node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { literals, dynamicSql, dynamicDdlLines };
}

/** Exact file, a directory ending in `/`, or a file-name prefix ending in `*`. */
function matchesPath(entryPath: string, file: string): boolean {
  if (entryPath.endsWith('/')) return file.startsWith(entryPath);
  if (entryPath.endsWith('*')) return file.startsWith(entryPath.slice(0, -1));
  return file === entryPath;
}

export function loadAllowlist(filePath: string = DEFAULT_ALLOWLIST_PATH): AllowlistEntry[] {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { entries?: unknown };
  if (!Array.isArray(parsed.entries)) throw new Error(`${filePath}: expected an "entries" array`);
  return parsed.entries.map((raw, index) => {
    const entry = raw as Partial<AllowlistEntry>;
    const kinds: AllowlistKind[] = ['separate-database', 'schema-source', 'schema-host', 'literal'];
    if (!entry.kind || !kinds.includes(entry.kind)) throw new Error(`${filePath}: entry ${index} has an unknown kind`);
    if (!entry.path) throw new Error(`${filePath}: entry ${index} has no path`);
    if (!entry.reason || entry.reason.trim().length === 0) throw new Error(`${filePath}: entry ${index} has no reason`);
    if (entry.kind === 'literal' && !entry.match) throw new Error(`${filePath}: literal entry ${index} has no match`);
    return { kind: entry.kind, path: entry.path, reason: entry.reason, ...(entry.match ? { match: entry.match } : {}) };
  });
}

function snippet(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ScanOptions {
  repoRoot: string;
  allowlist: readonly AllowlistEntry[];
  schema: SchemaModules;
}

/** Scan `<repoRoot>/src` and check every SQL literal against the bot schema. */
export function scanSqlSchema(options: ScanOptions): SqlSchemaReport {
  const report: SqlSchemaReport = {
    status: 'pass',
    filesScanned: 0,
    literalsFound: 0,
    statementsChecked: 0,
    ddlExecuted: 0,
    skippedDynamic: 0,
    skippedAllowlisted: 0,
    allowlistUsed: [],
    findings: [],
    inconclusive: [],
  };
  const hits = new Map<AllowlistEntry, number>(options.allowlist.map((entry) => [entry, 0]));
  const hit = (entry: AllowlistEntry): void => {
    hits.set(entry, (hits.get(entry) ?? 0) + 1);
  };

  const inventory = inventorySourceFiles({
    repoRoot: options.repoRoot,
    roots: ['src'],
    includeFile: (file) => file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.endsWith('.test.ts'),
    excludeDirectory: (directory) => ['node_modules', '.git', 'dist'].includes(path.basename(directory)),
  });
  for (const issue of inventory.issues) {
    report.inconclusive.push(`source inventory: ${issue.code} ${issue.operation} ${issue.path}`);
  }
  report.filesScanned = inventory.files.length;
  if (report.filesScanned === 0) {
    report.inconclusive.push(`examined 0 source file(s) under ${path.join(options.repoRoot, 'src')}`);
  }
  if (report.inconclusive.length > 0) {
    report.status = 'inconclusive';
    return report;
  }

  const initializerFiles = new Set(RUNTIME_SCHEMA_INITIALIZERS.map((init) => init.file));
  const ddl: SqlLiteral[] = [];
  const dml: SqlLiteral[] = [];

  for (const source of inventory.files) {
    const file = normalizeRepoPath(source.path);
    const fileEntry = options.allowlist.find(
      (entry) => entry.kind !== 'literal' && matchesPath(entry.path, file),
    );
    const extraction = extractSqlLiterals(file, source.content);
    const schemaHost = fileEntry?.kind === 'schema-host';
    if (fileEntry && !schemaHost) {
      const count = extraction.literals.length + extraction.dynamicSql;
      if (count > 0) {
        hit(fileEntry);
        report.skippedAllowlisted += count;
      }
      continue;
    }
    report.literalsFound += extraction.literals.length;
    report.skippedDynamic += extraction.dynamicSql;
    if (extraction.dynamicDdlLines.length > 0 && !initializerFiles.has(file) && !schemaHost) {
      for (const line of extraction.dynamicDdlLines) {
        report.findings.push({
          kind: 'dynamic-ddl-uncovered',
          file,
          line,
          message: 'DDL built from a template; add its schema function to RUNTIME_SCHEMA_INITIALIZERS',
          sql: '',
        });
      }
    }
    for (const literal of extraction.literals) {
      for (const statement of splitStatements(literal.text)) {
        const unit = { ...literal, text: statement };
        const isDdl = EXECUTABLE_DDL.test(stripLeadingComments(statement));
        if (isDdl && fileEntry && schemaHost) {
          // Migration DDL already ran in the migration registry; replaying it
          // here would add intermediate tables (e.g. *_v26) to the schema.
          hit(fileEntry);
          report.skippedAllowlisted += 1;
        } else if (isDdl) {
          ddl.push(unit);
        } else {
          dml.push(unit);
        }
      }
    }
  }

  let database: Database;
  try {
    database = options.schema.openMigratedDatabase();
    for (const init of options.schema.initializers) init.run(database);
  } catch (error) {
    report.inconclusive.push(`could not build the bot schema: ${errorMessage(error)}`);
    report.status = 'inconclusive';
    return report;
  }

  try {
    const raw = database.raw;
    const literalEntry = (unit: SqlLiteral): AllowlistEntry | undefined => options.allowlist.find(
      (entry) => entry.kind === 'literal' && matchesPath(entry.path, unit.file) && unit.text.includes(entry.match ?? '\0'),
    );

    // Runtime DDL: retry until a pass makes no progress.
    let pending = ddl;
    let failures = new Map<SqlLiteral, string>();
    for (;;) {
      const nextPending: SqlLiteral[] = [];
      failures = new Map();
      for (const unit of pending) {
        try {
          raw.exec(unit.text);
          report.ddlExecuted += 1;
        } catch (error) {
          const message = errorMessage(error);
          if (IDEMPOTENT_DDL_ERROR.test(message)) {
            report.ddlExecuted += 1;
          } else {
            nextPending.push(unit);
            failures.set(unit, message);
          }
        }
      }
      if (nextPending.length === 0 || nextPending.length === pending.length) {
        pending = nextPending;
        break;
      }
      pending = nextPending;
    }
    for (const unit of pending) {
      const entry = literalEntry(unit);
      if (entry) {
        hit(entry);
        report.skippedAllowlisted += 1;
        continue;
      }
      report.findings.push({
        kind: 'ddl-failed',
        file: unit.file,
        line: unit.line,
        message: failures.get(unit) ?? 'DDL failed',
        sql: snippet(unit.text),
      });
    }

    for (const unit of dml) {
      const entry = literalEntry(unit);
      if (entry) {
        hit(entry);
        report.skippedAllowlisted += 1;
        continue;
      }
      report.statementsChecked += 1;
      try {
        raw.prepare(unit.text);
      } catch (error) {
        const message = errorMessage(error);
        report.findings.push({
          kind: MISSING_NAME_ERROR.test(message) ? 'missing-name' : 'unparseable',
          file: unit.file,
          line: unit.line,
          message,
          sql: snippet(unit.text),
        });
      }
    }
  } finally {
    database.close();
  }

  for (const [entry, count] of hits) {
    if (count === 0) {
      report.findings.push({
        kind: 'stale-allowlist',
        file: entry.path,
        line: 0,
        message: `allow-list entry (${entry.kind}${entry.match ? `: ${entry.match}` : ''}) matched nothing; remove it`,
        sql: '',
      });
    } else {
      report.allowlistUsed.push({ ...entry, hits: count });
    }
  }

  if (report.literalsFound === 0) {
    report.inconclusive.push('found 0 SQL literals outside the allow-list; refusing to certify a scan that checked nothing');
    report.status = 'inconclusive';
    return report;
  }
  report.status = report.findings.length === 0 ? 'pass' : 'block';
  return report;
}

function printHuman(report: SqlSchemaReport): void {
  for (const entry of report.allowlistUsed) {
    const what = entry.match ? `${entry.path} [${entry.match}]` : entry.path;
    console.log(`[${TAG}] allow-list ${entry.kind} ${what} (${entry.hits} skipped): ${entry.reason}`);
  }
  const counts = `files=${report.filesScanned} literals=${report.literalsFound} statements-checked=${report.statementsChecked}`
    + ` ddl-executed=${report.ddlExecuted} skipped-dynamic=${report.skippedDynamic}`
    + ` skipped-allowlisted=${report.skippedAllowlisted} findings=${report.findings.length}`;
  if (report.status === 'inconclusive') {
    for (const reason of report.inconclusive) console.error(`[${TAG}] INCONCLUSIVE ${reason}`);
    console.error(`[${TAG}] ${counts}`);
    return;
  }
  for (const finding of report.findings) {
    const where = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
    console.error(`  ${where}  ${finding.kind}  ${finding.message}${finding.sql ? `  | ${finding.sql}` : ''}`);
  }
  if (report.status === 'block') {
    console.error(`[${TAG}] BLOCK ${report.findings.length} SQL literal finding(s); fix the SQL or the schema. ${counts}`);
  } else {
    console.log(`[${TAG}] clean ${counts}`);
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  let repoRoot = process.cwd();
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--root' && argv[i + 1]) {
      repoRoot = path.resolve(argv[i + 1]!);
      i += 1;
    } else {
      console.error(`Usage: sql-schema-guard.ts [--root <repo>] [--json]`);
      return 2;
    }
  }
  let report: SqlSchemaReport;
  try {
    // Must be set before the dynamic import in loadSchemaModules (see there).
    process.env.LOG_LEVEL ??= 'silent';
    report = scanSqlSchema({ repoRoot, allowlist: loadAllowlist(), schema: await loadSchemaModules() });
  } catch (error) {
    console.error(`[${TAG}] INCONCLUSIVE ${errorMessage(error)}`);
    return 2;
  }
  if (json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  return report.status === 'pass' ? 0 : report.status === 'block' ? 1 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[${TAG}] INCONCLUSIVE runner fault: ${errorMessage(error)}`);
      process.exit(2);
    },
  );
}
