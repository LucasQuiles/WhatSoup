import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  parseForensicHarnessSearchResult,
  scanJsonlHarnessSource,
  scanJsonlHarnessSources,
  scanOpenCodeSnapshot,
  verifyForensicPackage,
  writeForensicPackage,
  type ForensicQuery,
} from './lib/forensic-package.ts';

type Command = 'schema' | 'scan-jsonl' | 'scan-jsonl-set' | 'scan-opencode' | 'build' | 'verify';

const CLI_SCHEMA = Object.freeze({
  schema_version: 'forensic.reconstruction-cli.v1',
  commands: {
    schema: { required: [], optional: [] },
    'scan-jsonl': {
      required: [
        'family', 'pass', 'source-alias', 'source', 'expected-sha256', 'queries', 'output',
      ],
      optional: ['prior', 'max-source-bytes', 'max-record-bytes', 'max-hits'],
    },
    'scan-jsonl-set': {
      required: ['pass', 'sources', 'queries', 'output'],
      optional: ['prior', 'max-source-bytes', 'max-record-bytes', 'max-hits'],
    },
    'scan-opencode': {
      required: ['pass', 'source-alias', 'database', 'expected-sha256', 'queries', 'output'],
      optional: ['prior', 'expected-members', 'max-source-bytes', 'max-rows', 'max-hits'],
    },
    build: { required: ['spec', 'output', 'forbidden-terms'], optional: [] },
    verify: { required: ['package', 'expected-manifest-sha256', 'forbidden-terms'], optional: [] },
  },
  exit_codes: {
    0: 'operation complete and output structurally valid; investigation saturation is reported in the package',
    2: 'inconclusive, invalid input, source failure, or tool failure',
  },
});

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!keys.has(key)) throw new TypeError(`${label} has unknown key: ${key}`);
  }
}

function parseOptions(
  argv: readonly string[],
  required: readonly string[],
  optional: readonly string[],
): Map<string, string> {
  if (argv.length % 2 !== 0) throw new TypeError('arguments must be --name value pairs');
  const allowed = new Set([...required, ...optional]);
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value) throw new TypeError('arguments must be --name value pairs');
    const name = flag.slice(2);
    if (!allowed.has(name)) throw new TypeError(`unknown argument: ${flag}`);
    if (options.has(name)) throw new TypeError(`duplicate argument: ${flag}`);
    options.set(name, value);
  }
  for (const name of required) {
    if (!options.has(name)) throw new TypeError(`missing --${name}`);
  }
  return options;
}

function option(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined) throw new TypeError(`missing --${name}`);
  return value;
}

function integerOption(
  options: ReadonlyMap<string, string>,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = options.get(name);
  if (raw === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) throw new TypeError(`--${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`--${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function readJson(file: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} could not be read as JSON: ${(error as Error).message}`);
  }
}

function readQueries(file: string): ForensicQuery[] {
  const input = asRecord(readJson(file, 'query file'), 'query file');
  exactKeys(input, ['schema_version', 'queries'], 'query file');
  if (input.schema_version !== 'forensic.session-query.v1') {
    throw new TypeError('query file schema_version must be forensic.session-query.v1');
  }
  if (!Array.isArray(input.queries) || input.queries.length === 0) {
    throw new TypeError('query file queries must be a non-empty array');
  }
  return input.queries.map((value, index) => {
    const query = asRecord(value, `queries[${index}]`);
    exactKeys(query, ['id', 'mode', 'text'], `queries[${index}]`);
    if (typeof query.id !== 'string' || typeof query.text !== 'string') {
      throw new TypeError(`queries[${index}] id and text must be strings`);
    }
    if (query.mode !== 'substring' && query.mode !== 'all_tokens') {
      throw new TypeError(`queries[${index}].mode is unsupported`);
    }
    return { id: query.id, mode: query.mode, text: query.text };
  });
}

function readForbiddenTerms(file: string | undefined): readonly string[] {
  if (file === undefined) return [];
  const input = asRecord(readJson(file, 'forbidden terms file'), 'forbidden terms file');
  exactKeys(input, ['schema_version', 'terms'], 'forbidden terms file');
  if (input.schema_version !== 'forensic.forbidden-terms.v1') {
    throw new TypeError('forbidden terms file schema_version must be forensic.forbidden-terms.v1');
  }
  if (!Array.isArray(input.terms)) throw new TypeError('forbidden terms file terms must be an array');
  return input.terms.map((term, index) => {
    if (typeof term !== 'string') throw new TypeError(`forbidden terms file terms[${index}] must be a string`);
    return term;
  });
}

function priorEvidenceIds(file: string | undefined): Set<string> {
  if (file === undefined) return new Set();
  const result = parseForensicHarnessSearchResult(readJson(file, 'prior search result'));
  return new Set(result.sources.flatMap((source) => source.hits.map((hit) => hit.evidence_id)));
}

function writeJsonNoClobber(file: string, value: unknown): void {
  const temporary = `${file}.partial-${process.pid}-${randomUUID()}`;
  if (existsSync(temporary)) throw new Error(`temporary output path already exists: ${temporary}`);
  const content = `${JSON.stringify(value, null, 2)}\n`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    linkSync(temporary, file);
    const parent = openSync(path.dirname(file), 'r');
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`output path already exists: ${file}`);
    }
    throw error;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

async function scanJsonl(options: ReadonlyMap<string, string>, cwd: string): Promise<number> {
  const family = option(options, 'family');
  if (family !== 'claude' && family !== 'codex') throw new TypeError('--family must be claude or codex');
  const result = await scanJsonlHarnessSource({
    family,
    pass: integerOption(options, 'pass', 0, 1),
    sourceAlias: option(options, 'source-alias'),
    sourcePath: path.resolve(cwd, option(options, 'source')),
    expectedSha256: option(options, 'expected-sha256'),
    queries: readQueries(path.resolve(cwd, option(options, 'queries'))),
    priorEvidenceIds: priorEvidenceIds(options.get('prior') === undefined
      ? undefined
      : path.resolve(cwd, option(options, 'prior'))),
    limits: {
      maxSourceBytes: integerOption(options, 'max-source-bytes', 134_217_728, 1),
      maxRecordBytes: integerOption(options, 'max-record-bytes', 8_388_608, 1),
      maxHits: integerOption(options, 'max-hits', 1_000, 0),
    },
  });
  writeJsonNoClobber(path.resolve(cwd, option(options, 'output')), result);
  return result.metrics.failed_sources === 0 ? 0 : 2;
}

function readJsonlSourceSet(file: string): {
  family: 'claude' | 'codex';
  sources: Array<{ alias: string; path: string; expectedSha256: string }>;
} {
  const value = asRecord(readJson(file, 'JSONL source set'), 'JSONL source set');
  exactKeys(value, ['schema_version', 'family', 'sources'], 'JSONL source set');
  if (value.schema_version !== 'forensic.jsonl-source-set.v1') {
    throw new TypeError('JSONL source set schema_version must be forensic.jsonl-source-set.v1');
  }
  if (value.family !== 'claude' && value.family !== 'codex') {
    throw new TypeError('JSONL source set family must be claude or codex');
  }
  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    throw new TypeError('JSONL source set sources must be a non-empty array');
  }
  const base = path.dirname(file);
  const sources = value.sources.map((item, index) => {
    const source = asRecord(item, `JSONL source set sources[${index}]`);
    exactKeys(source, ['alias', 'path', 'sha256'], `JSONL source set sources[${index}]`);
    if (typeof source.alias !== 'string' || typeof source.path !== 'string' || typeof source.sha256 !== 'string') {
      throw new TypeError(`JSONL source set sources[${index}] fields must be strings`);
    }
    return {
      alias: source.alias,
      path: path.resolve(base, source.path),
      expectedSha256: source.sha256,
    };
  });
  return { family: value.family, sources };
}

async function scanJsonlSet(options: ReadonlyMap<string, string>, cwd: string): Promise<number> {
  const sourceSetPath = path.resolve(cwd, option(options, 'sources'));
  const sourceSet = readJsonlSourceSet(sourceSetPath);
  const result = await scanJsonlHarnessSources({
    family: sourceSet.family,
    pass: integerOption(options, 'pass', 0, 1),
    sources: sourceSet.sources,
    queries: readQueries(path.resolve(cwd, option(options, 'queries'))),
    priorEvidenceIds: priorEvidenceIds(options.get('prior') === undefined
      ? undefined
      : path.resolve(cwd, option(options, 'prior'))),
    limits: {
      maxSourceBytes: integerOption(options, 'max-source-bytes', 134_217_728, 1),
      maxRecordBytes: integerOption(options, 'max-record-bytes', 8_388_608, 1),
      maxHits: integerOption(options, 'max-hits', 1_000, 0),
    },
  });
  writeJsonNoClobber(path.resolve(cwd, option(options, 'output')), result);
  return result.metrics.failed_sources === 0 ? 0 : 2;
}

function readExpectedMembers(file: string | undefined): Array<{
  name: 'database' | 'wal' | 'shm'; bytes: number; sha256: string;
}> | undefined {
  if (file === undefined) return undefined;
  const value = readJson(file, 'expected members file');
  if (!Array.isArray(value)) throw new TypeError('expected members file must be an array');
  return value.map((item, index) => {
    const member = asRecord(item, `expected members[${index}]`);
    exactKeys(member, ['name', 'bytes', 'sha256'], `expected members[${index}]`);
    if (!['database', 'wal', 'shm'].includes(String(member.name))) {
      throw new TypeError(`expected members[${index}].name is unsupported`);
    }
    if (!Number.isSafeInteger(member.bytes) || Number(member.bytes) < 0) {
      throw new TypeError(`expected members[${index}].bytes must be a non-negative integer`);
    }
    if (typeof member.sha256 !== 'string') throw new TypeError(`expected members[${index}].sha256 must be a string`);
    return {
      name: member.name as 'database' | 'wal' | 'shm',
      bytes: Number(member.bytes),
      sha256: member.sha256,
    };
  });
}

function scanOpenCode(options: ReadonlyMap<string, string>, cwd: string): number {
  const expectedMembers = options.get('expected-members');
  const result = scanOpenCodeSnapshot({
    pass: integerOption(options, 'pass', 0, 1),
    sourceAlias: option(options, 'source-alias'),
    databasePath: path.resolve(cwd, option(options, 'database')),
    expectedSha256: option(options, 'expected-sha256'),
    expectedMembers: readExpectedMembers(expectedMembers === undefined
      ? undefined
      : path.resolve(cwd, expectedMembers)),
    queries: readQueries(path.resolve(cwd, option(options, 'queries'))),
    priorEvidenceIds: priorEvidenceIds(options.get('prior') === undefined
      ? undefined
      : path.resolve(cwd, option(options, 'prior'))),
    limits: {
      maxSourceBytes: integerOption(options, 'max-source-bytes', 17_179_869_184, 1),
      maxRows: integerOption(options, 'max-rows', 1_000_000, 1),
      maxHits: integerOption(options, 'max-hits', 1_000, 0),
    },
  });
  writeJsonNoClobber(path.resolve(cwd, option(options, 'output')), result);
  return result.metrics.failed_sources === 0 ? 0 : 2;
}

export async function runForensicReconstruction(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
): Promise<number> {
  try {
    const [rawCommand, ...rest] = argv;
    const command = rawCommand as Command | undefined;
    if (!command || !(command in CLI_SCHEMA.commands)) {
      throw new TypeError('command must be one of schema, scan-jsonl, scan-jsonl-set, scan-opencode, build, verify');
    }
    const contract = CLI_SCHEMA.commands[command];
    if (command === 'schema') {
      if (rest.length > 0) throw new TypeError('schema does not accept arguments');
      console.log(JSON.stringify(CLI_SCHEMA, null, 2));
      return 0;
    }
    const options = parseOptions(rest, contract.required, contract.optional);
    if (command === 'scan-jsonl') return await scanJsonl(options, cwd);
    if (command === 'scan-jsonl-set') return await scanJsonlSet(options, cwd);
    if (command === 'scan-opencode') return scanOpenCode(options, cwd);
    if (command === 'build') {
      const spec = readJson(path.resolve(cwd, option(options, 'spec')), 'package spec');
      writeForensicPackage(spec, path.resolve(cwd, option(options, 'output')), {
        forbiddenTerms: readForbiddenTerms(path.resolve(cwd, option(options, 'forbidden-terms'))),
      });
      return 0;
    }
    const result = verifyForensicPackage(
      path.resolve(cwd, option(options, 'package')),
      option(options, 'expected-manifest-sha256'),
      {
        forbiddenTerms: readForbiddenTerms(path.resolve(cwd, option(options, 'forbidden-terms'))),
      },
    );
    console.log(JSON.stringify(result, null, 2));
    return result.valid ? 0 : 2;
  } catch (error) {
    console.error(`forensic reconstruction failed: ${(error as Error).message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runForensicReconstruction();
}
