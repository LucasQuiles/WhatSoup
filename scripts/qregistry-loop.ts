import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

type Disposition =
  | 'observed'
  | 'under-review'
  | 'approved'
  | 'in-progress'
  | 'implemented'
  | 'deferred'
  | 'superseded'
  | 'blocked-on-decision';

export interface QRegistryEntry {
  id: string;
  title: string;
  severity: 'low' | 'medium' | 'high';
  disposition: Disposition;
  kind?: string;
  files?: string[];
  risk?: string;
  unresolved_unknowns?: string[];
}

export interface WorkerPlan {
  role: 'review' | 'research';
  outputName: string;
  stagedFiles: string[];
  prompt: string;
}

interface SourceOptions {
  maxFiles: number;
  maxBytes: number;
}

interface WorkerPlanOptions {
  repoRoot: string;
  registerPath: string;
  auditPath: string;
  sourceFiles: string[];
  maxWorkers: number;
  maxItems: number;
}

interface DispatchArgs {
  currentHash: string;
  previousHash: string | null;
  force: boolean;
}

interface CliOptions {
  repoRoot: string;
  registerPath: string;
  stateDir: string;
  checkerPath: string;
  safeExporterPath: string | null;
  safeExporterExplicit: boolean;
  noDispatch: boolean;
  force: boolean;
  maxWorkers: number;
  maxItems: number;
  maxSourceFiles: number;
  maxSourceBytes: number;
}

const CLOSED_DISPOSITIONS = new Set<Disposition>(['approved', 'implemented', 'superseded']);
const SEVERITY_RANK = new Map<QRegistryEntry['severity'], number>([
  ['high', 0],
  ['medium', 1],
  ['low', 2],
]);

const DEFAULT_AUDIT = 'docs/audits/2026-06-27-memory-harness-gap-analysis.md';
const DEFAULT_MAX_WORKERS = 2;
const DEFAULT_MAX_ITEMS = 4;
const DEFAULT_MAX_SOURCE_FILES = 12;
const DEFAULT_MAX_SOURCE_BYTES = 160 * 1024;
const PINNED_WORKER_MODEL = 'glm/glm-5.2';
const CHILD_ENV_ALLOWLIST = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PYTHONPATH',
] as const;
const SECRET_REDACTIONS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._/-]{8,}/g, 'Bearer <redacted>'],
  [/\bsk-[A-Za-z0-9._-]{8,}/g, 'sk-<redacted>'],
  [/\b(jwt)\s*=\s*["'][^"']+["']/gi, '$1 = "<redacted>"'],
  [/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CLIENT_SECRET))\s*[:=]\s*["']?[^"'\n,} ]{8,}["']?/gi, '$1=<redacted>'],
  [/("?(?:api[_-]?key|token|secret|password|private[_-]?key|client[_-]?secret|jwt)"?\s*:\s*)"[^"]{8,}"/gi, '$1"<redacted>"'],
];
const SAFE_EXPORT_SCAN_PATTERNS: Array<[string, RegExp]> = [
  ['raw_whatsapp_user_or_group_jid', /\b\d{7,}@(s\.whatsapp\.net|g\.us)\b/],
  ['raw_lid', /\b[0-9A-Za-z_-]{8,}@lid\b/],
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._~-]+/],
  ['secret_assignment', /\b(token|secret|password|apikey|api_key)\s*=\s*[^\s`]+/i],
  ['auth_creds_path', /auth\/creds\.json/],
  ['pairing_code', /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/],
];

export function buildChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  extraEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = baseEnv[key];
    if (value !== undefined) out[key] = value;
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    out[key] = value;
  }
  return out;
}

export function resolveCheckerPath(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  pathExists: (candidate: string) => boolean = existsSync,
): string {
  const override = env.QREGISTRY_CHECKER?.trim();
  if (override) return path.resolve(override);

  const candidates = [
    path.resolve(repoRoot, '..', 'qRegistry', 'scripts', 'qregistry-check.py'),
    path.resolve(repoRoot, '..', '..', '..', 'qRegistry', 'scripts', 'qregistry-check.py'),
    ...(env.HOME ? [path.join(env.HOME, 'LAB', 'qRegistry', 'scripts', 'qregistry-check.py')] : []),
  ];

  return candidates.find(pathExists) ?? candidates[0]!;
}

export function resolveSafeExporterPath(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  pathExists: (candidate: string) => boolean = existsSync,
): string | null {
  const override = env.QREGISTRY_SAFE_EXPORTER?.trim();
  if (override) return path.resolve(override);

  const candidates = [
    path.resolve(repoRoot, '..', 'qRegistry', 'scripts', 'qregistry-safe-export.py'),
    path.resolve(repoRoot, '..', '..', '..', 'qRegistry', 'scripts', 'qregistry-safe-export.py'),
    ...(env.HOME ? [path.join(env.HOME, 'LAB', 'qRegistry', 'scripts', 'qregistry-safe-export.py')] : []),
  ];

  return candidates.find(pathExists) ?? null;
}

export function safeExportScanFindings(text: string): string[] {
  return SAFE_EXPORT_SCAN_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  return out.length > 0 ? out : undefined;
}

export function parseRegister(text: string): QRegistryEntry[] {
  const entries: QRegistryEntry[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const id = typeof parsed.id === 'string' ? parsed.id : `line-${index + 1}`;
    const title = typeof parsed.title === 'string' ? parsed.title : '(untitled)';
    const severity = parsed.severity === 'high' || parsed.severity === 'medium' || parsed.severity === 'low'
      ? parsed.severity
      : 'medium';
    const disposition = typeof parsed.disposition === 'string'
      ? parsed.disposition as Disposition
      : 'observed';
    entries.push({
      id,
      title,
      severity,
      disposition,
      kind: typeof parsed.kind === 'string' ? parsed.kind : undefined,
      files: asStringArray(parsed.files),
      risk: typeof parsed.risk === 'string' ? parsed.risk : undefined,
      unresolved_unknowns: asStringArray(parsed.unresolved_unknowns),
    });
  }
  return entries;
}

export function computeRegisterHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function shouldDispatch(args: DispatchArgs): boolean {
  return args.force || args.previousHash === null || args.previousHash !== args.currentHash;
}

function isSafeRepoFilePath(relativePath: string): boolean {
  if (relativePath.trim() === '') return false;
  if (path.isAbsolute(relativePath)) return false;
  const parts = relativePath.split(/[\\/]/);
  if (parts.includes('..') || parts.includes('.git') || parts.includes('node_modules') || parts.includes('raw')) {
    return false;
  }
  if (/\.(db|sqlite|sqlite3|env|pem|key|p12|pfx)$/i.test(relativePath)) return false;
  if (/(^|[\\/])\.env(?:\.|$)/.test(relativePath)) return false;
  return true;
}

export function collectSourceFiles(
  repoRoot: string,
  entries: QRegistryEntry[],
  options: SourceOptions,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    for (const file of entry.files ?? []) {
      if (!isSafeRepoFilePath(file)) continue;
      const absolute = path.resolve(repoRoot, file);
      const rel = path.relative(repoRoot, absolute);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (seen.has(absolute) || !existsSync(absolute)) continue;
      const stat = statSync(absolute);
      if (!stat.isFile() || stat.size > options.maxBytes) continue;
      seen.add(absolute);
      out.push(absolute);
      if (out.length >= options.maxFiles) return out;
    }
  }
  return out;
}

export function redactForWorker(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of SECRET_REDACTIONS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function stagedRelativePath(repoRoot: string, filePath: string): string {
  const rel = path.relative(repoRoot, filePath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel;
  }
  return path.basename(filePath);
}

export function prepareWorkerStaging(args: {
  repoRoot: string;
  runDir: string;
  files: string[];
}): string[] {
  const stagedRoot = path.join(args.runDir, 'staged');
  const staged: string[] = [];
  for (const file of args.files) {
    if (!existsSync(file)) continue;
    const stat = statSync(file);
    if (!stat.isFile()) continue;
    const rel = stagedRelativePath(args.repoRoot, file);
    const target = path.join(stagedRoot, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    const text = readFileSync(file, 'utf8');
    writeFileSync(
      target,
      [
        `// qregistry-loop staged copy of ${rel}`,
        '// Secret-like values are redacted before OpenCode worker dispatch.',
        redactForWorker(text),
      ].join('\n'),
      'utf8',
    );
    staged.push(target);
  }
  return staged;
}

function actionableEntries(entries: QRegistryEntry[]): QRegistryEntry[] {
  return entries
    .filter((entry) => !CLOSED_DISPOSITIONS.has(entry.disposition))
    .sort((a, b) => {
      const severityDelta = (SEVERITY_RANK.get(a.severity) ?? 9) - (SEVERITY_RANK.get(b.severity) ?? 9);
      return severityDelta === 0 ? a.id.localeCompare(b.id) : severityDelta;
    });
}

function entryBrief(entries: QRegistryEntry[]): string {
  return entries.map((entry) => {
    const unknowns = (entry.unresolved_unknowns ?? []).join('; ');
    const files = (entry.files ?? []).join(', ');
    return [
      `- ${entry.id} [${entry.severity}/${entry.disposition}] ${entry.title}`,
      entry.risk ? `  risk: ${entry.risk}` : null,
      files ? `  files: ${files}` : null,
      unknowns ? `  unknowns: ${unknowns}` : null,
    ].filter(Boolean).join('\n');
  }).join('\n');
}

export function buildWorkerPlans(entries: QRegistryEntry[], options: WorkerPlanOptions): WorkerPlan[] {
  const selected = actionableEntries(entries).slice(0, options.maxItems);
  if (selected.length === 0) return [];

  const stagedFiles = [
    options.registerPath,
    ...(existsSync(options.auditPath) ? [options.auditPath] : []),
    ...options.sourceFiles,
  ];
  const brief = entryBrief(selected);
  const common = [
    'You are an OpenCode worker helping maintain WhatSoup qRegistry.',
    'Use staged files only. Do not mutate files, do not call external services, and do not infer beyond evidence.',
    'Return concrete candidate qRegistry additions or enrichments with file:line evidence and MISSING_CONTEXT when blocked.',
    '',
    'Current actionable entries:',
    brief,
  ].join('\n');

  const reviewPlan: WorkerPlan = {
    role: 'review',
    outputName: 'worker-review.md',
    stagedFiles,
    prompt: [
      common,
      '',
      'Task: adversarially review the staged source and qregistry items.',
      'For each high/medium item you can evaluate, return: status, evidence, falsifier, done-test, and implementation-agent readiness notes.',
      'Prioritize contradictions, stale probes, missing tests, and hidden coupling.',
    ].join('\n'),
  };

  const researchPlan: WorkerPlan = {
    role: 'research',
    outputName: 'worker-research.md',
    stagedFiles,
    prompt: [
      common,
      '',
      'Task: enrich these items for future implementation agents.',
      'Return related work, design/spec notes, history/provenance, validation strategy, and any new candidate QR rows.',
      'Separate observed staged evidence from inference.',
    ].join('\n'),
  };

  return [reviewPlan, researchPlan].slice(0, Math.max(0, options.maxWorkers));
}

export function healthAllowsDispatch(status: number | null, stdout: string): boolean {
  if (status === 0) return true;
  return /\bhealthy\s+glm\/glm-5\.2\b/.test(stdout);
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const repoRoot = process.cwd();
  const options: CliOptions = {
    repoRoot,
    registerPath: path.join(repoRoot, 'qregistry.ndjson'),
    stateDir: path.join(repoRoot, 'raw', 'qregistry-loop'),
    checkerPath: resolveCheckerPath(repoRoot, env),
    safeExporterPath: resolveSafeExporterPath(repoRoot, env),
    safeExporterExplicit: Boolean(env.QREGISTRY_SAFE_EXPORTER?.trim()),
    noDispatch: false,
    force: false,
    maxWorkers: DEFAULT_MAX_WORKERS,
    maxItems: DEFAULT_MAX_ITEMS,
    maxSourceFiles: DEFAULT_MAX_SOURCE_FILES,
    maxSourceBytes: DEFAULT_MAX_SOURCE_BYTES,
  };
  let checkerExplicit = false;
  let safeExporterExplicit = options.safeExporterExplicit;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === '--repo') {
      options.repoRoot = path.resolve(next());
      options.registerPath = path.join(options.repoRoot, 'qregistry.ndjson');
      options.stateDir = path.join(options.repoRoot, 'raw', 'qregistry-loop');
      if (!checkerExplicit) options.checkerPath = resolveCheckerPath(options.repoRoot, env);
      if (!safeExporterExplicit) options.safeExporterPath = resolveSafeExporterPath(options.repoRoot, env);
    } else if (arg === '--register') {
      options.registerPath = path.resolve(next());
    } else if (arg === '--state-dir') {
      options.stateDir = path.resolve(next());
    } else if (arg === '--checker') {
      options.checkerPath = path.resolve(next());
      checkerExplicit = true;
    } else if (arg === '--safe-exporter') {
      options.safeExporterPath = path.resolve(next());
      options.safeExporterExplicit = true;
      safeExporterExplicit = true;
    } else if (arg === '--no-dispatch') {
      options.noDispatch = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--max-workers') {
      options.maxWorkers = Number.parseInt(next(), 10);
    } else if (arg === '--max-items') {
      options.maxItems = Number.parseInt(next(), 10);
    } else if (arg === '--max-source-files') {
      options.maxSourceFiles = Number.parseInt(next(), 10);
    } else if (arg === '--max-source-bytes') {
      options.maxSourceBytes = Number.parseInt(next(), 10);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function readTextIfExists(filePath: string): string | null {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8').trim() : null;
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireRunLock(lockDir: string): { release: () => void } | null {
  const pidFile = path.join(lockDir, 'pid');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDir, { recursive: false });
      writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
      return {
        release: () => rmSync(lockDir, { recursive: true, force: true }),
      };
    } catch {
      const existingPidText = readTextIfExists(pidFile);
      const existingPid = existingPidText === null ? NaN : Number.parseInt(existingPidText, 10);
      if (pidIsAlive(existingPid)) return null;
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
  return null;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  outFile: string,
  errFile: string,
  extraEnv: Record<string, string> = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): number | null {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
    env: buildChildEnv(baseEnv, extraEnv),
  });
  writeFileSync(outFile, result.stdout ?? '', 'utf8');
  writeFileSync(errFile, result.stderr ?? '', 'utf8');
  if (result.error) {
    writeFileSync(errFile, `${result.stderr ?? ''}\n${result.error.message}\n`, 'utf8');
    return null;
  }
  return result.status;
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

type SafeExportStatus = 'ok' | 'unavailable' | 'failed' | 'invalid' | 'scan-failed';

interface SafeExportResult {
  status: SafeExportStatus;
  path: string;
  exporterPath: string | null;
  processStatus?: number | null;
  findings: string[];
}

function createSafeExport(
  options: CliOptions,
  runDir: string,
  env: NodeJS.ProcessEnv,
): SafeExportResult {
  const outPath = path.join(runDir, 'qregistry.safe-export.json');
  const exporterPath = options.safeExporterPath;
  if (exporterPath === null || !existsSync(exporterPath)) {
    return {
      status: 'unavailable',
      path: outPath,
      exporterPath,
      findings: [],
    };
  }

  const stdout = path.join(runDir, 'safe-export.stdout.txt');
  const stderr = path.join(runDir, 'safe-export.stderr.txt');
  const processStatus = runCommand(
    env.PYTHON ?? 'python3.12',
    [exporterPath, '--register', options.registerPath, '--out', outPath],
    options.repoRoot,
    stdout,
    stderr,
    {},
    env,
  );
  if (processStatus !== 0) {
    return {
      status: 'failed',
      path: outPath,
      exporterPath,
      processStatus,
      findings: [],
    };
  }
  if (!existsSync(outPath)) {
    return {
      status: 'invalid',
      path: outPath,
      exporterPath,
      processStatus,
      findings: [],
    };
  }

  const text = readFileSync(outPath, 'utf8');
  try {
    JSON.parse(text);
  } catch {
    return {
      status: 'invalid',
      path: outPath,
      exporterPath,
      processStatus,
      findings: [],
    };
  }

  const findings = safeExportScanFindings(text);
  return {
    status: findings.length > 0 ? 'scan-failed' : 'ok',
    path: outPath,
    exporterPath,
    processStatus,
    findings,
  };
}

function dispatchWorker(
  plan: WorkerPlan,
  repoRoot: string,
  runDir: string,
  env: NodeJS.ProcessEnv,
): { role: string; status: number | null } {
  const args = [
    plan.role,
    '-m',
    PINNED_WORKER_MODEL,
    ...plan.stagedFiles.flatMap((file) => ['-f', file]),
    plan.prompt,
  ];
  const stdout = path.join(runDir, plan.outputName);
  const stderr = path.join(runDir, plan.outputName.replace(/\.md$/, '.stderr.txt'));
  const status = runCommand('ocw', args, repoRoot, stdout, stderr, {
    OCW_GOVERN: '1',
    OCW_REASONING: 'high',
    OCW_TIMEOUT_SECS: '1200',
    OCW_WATCHDOG: '1',
    OCW_IDLE_SECS: '240',
    OCW_FAILOVER_LADDER: PINNED_WORKER_MODEL,
  }, env);
  return { role: plan.role, status };
}

export function run(argv: string[], env: NodeJS.ProcessEnv = process.env): number {
  const options = parseArgs(argv, env);
  const registerText = readFileSync(options.registerPath, 'utf8');
  const currentHash = computeRegisterHash(registerText);
  const entries = parseRegister(registerText);
  const stateDir = options.stateDir;
  const lockDir = path.join(stateDir, 'lock');
  mkdirSync(stateDir, { recursive: true });
  const lock = acquireRunLock(lockDir);
  if (lock === null) {
    console.log(`[qregistry-loop] lock exists, skipping: ${lockDir}`);
    return 0;
  }

  try {
    const runName = timestamp();
    const runDir = path.join(stateDir, 'runs', runName);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'last-run.txt'), `${runName}\n`, 'utf8');
    const checkerOut = path.join(runDir, 'checker.stdout.txt');
    const checkerErr = path.join(runDir, 'checker.stderr.txt');
    const checkerStatus = runCommand(
      env.PYTHON ?? 'python3.12',
      [options.checkerPath, '--register', options.registerPath, '--out', path.join(runDir, 'checker-artifacts')],
      options.repoRoot,
      checkerOut,
      checkerErr,
      {},
      env,
    );
    if (checkerStatus === 2 || checkerStatus === null) {
      writeJson(path.join(runDir, 'summary.json'), {
        currentHash,
        checkerStatus,
        dispatch: false,
        reason: 'checker-hard-fail',
      });
      console.error(`[qregistry-loop] checker hard-failed; see ${runDir}`);
      return 2;
    }

    const previousHash = readTextIfExists(path.join(stateDir, 'register.sha256'));
    const checkerStdout = readFileSync(checkerOut, 'utf8');
    const checkHash = computeRegisterHash(`${currentHash}\n${checkerStatus}\n${checkerStdout}`);
    const previousCheckHash = readTextIfExists(path.join(stateDir, 'last-dispatch-key'));
    const changed = shouldDispatch({ currentHash, previousHash, force: options.force });
    const checkChanged = previousCheckHash !== checkHash;
    const dispatch = (changed || checkChanged) && !options.noDispatch;
    const safeExport = createSafeExport(options, runDir, env);
    if (dispatch && safeExport.status !== 'ok') {
      const reason = safeExport.status === 'scan-failed'
        ? 'safe-export-scan-failed'
        : `safe-export-${safeExport.status}`;
      writeJson(path.join(runDir, 'summary.json'), {
        currentHash,
        previousHash,
        checkerStatus,
        changed,
        checkChanged,
        dispatch: false,
        noDispatch: options.noDispatch,
        reason,
        safeExport,
      });
      console.error(`[qregistry-loop] ${reason}; see ${runDir}`);
      return 2;
    }
    const selectedEntries = actionableEntries(entries).slice(0, options.maxItems);
    const sourceFiles = collectSourceFiles(options.repoRoot, selectedEntries, {
      maxFiles: options.maxSourceFiles,
      maxBytes: options.maxSourceBytes,
    });
    const auditPath = path.join(options.repoRoot, DEFAULT_AUDIT);
    const evidenceFiles = [
      ...(safeExport.status === 'ok' ? [safeExport.path] : []),
      ...(existsSync(auditPath) ? [auditPath] : []),
      ...sourceFiles,
    ];
    const staged = prepareWorkerStaging({
      repoRoot: options.repoRoot,
      runDir,
      files: evidenceFiles,
    });
    writeJson(path.join(runDir, 'staged-files.json'), staged);
    const stagedRegister = staged.find((file) => file.endsWith('qregistry.safe-export.json')) ?? safeExport.path;
    const stagedAudit = staged.find((file) => file.endsWith(DEFAULT_AUDIT)) ?? auditPath;
    const stagedSources = staged.filter((file) => file !== stagedRegister && file !== stagedAudit);
    const plans = buildWorkerPlans(entries, {
      repoRoot: options.repoRoot,
      registerPath: stagedRegister,
      auditPath: stagedAudit,
      sourceFiles: stagedSources,
      maxWorkers: options.maxWorkers,
      maxItems: options.maxItems,
    });

    writeFileSync(path.join(runDir, 'brief.md'), [
      '# qRegistry Loop Run',
      '',
      `- repo: ${options.repoRoot}`,
      `- register: ${options.registerPath}`,
      `- safe_export_status: ${safeExport.status}`,
      `- current_hash: ${currentHash}`,
      `- checker_status: ${checkerStatus}`,
      `- dispatch: ${dispatch}`,
      `- source_files: ${sourceFiles.length}`,
      '',
      '## Actionable Entries',
      '',
      entryBrief(selectedEntries),
      '',
    ].join('\n'), 'utf8');

    const workerResults: Array<{ role: string; status: number | null }> = [];
    if (dispatch && plans.length > 0) {
      const healthStatus = runCommand(
        'ocw-health',
        [],
        options.repoRoot,
        path.join(runDir, 'ocw-health.stdout.txt'),
        path.join(runDir, 'ocw-health.stderr.txt'),
        {},
        env,
      );
      const healthStdout = readFileSync(path.join(runDir, 'ocw-health.stdout.txt'), 'utf8');
      if (!healthAllowsDispatch(healthStatus, healthStdout)) {
        writeJson(path.join(runDir, 'summary.json'), {
          currentHash,
          checkerStatus,
          dispatch: false,
          reason: 'ocw-health-failed',
          healthStatus,
        });
        console.error(`[qregistry-loop] ocw-health failed; see ${runDir}`);
        return 2;
      }
      for (const plan of plans) {
        workerResults.push(dispatchWorker(plan, options.repoRoot, runDir, env));
      }
      writeFileSync(path.join(stateDir, 'last-dispatch-key'), `${checkHash}\n`, 'utf8');
    }

    writeFileSync(path.join(stateDir, 'register.sha256'), `${currentHash}\n`, 'utf8');
    writeJson(path.join(runDir, 'summary.json'), {
      currentHash,
      previousHash,
      checkerStatus,
      changed,
      checkChanged,
      dispatch,
      noDispatch: options.noDispatch,
      sourceFiles,
      safeExport,
      workerResults,
    });
    console.log(`[qregistry-loop] run=${runDir} checker=${checkerStatus} dispatch=${dispatch} workers=${workerResults.length}`);
    return 0;
  } finally {
    lock.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    console.error(`[qregistry-loop] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}
