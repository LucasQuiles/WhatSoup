#!/usr/bin/env node
/**
 * process-code-staleness — detect WhatSoup instances whose RUNNING process is
 * executing stale in-memory code relative to the source tree on disk.
 *
 * Why this exists
 * ---------------
 * Each instance runs `node --experimental-strip-types src/bootstrap.ts <name>`.
 * Node strips types and caches every ESM module in memory at first import; there
 * is NO hot reload. So when a source-level fix lands (e.g. a provider-failure
 * classifier change), the long-lived process keeps running the OLD code until it
 * is restarted. A divergent process can silently misbehave — e.g. misclassify a
 * 529/session-limit terminal error and never arm provider fallback — while the
 * tree on disk already contains the fix.
 *
 * Diagnosing this by hand (git reflog -> which commit was HEAD at boot ->
 * git merge-base --is-ancestor of the fix commit) burned two whole sessions.
 * This tool makes that determination deterministic and instant.
 *
 * Verdict logic (deterministic, conservative)
 * -------------------------------------------
 *   STALE  <=>  newest mtime of any src/**.ts file  >  process boot time.
 * Both `git checkout <branch>` (rewrites changed files) and a dirty in-place edit
 * bump file mtime, so "a src file changed since the process started" is a sound,
 * conservative proxy for "the process is running code that no longer matches disk".
 *
 * Usage
 *   node --experimental-strip-types scripts/process-code-staleness.ts            # all whatsoup@ instances
 *   node --experimental-strip-types scripts/process-code-staleness.ts --instance q
 *   node --experimental-strip-types scripts/process-code-staleness.ts --json
 *   node --experimental-strip-types scripts/process-code-staleness.ts --critical # gate on critical files only
 *
 * Exit code: 0 if no instance is stale, 1 if any instance is stale, 2 on error.
 * Designed for cron / bot-errors integration (non-zero == actionable).
 *
 * Safety note: every subprocess call uses spawnSync(cmd, argsArray) with NO shell
 * and only internally-derived arguments — not shell-injectable.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT_DEFAULT = path.resolve(path.dirname(SCRIPT_PATH), '..');

// Files whose staleness is behaviourally load-bearing. When --critical is set we
// gate the verdict on whether ANY of these changed since boot. Extend as new
// critical surfaces are found.
const CRITICAL_SUFFIXES = [
  'src/runtimes/agent/failure-taxonomy.ts',
  'src/runtimes/agent/runtime.ts',
  'src/runtimes/agent/fallback-empty-advance.ts',
  'src/core/health.ts',
];

interface InstanceReport {
  instance: string;
  pid: number | null;
  repoRoot: string | null;
  bootEpoch: number | null;
  bootIso: string | null;
  headSha: string | null;
  dirty: boolean | null;
  newestSrcFile: string | null;
  newestSrcEpoch: number | null;
  newestSrcIso: string | null;
  newestCriticalFile: string | null;
  newestCriticalEpoch: number | null;
  lagSeconds: number | null; // newestSrcEpoch - bootEpoch (positive == stale)
  stale: boolean;
  criticalStale: boolean;
  note: string | null;
}

function run(cmd: string, args: string[], cwd?: string): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function discoverInstances(): string[] {
  const r = run('systemctl', ['--user', 'list-units', 'whatsoup@*', '--all', '--no-legend', '--plain']);
  const names: string[] = [];
  for (const line of r.out.split('\n')) {
    const m = line.trim().match(/^whatsoup@([^.\s]+)\.service/);
    if (m) names.push(m[1]);
  }
  return names;
}

function mainPid(instance: string): number | null {
  const r = run('systemctl', ['--user', 'show', `whatsoup@${instance}`, '-p', 'MainPID', '--value']);
  const pid = Number.parseInt(r.out, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** Process boot epoch (seconds) via elapsed-seconds — robust, no date parsing. */
function bootEpoch(pid: number): number | null {
  const r = run('ps', ['-o', 'etimes=', '-p', String(pid)]);
  const etimes = Number.parseInt(r.out, 10);
  if (!Number.isFinite(etimes)) return null;
  return Math.floor(Date.now() / 1000) - etimes;
}

/** Resolve repo root from the running process cmdline (.../src/bootstrap.ts). */
function repoRootFromPid(pid: number): string | null {
  const cmdlinePath = `/proc/${pid}/cmdline`;
  if (!existsSync(cmdlinePath)) return null;
  let raw: string;
  try {
    raw = readFileSync(cmdlinePath, 'latin1');
  } catch {
    return null;
  }
  const argv = raw.split('\0').filter(Boolean);
  const boot = argv.find((a) => a.endsWith('bootstrap.ts'));
  if (!boot) return null;
  return path.resolve(path.dirname(boot), '..'); // <root>/src/bootstrap.ts -> <root>
}

/** Newest *.ts under <repo>/src and the file responsible. */
function newestSrc(repoRoot: string): { file: string | null; epoch: number | null } {
  const srcDir = path.join(repoRoot, 'src');
  if (!existsSync(srcDir)) return { file: null, epoch: null };
  const r = run('find', [srcDir, '-name', '*.ts', '-printf', '%T@\t%p\n']);
  if (r.code !== 0 || !r.out) return { file: null, epoch: null };
  let bestEpoch = -1;
  let bestFile: string | null = null;
  for (const line of r.out.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const epoch = Math.floor(Number.parseFloat(line.slice(0, tab)));
    if (Number.isFinite(epoch) && epoch > bestEpoch) {
      bestEpoch = epoch;
      bestFile = line.slice(tab + 1);
    }
  }
  return bestFile ? { file: path.relative(repoRoot, bestFile), epoch: bestEpoch } : { file: null, epoch: null };
}

/** Newest mtime among the CRITICAL files that exist. */
function newestCritical(repoRoot: string): { file: string | null; epoch: number | null } {
  let bestEpoch = -1;
  let bestFile: string | null = null;
  for (const suffix of CRITICAL_SUFFIXES) {
    const abs = path.join(repoRoot, suffix);
    if (!existsSync(abs)) continue;
    const epoch = Math.floor(statSync(abs).mtimeMs / 1000);
    if (epoch > bestEpoch) {
      bestEpoch = epoch;
      bestFile = suffix;
    }
  }
  return { file: bestFile, epoch: bestEpoch >= 0 ? bestEpoch : null };
}

function headSha(repoRoot: string): string | null {
  const r = run('git', ['rev-parse', '--short', 'HEAD'], repoRoot);
  return r.code === 0 ? r.out : null;
}

function isDirty(repoRoot: string): boolean | null {
  const r = run('git', ['status', '--porcelain'], repoRoot);
  if (r.code !== 0) return null;
  return r.out.length > 0;
}

function inspect(instance: string): InstanceReport {
  const base: InstanceReport = {
    instance, pid: null, repoRoot: null, bootEpoch: null, bootIso: null,
    headSha: null, dirty: null, newestSrcFile: null, newestSrcEpoch: null,
    newestSrcIso: null, newestCriticalFile: null, newestCriticalEpoch: null,
    lagSeconds: null, stale: false, criticalStale: false, note: null,
  };
  const pid = mainPid(instance);
  if (pid === null) return { ...base, note: 'not running (MainPID=0)' };
  const boot = bootEpoch(pid);
  const repoRoot = repoRootFromPid(pid) ?? REPO_ROOT_DEFAULT;
  const src = newestSrc(repoRoot);
  const crit = newestCritical(repoRoot);
  const stale = boot !== null && src.epoch !== null && src.epoch > boot;
  const criticalStale = boot !== null && crit.epoch !== null && crit.epoch > boot;
  return {
    ...base,
    pid,
    repoRoot,
    bootEpoch: boot,
    bootIso: boot !== null ? new Date(boot * 1000).toISOString() : null,
    headSha: headSha(repoRoot),
    dirty: isDirty(repoRoot),
    newestSrcFile: src.file,
    newestSrcEpoch: src.epoch,
    newestSrcIso: src.epoch !== null ? new Date(src.epoch * 1000).toISOString() : null,
    newestCriticalFile: crit.file,
    newestCriticalEpoch: crit.epoch,
    lagSeconds: boot !== null && src.epoch !== null ? src.epoch - boot : null,
    stale,
    criticalStale,
    note: null,
  };
}

function fmtLag(sec: number | null): string {
  if (sec === null) return '?';
  const a = Math.abs(sec);
  const d = Math.floor(a / 86400);
  const h = Math.floor((a % 86400) / 3600);
  const m = Math.floor((a % 3600) / 60);
  const parts = [d ? `${d}d` : '', h ? `${h}h` : '', !d && !h ? `${m}m` : ''].filter(Boolean);
  return parts.join('') || `${a}s`;
}

function main(): number {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const criticalOnly = argv.includes('--critical');
  const instArgIdx = argv.indexOf('--instance');
  const only = instArgIdx >= 0 ? argv[instArgIdx + 1] : null;

  const instances = only ? [only] : discoverInstances();
  if (instances.length === 0) {
    if (json) process.stdout.write(JSON.stringify({ check: 'process-code-staleness', instances: [], ok: true }) + '\n');
    else process.stdout.write('No whatsoup@ instances found.\n');
    return 0;
  }

  const reports = instances.map(inspect);
  const criterion: keyof InstanceReport = criticalOnly ? 'criticalStale' : 'stale';
  const anyStale = reports.some((r) => r[criterion] === true);

  if (json) {
    process.stdout.write(JSON.stringify({ check: 'process-code-staleness', ok: !anyStale, criterion, instances: reports }, null, 2) + '\n');
    return anyStale ? 1 : 0;
  }

  const lines: string[] = [];
  lines.push('WhatSoup process-code staleness (running in-memory code vs disk)');
  lines.push('');
  for (const r of reports) {
    if (r.note) {
      lines.push(`  ${r.instance.padEnd(12)} — ${r.note}`);
      continue;
    }
    const flagged = criticalOnly ? r.criticalStale : r.stale;
    lines.push(`  ${flagged ? 'STALE ' : 'fresh '}${r.instance.padEnd(12)} pid=${r.pid} HEAD=${r.headSha}${r.dirty ? '+dirty' : ''}`);
    lines.push(`         booted ${r.bootIso}`);
    lines.push(`         newest src ${r.newestSrcIso}  (${r.newestSrcFile})`);
    if (r.stale) lines.push(`         -> src changed ${fmtLag(r.lagSeconds)} AFTER boot — restart to load current code`);
    if (r.criticalStale) lines.push(`         -> CRITICAL file changed since boot: ${r.newestCriticalFile}`);
  }
  lines.push('');
  lines.push(anyStale ? 'VERDICT: stale instance(s) present — restart needed to load current code.' : 'VERDICT: all instances running current code.');
  process.stdout.write(lines.join('\n') + '\n');
  return anyStale ? 1 : 0;
}

try {
  process.exit(main());
} catch (err) {
  process.stderr.write(`process-code-staleness error: ${(err as Error).message}\n`);
  process.exit(2);
}
