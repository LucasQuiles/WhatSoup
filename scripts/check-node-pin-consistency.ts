import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type NodePinSource =
  | '.nvmrc'
  | 'package.json#volta.node'
  | 'package.json#engines.node'
  | 'docker/Dockerfile'
  | 'deploy/whatsoup'
  | 'deploy/whatsoup-auth'
  | 'deploy/whatsoup-fleet';

export interface NodePinReading {
  source: NodePinSource;
  filePath: string;
  /** Concrete pinned version (e.g. "24.15.0"). null if the source intentionally has none. */
  version: string | null;
  /** Raw matched text used when reporting drift. */
  raw: string;
}

export interface NodePinDrift {
  /** Canonical version derived from .nvmrc. */
  canonical: string;
  /** Sources whose pinned version differs from canonical. */
  mismatches: NodePinReading[];
  /** Sources scanned but missing the expected pin marker. */
  missing: { source: NodePinSource; filePath: string; reason: string }[];
}

export interface NodePinOptions {
  cwd?: string;
}

const HARDCODED_NODE_PATH_PATTERN =
  /\/\.nvm\/versions\/node\/v(\d+\.\d+\.\d+)\/bin\/node/;
// Match any shell-level read of "$REPO_ROOT/.nvmrc" — `cat "$REPO_ROOT/.nvmrc"`,
// `tr ... < "$REPO_ROOT/.nvmrc"`, `<"$REPO_ROOT/.nvmrc"`, etc.
const NVMRC_REFERENCE_PATTERN = /\$\{?REPO_ROOT\}?\/\.nvmrc/;

const WRAPPER_SOURCES: { source: NodePinSource; relPath: string }[] = [
  { source: 'deploy/whatsoup', relPath: 'deploy/whatsoup' },
  { source: 'deploy/whatsoup-auth', relPath: 'deploy/whatsoup-auth' },
  { source: 'deploy/whatsoup-fleet', relPath: 'deploy/whatsoup-fleet' },
];

function readNvmrc(cwd: string): NodePinReading {
  const filePath = path.join(cwd, '.nvmrc');
  const raw = readFileSync(filePath, 'utf8').trim();
  return { source: '.nvmrc', filePath, version: raw, raw };
}

function readPackageJsonPins(cwd: string): NodePinReading[] {
  const filePath = path.join(cwd, 'package.json');
  const pkg = JSON.parse(readFileSync(filePath, 'utf8')) as {
    engines?: { node?: string };
    volta?: { node?: string };
  };
  const readings: NodePinReading[] = [];
  if (pkg.volta?.node) {
    readings.push({
      source: 'package.json#volta.node',
      filePath,
      version: pkg.volta.node.trim(),
      raw: pkg.volta.node,
    });
  } else {
    readings.push({
      source: 'package.json#volta.node',
      filePath,
      version: null,
      raw: '',
    });
  }
  if (pkg.engines?.node) {
    readings.push({
      source: 'package.json#engines.node',
      filePath,
      version: null,
      raw: pkg.engines.node,
    });
  }
  return readings;
}

function readDockerfilePins(cwd: string): NodePinReading[] {
  const filePath = path.join(cwd, 'docker/Dockerfile');
  const text = readFileSync(filePath, 'utf8');
  const readings: NodePinReading[] = [];
  const fromLine = /^FROM\s+node:(\S+?)(?:-slim|-alpine|-bookworm)?\s+AS\s+\S+/gim;
  let match: RegExpExecArray | null;
  while ((match = fromLine.exec(text)) !== null) {
    readings.push({
      source: 'docker/Dockerfile',
      filePath,
      version: match[1] ?? null,
      raw: match[0] ?? '',
    });
  }
  if (readings.length === 0) {
    readings.push({
      source: 'docker/Dockerfile',
      filePath,
      version: null,
      raw: '',
    });
  }
  return readings;
}

function readWrapperPin(
  cwd: string,
  source: NodePinSource,
  relPath: string,
): NodePinReading {
  const filePath = path.join(cwd, relPath);
  const text = readFileSync(filePath, 'utf8');
  if (NVMRC_REFERENCE_PATTERN.test(text)) {
    return { source, filePath, version: null, raw: 'reads .nvmrc' };
  }
  const m = text.match(HARDCODED_NODE_PATH_PATTERN);
  if (m) {
    return { source, filePath, version: m[1] ?? null, raw: m[0] ?? '' };
  }
  return { source, filePath, version: null, raw: '' };
}

export function collectNodePinReadings(
  options: NodePinOptions = {},
): NodePinReading[] {
  const cwd = options.cwd ?? process.cwd();
  const readings: NodePinReading[] = [];
  readings.push(readNvmrc(cwd));
  readings.push(...readPackageJsonPins(cwd));
  readings.push(...readDockerfilePins(cwd));
  for (const w of WRAPPER_SOURCES) {
    readings.push(readWrapperPin(cwd, w.source, w.relPath));
  }
  return readings;
}

export function findNodePinDrift(options: NodePinOptions = {}): NodePinDrift {
  const readings = collectNodePinReadings(options);
  const nvmrc = readings.find((r) => r.source === '.nvmrc');
  if (!nvmrc || !nvmrc.version) {
    throw new Error(
      '.nvmrc missing or empty — cannot determine canonical Node version',
    );
  }
  const canonical = nvmrc.version;

  const mismatches: NodePinReading[] = [];
  const missing: NodePinDrift['missing'] = [];

  for (const r of readings) {
    if (r.source === '.nvmrc') continue;
    if (r.source === 'package.json#engines.node') {
      const majorMatch = canonical.match(/^(\d+)/);
      const major = majorMatch ? majorMatch[1] : null;
      if (!major || !r.raw.includes(major)) {
        mismatches.push(r);
      }
      continue;
    }
    if (r.source === 'package.json#volta.node') {
      if (!r.version) {
        missing.push({
          source: r.source,
          filePath: r.filePath,
          reason: 'volta.node not set',
        });
        continue;
      }
      if (r.version !== canonical) mismatches.push(r);
      continue;
    }
    if (r.source === 'docker/Dockerfile') {
      if (!r.version) {
        missing.push({
          source: r.source,
          filePath: r.filePath,
          reason: 'no FROM node:<version> stage detected',
        });
        continue;
      }
      if (r.version !== canonical) mismatches.push(r);
      continue;
    }
    if (r.version === null && r.raw === 'reads .nvmrc') continue;
    if (r.version === null) {
      missing.push({
        source: r.source,
        filePath: r.filePath,
        reason: 'wrapper neither reads .nvmrc nor pins a Node path',
      });
      continue;
    }
    if (r.version !== canonical) mismatches.push(r);
  }

  return { canonical, mismatches, missing };
}

function printDrift(drift: NodePinDrift): void {
  console.error(`Canonical Node version (.nvmrc): ${drift.canonical}`);
  for (const m of drift.mismatches) {
    console.error(
      `  MISMATCH ${m.source} (${m.filePath}): pinned=${m.version ?? '<none>'} canonical=${drift.canonical} raw="${m.raw}"`,
    );
  }
  for (const m of drift.missing) {
    console.error(`  MISSING ${m.source} (${m.filePath}): ${m.reason}`);
  }
}

export function run(
  _argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): NodePinDrift {
  if (env.WHATSOUP_SKIP_NODE_PIN_CHECK === '1') {
    console.warn(
      'node-pin consistency check skipped via WHATSOUP_SKIP_NODE_PIN_CHECK=1',
    );
    return { canonical: '', mismatches: [], missing: [] };
  }
  const drift = findNodePinDrift({ cwd });
  if (drift.mismatches.length > 0 || drift.missing.length > 0) {
    printDrift(drift);
    process.exitCode = 1;
  } else {
    console.log(
      `node-pin consistency check passed (canonical=${drift.canonical})`,
    );
  }
  return drift;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
