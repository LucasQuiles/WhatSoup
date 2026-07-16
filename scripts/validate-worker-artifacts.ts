import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface WorkerArtifactIssue {
  code: string;
  filePath: string;
  message: string;
}

export interface WorkerArtifactResult {
  ok: boolean;
  checked: number;
  issues: WorkerArtifactIssue[];
}

export interface WorkerArtifactOptions {
  dir: string;
  now?: Date;
  maxAgeMs?: number;
  maxDurationMs?: number;
  allowNoReports?: boolean;
  requireMetadata?: boolean;
  requireManifest?: boolean;
  requiredMarkers?: string[];
}

interface ParsedArgs {
  dir: string;
  maxAgeMs?: number;
  maxDurationMs?: number;
  allowNoReports: boolean;
  requireMetadata: boolean;
  requireManifest: boolean;
  requiredMarkers: string[];
  help: boolean;
}

const REPORT_EXTENSIONS = new Set(['.json', '.md', '.out', '.txt']);
const MANIFEST_FILE_NAME = 'worker-run-manifest.tsv';
const REQUIRED_MANIFEST_COLUMNS = [
  'report',
  'metadata',
  'stderr',
  'model',
  'exitCode',
  'stdoutBytes',
  'stderrBytes',
  'outputSha256',
  'startedAt',
  'endedAt',
];

interface WorkerMetadata {
  exitCode?: unknown;
  model?: unknown;
  stdoutBytes?: unknown;
  stderrBytes?: unknown;
  report?: unknown;
  stderr?: unknown;
  outputSha256?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
}

interface ManifestRow {
  sourceLine: number;
  values: Record<string, string>;
  reportPath: string;
  metadataPath: string;
  stderrPath: string;
}

interface ParsedManifest {
  path: string;
  rowsByReport: Map<string, ManifestRow>;
}

function isReportFile(filePath: string): boolean {
  if (filePath.endsWith('.meta.json')) return false;
  const ext = path.extname(filePath);
  return REPORT_EXTENSIONS.has(ext);
}

function metadataPathFor(reportPath: string): string {
  const ext = path.extname(reportPath);
  return path.join(path.dirname(reportPath), `${path.basename(reportPath, ext)}.meta.json`);
}

function listReportFiles(dir: string, rootDir = dir, skipNestedManifestDirs = false): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        skipNestedManifestDirs
        && path.resolve(filePath) !== path.resolve(rootDir)
        && existsSync(path.join(filePath, MANIFEST_FILE_NAME))
      ) {
        continue;
      }
      files.push(...listReportFiles(filePath, rootDir, skipNestedManifestDirs));
    } else if (entry.isFile() && isReportFile(filePath)) {
      files.push(filePath);
    }
  }

  return files.sort();
}

function issue(issues: WorkerArtifactIssue[], code: string, filePath: string, message: string): void {
  issues.push({ code, filePath, message });
}

function sha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function resolveDeclaredPath(dir: string, declaredPath: string): string {
  if (path.isAbsolute(declaredPath)) return path.normalize(declaredPath);

  const fromCwd = path.resolve(declaredPath);
  if (existsSync(fromCwd)) return fromCwd;

  return path.resolve(dir, declaredPath);
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readManifest(
  dir: string,
  requireManifest: boolean,
  issues: WorkerArtifactIssue[],
): ParsedManifest | null {
  const manifestPath = path.join(dir, MANIFEST_FILE_NAME);
  if (!existsSync(manifestPath)) {
    if (requireManifest) {
      issue(
        issues,
        'missing-worker-manifest',
        manifestPath,
        `Worker run manifest is required at ${manifestPath}.`,
      );
    }
    return null;
  }

  const body = readFileSync(manifestPath, 'utf8');
  const lines = body.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    issue(issues, 'empty-worker-manifest', manifestPath, 'Worker run manifest must include a header and at least one worker row.');
    return { path: manifestPath, rowsByReport: new Map() };
  }

  const headers = lines[0].split('\t');
  const missingColumns = REQUIRED_MANIFEST_COLUMNS.filter((column) => !headers.includes(column));
  if (missingColumns.length > 0) {
    issue(
      issues,
      'invalid-worker-manifest',
      manifestPath,
      `Worker run manifest is missing required columns: ${missingColumns.join(', ')}.`,
    );
    return { path: manifestPath, rowsByReport: new Map() };
  }

  const rowsByReport = new Map<string, ManifestRow>();
  for (let i = 1; i < lines.length; i += 1) {
    const sourceLine = i + 1;
    const fields = lines[i].split('\t');
    const values = Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? '']));

    const emptyColumns = REQUIRED_MANIFEST_COLUMNS.filter((column) => !values[column]?.trim());
    if (emptyColumns.length > 0) {
      issue(
        issues,
        'invalid-worker-manifest-row',
        manifestPath,
        `Manifest row ${sourceLine} is missing values for: ${emptyColumns.join(', ')}.`,
      );
      continue;
    }

    const reportPath = resolveDeclaredPath(dir, values.report);
    const metadataPath = resolveDeclaredPath(dir, values.metadata);
    const stderrPath = resolveDeclaredPath(dir, values.stderr);
    const reportKey = path.resolve(reportPath);

    if (rowsByReport.has(reportKey)) {
      issue(
        issues,
        'duplicate-worker-manifest-report',
        manifestPath,
        `Manifest row ${sourceLine} duplicates report path ${values.report}.`,
      );
      continue;
    }

    for (const [column, resolvedPath] of [
      ['report', reportPath],
      ['metadata', metadataPath],
      ['stderr', stderrPath],
    ] as const) {
      if (!existsSync(resolvedPath)) {
        issue(
          issues,
          'worker-manifest-path-missing',
          manifestPath,
          `Manifest row ${sourceLine} declares ${column} path ${values[column]}, but the file does not exist.`,
        );
      }
    }

    rowsByReport.set(reportKey, { sourceLine, values, reportPath, metadataPath, stderrPath });
  }

  return { path: manifestPath, rowsByReport };
}

function validateManifestCompleteness(
  manifest: ParsedManifest | null,
  files: string[],
  issues: WorkerArtifactIssue[],
): void {
  if (!manifest) return;

  const reportKeys = new Set(files.map((filePath) => path.resolve(filePath)));
  for (const filePath of files) {
    const fileKey = path.resolve(filePath);
    if (!manifest.rowsByReport.has(fileKey)) {
      issue(
        issues,
        'worker-report-missing-from-manifest',
        filePath,
        'Worker report is present on disk but absent from worker-run-manifest.tsv.',
      );
    }
  }

  for (const row of manifest.rowsByReport.values()) {
    if (!reportKeys.has(path.resolve(row.reportPath))) {
      issue(
        issues,
        'worker-manifest-report-missing',
        manifest.path,
        `Manifest row ${row.sourceLine} references a report that is not in the validated report set: ${row.values.report}.`,
      );
    }
  }
}

export function validateWorkerArtifacts(options: WorkerArtifactOptions): WorkerArtifactResult {
  const now = options.now ?? new Date();
  const issues: WorkerArtifactIssue[] = [];
  const files = listReportFiles(options.dir, options.dir, options.requireManifest ?? false);
  const manifest = readManifest(options.dir, options.requireManifest ?? false, issues);

  validateManifestCompleteness(manifest, files, issues);

  if (files.length === 0 && !options.allowNoReports) {
    issue(issues, 'no-worker-reports', options.dir, 'No worker report artifacts were found.');
  }

  for (const filePath of files) {
    const stat = statSync(filePath);
    if (stat.size === 0) {
      issue(issues, 'empty-worker-report', filePath, 'Worker report is empty and cannot be used as evidence.');
      continue;
    }

    const body = readFileSync(filePath, 'utf8');
    if (!body.trim()) {
      issue(issues, 'blank-worker-report', filePath, 'Worker report only contains whitespace.');
    }

    const manifestRow = manifest?.rowsByReport.get(path.resolve(filePath));
    let endedAtMs: number | null = null;

    if (options.requireMetadata) {
      const metadataPath = manifestRow?.metadataPath ?? metadataPathFor(filePath);
      let metadata: WorkerMetadata | null = null;
      try {
        metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as WorkerMetadata;
      } catch (err) {
        issue(
          issues,
          'missing-or-malformed-worker-metadata',
          filePath,
          `Worker metadata is missing or not parseable at ${metadataPath}: ${(err as Error).message}`,
        );
      }

      if (metadata) {
        if (metadata.exitCode !== 0) {
          issue(issues, 'worker-nonzero-exit', filePath, 'Worker metadata must record exitCode: 0.');
        }
        if (typeof metadata.model !== 'string' || !metadata.model.trim()) {
          issue(issues, 'worker-missing-model', filePath, 'Worker metadata must include a non-empty model.');
        }
        if (typeof metadata.stdoutBytes !== 'number' || metadata.stdoutBytes <= 0) {
          issue(issues, 'worker-missing-stdout-bytes', filePath, 'Worker metadata must include positive stdoutBytes.');
        } else if (metadata.stdoutBytes !== stat.size) {
          issue(
            issues,
            'worker-stdout-byte-mismatch',
            filePath,
            `Worker metadata stdoutBytes=${metadata.stdoutBytes} does not match report size=${stat.size}.`,
          );
        }

        if (typeof metadata.outputSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(metadata.outputSha256)) {
          issue(issues, 'worker-missing-output-sha256', filePath, 'Worker metadata must include a 64-character outputSha256.');
        } else if (metadata.outputSha256.toLowerCase() !== sha256(body)) {
          issue(issues, 'worker-sha256-mismatch', filePath, 'Worker metadata outputSha256 does not match the report contents.');
        }

        if (typeof metadata.report === 'string' && path.resolve(resolveDeclaredPath(options.dir, metadata.report)) !== path.resolve(filePath)) {
          issue(issues, 'worker-report-path-mismatch', filePath, `Worker metadata report path does not match ${filePath}.`);
        }

        const declaredStderr = typeof metadata.stderr === 'string' && metadata.stderr.trim()
          ? resolveDeclaredPath(options.dir, metadata.stderr)
          : manifestRow?.stderrPath;
        if (declaredStderr) {
          if (!existsSync(declaredStderr)) {
            issue(issues, 'worker-stderr-missing', filePath, `Worker metadata declares stderr path ${declaredStderr}, but it does not exist.`);
          } else if (typeof metadata.stderrBytes === 'number' && metadata.stderrBytes !== statSync(declaredStderr).size) {
            issue(
              issues,
              'worker-stderr-byte-mismatch',
              filePath,
              `Worker metadata stderrBytes=${metadata.stderrBytes} does not match stderr size=${statSync(declaredStderr).size}.`,
            );
          }
        }

        const startedAtMs = parseTimestamp(metadata.startedAt);
        endedAtMs = parseTimestamp(metadata.endedAt);
        if (startedAtMs === null || endedAtMs === null) {
          issue(issues, 'worker-missing-time-bounds', filePath, 'Worker metadata must include valid startedAt and endedAt timestamps.');
        } else if (endedAtMs < startedAtMs) {
          issue(issues, 'worker-invalid-time-bounds', filePath, 'Worker metadata endedAt must not be earlier than startedAt.');
        } else if (options.maxDurationMs !== undefined && endedAtMs - startedAtMs > options.maxDurationMs) {
          issue(
            issues,
            'worker-duration-exceeded',
            filePath,
            `Worker duration ${Math.round((endedAtMs - startedAtMs) / 1000)}s exceeds max ${Math.round(options.maxDurationMs / 1000)}s.`,
          );
        }
      }
    }

    if (options.maxAgeMs !== undefined && now.getTime() - (endedAtMs ?? stat.mtimeMs) > options.maxAgeMs) {
      issue(issues, 'stale-worker-report', filePath, `Worker report is older than ${Math.round(options.maxAgeMs / 1000)} seconds.`);
    }

    if (path.extname(filePath) === '.json') {
      try {
        JSON.parse(body);
      } catch (err) {
        issue(issues, 'malformed-worker-json', filePath, `Worker JSON report is not parseable: ${(err as Error).message}`);
      }
    }

    for (const marker of options.requiredMarkers ?? []) {
      if (!body.includes(marker)) {
        issue(issues, 'missing-worker-marker', filePath, `Worker report does not contain required marker: ${marker}`);
      }
    }
  }

  return { ok: issues.length === 0, checked: files.length, issues };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    dir: path.join('artifacts', 'opencode-workers'),
    allowNoReports: false,
    requireMetadata: false,
    requireManifest: false,
    requiredMarkers: [],
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--dir') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('--dir requires a path');
      args.dir = next;
      i += 1;
    } else if (arg === '--max-age-minutes') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('--max-age-minutes requires a number');
      const minutes = Number(next);
      if (!Number.isFinite(minutes) || minutes < 0) throw new Error('--max-age-minutes must be a non-negative number');
      args.maxAgeMs = minutes * 60 * 1000;
      i += 1;
    } else if (arg === '--max-duration-minutes') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('--max-duration-minutes requires a number');
      const minutes = Number(next);
      if (!Number.isFinite(minutes) || minutes < 0) throw new Error('--max-duration-minutes must be a non-negative number');
      args.maxDurationMs = minutes * 60 * 1000;
      i += 1;
    } else if (arg === '--allow-no-reports') {
      args.allowNoReports = true;
    } else if (arg === '--require-metadata') {
      args.requireMetadata = true;
    } else if (arg === '--require-manifest') {
      args.requireManifest = true;
    } else if (arg === '--required-marker') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('--required-marker requires text');
      args.requiredMarkers.push(next);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`Usage: npm run guard:worker-artifacts -- --dir artifacts/opencode-workers [--max-age-minutes 60]

Validates worker report artifacts produced by OpenCode or other review workers.
Report files must be non-empty. JSON reports must parse.
Metadata files such as .err and .pid are ignored as evidence.
Use --require-metadata to require metadata with exitCode: 0, model, byte counts, hashes, and time bounds.
Use --require-manifest to require worker-run-manifest.tsv and complete report coverage.
Use --max-duration-minutes to reject overlong worker runs.
Use --required-marker <text> to require content markers such as "Verdict".`);
}

export function run(argv: string[] = process.argv.slice(2)): WorkerArtifactResult {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return { ok: true, checked: 0, issues: [] };
  }

  const result = validateWorkerArtifacts({
    dir: args.dir,
    maxAgeMs: args.maxAgeMs,
    maxDurationMs: args.maxDurationMs,
    allowNoReports: args.allowNoReports,
    requireMetadata: args.requireMetadata,
    requireManifest: args.requireManifest,
    requiredMarkers: args.requiredMarkers,
  });

  if (!result.ok) {
    for (const issue of result.issues) {
      console.error(`${issue.filePath} ${issue.code}: ${issue.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`worker artifact validation passed (${result.checked} reports)`);
  }

  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
