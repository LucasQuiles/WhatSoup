import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  evaluateProviderParity,
  exitCodeForProviderParityReport,
  type ProviderParityExpectation,
  type ProviderParityInput,
  type ProviderParityInstanceType,
  type ProviderParityProbeState,
  type ProviderParityReport,
} from '../src/fleet/provider-parity.ts';
import { assertNoSecretLike } from './artifact-redaction.ts';

interface ProviderParityReportArgs {
  inputPath: string;
  jsonOut?: string;
  mdOut?: string;
  help: boolean;
}

const EXPECTATION_VALUES: ReadonlySet<ProviderParityExpectation> = new Set([
  'always_on',
  'on_demand',
  'no_bot',
  'blocked',
  'owner_deferred',
]);
const INSTANCE_TYPE_VALUES: ReadonlySet<ProviderParityInstanceType> = new Set(['agent', 'chat', 'unknown']);
const PROBE_STATE_VALUES: ReadonlySet<ProviderParityProbeState | 'headless_auth_inconclusive'> = new Set([
  'ok',
  'failed',
  'skipped',
  'headless_auth_inconclusive',
  'inconclusive',
]);

function parseArgs(argv: string[]): ProviderParityReportArgs {
  let inputPath = '';
  let jsonOut: string | undefined;
  let mdOut: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--input') {
      const value = argv[index + 1];
      if (!value) throw new Error('--input requires a path');
      inputPath = value;
      index += 1;
    } else if (arg === '--json-out') {
      const value = argv[index + 1];
      if (!value) throw new Error('--json-out requires a path');
      jsonOut = value;
      index += 1;
    } else if (arg === '--md-out') {
      const value = argv[index + 1];
      if (!value) throw new Error('--md-out requires a path');
      mdOut = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }
  if (!help && !inputPath) throw new Error('--input is required');
  return { inputPath, jsonOut, mdOut, help };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a string`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function requireNullableString(value: unknown, label: string): string | null {
  if (value === null || typeof value === 'string') return value;
  throw new Error(`${label} must be a string or null`);
}

function requireNullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null || typeof value === 'boolean') return value;
  throw new Error(`${label} must be a boolean or null`);
}

function requireNullableNumber(value: unknown, label: string): number | null {
  if (value === null || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new Error(`${label} must be a finite number or null`);
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  value.forEach((entry, index) => requireString(entry, `${label}[${index}]`));
  return value as string[];
}

function requireArrayOfRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => asRecord(entry, `${label}[${index}]`));
}

function requireEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new Error(`${label} must be one of: ${[...allowed].join(', ')}`);
  }
  return value as T;
}

function validateExpectedRows(rows: unknown[]): void {
  rows.forEach((row, index) => {
    const item = asRecord(row, `expected[${index}]`);
    requireString(item.host, `expected[${index}].host`);
    requireString(item.instance, `expected[${index}].instance`);
    requireEnum(item.expected, EXPECTATION_VALUES, `expected[${index}].expected`);
    requireEnum(item.type, INSTANCE_TYPE_VALUES, `expected[${index}].type`);
    requireBoolean(item.providerProbeExpected, `expected[${index}].providerProbeExpected`);
  });
}

function validateStatusSnapshot(value: unknown, label: string): void {
  if (value === null) return;
  const status = asRecord(value, label);
  const primary = asRecord(status.primary, `${label}.primary`);
  requireNullableString(primary.provider, `${label}.primary.provider`);
  requireNullableString(primary.model, `${label}.primary.model`);
  requireNullableBoolean(primary.keyPresent, `${label}.primary.keyPresent`);

  const fallback = asRecord(status.fallback, `${label}.fallback`);
  requireNullableString(fallback.provider, `${label}.fallback.provider`);
  requireNullableString(fallback.model, `${label}.fallback.model`);
  requireNullableBoolean(fallback.keyPresent, `${label}.fallback.keyPresent`);
  requireBoolean(fallback.active, `${label}.fallback.active`);
  requireNullableNumber(fallback.activeUntil, `${label}.fallback.activeUntil`);
  requireNullableString(fallback.effectiveProvider, `${label}.fallback.effectiveProvider`);
  requireBoolean(fallback.recoveryProbeRequired, `${label}.fallback.recoveryProbeRequired`);
  if (fallback.activeEntry !== null) {
    const activeEntry = asRecord(fallback.activeEntry, `${label}.fallback.activeEntry`);
    requireString(activeEntry.provider, `${label}.fallback.activeEntry.provider`);
    requireNullableString(activeEntry.model, `${label}.fallback.activeEntry.model`);
  }
  const chain = requireArrayOfRecords(fallback.chain, `${label}.fallback.chain`);
  chain.forEach((entry, index) => {
    requireString(entry.provider, `${label}.fallback.chain[${index}].provider`);
    requireNullableString(entry.model, `${label}.fallback.chain[${index}].model`);
    requireNullableBoolean(entry.eligible, `${label}.fallback.chain[${index}].eligible`);
  });

  const signal = asRecord(status.signal, `${label}.signal`);
  requireNullableString(signal.status, `${label}.signal.status`);
  requireNullableString(signal.confidence, `${label}.signal.confidence`);
  requireNullableString(signal.reason, `${label}.signal.reason`);
  requireStringArray(signal.evidence, `${label}.signal.evidence`);
  requireBoolean(status.lineReachable, `${label}.lineReachable`);
}

function validateStatuses(statuses: Record<string, unknown>): void {
  for (const [key, status] of Object.entries(statuses)) {
    requireString(key, 'statuses key');
    validateStatusSnapshot(status, `statuses.${key}`);
  }
}

function validateProbes(probes: unknown[]): void {
  probes.forEach((probe, index) => {
    const item = asRecord(probe, `probes[${index}]`);
    requireString(item.host, `probes[${index}].host`);
    requireString(item.instance, `probes[${index}].instance`);
    requireString(item.provider, `probes[${index}].provider`);
    requireEnum(item.state, PROBE_STATE_VALUES, `probes[${index}].state`);
    if (item.evidenceRef !== undefined) requireString(item.evidenceRef, `probes[${index}].evidenceRef`);
    if (item.reason !== undefined) requireString(item.reason, `probes[${index}].reason`);
  });
}

function readInput(file: string): ProviderParityInput {
  if (!existsSync(file)) throw new Error(`input not found: ${file}`);
  const text = readFileSync(file, 'utf8');
  assertRedacted(text);
  const parsed = asRecord(JSON.parse(text), 'input');
  if (typeof parsed.generatedAtUtc !== 'string') throw new Error('generatedAtUtc must be a string');
  if (typeof parsed.targetMain !== 'string') throw new Error('targetMain must be a string');
  if (!Array.isArray(parsed.expected)) throw new Error('expected must be an array');
  validateExpectedRows(parsed.expected);
  const statuses = asRecord(parsed.statuses, 'statuses');
  validateStatuses(statuses);
  if (parsed.probes !== undefined && !Array.isArray(parsed.probes)) throw new Error('probes must be an array');
  if (Array.isArray(parsed.probes)) validateProbes(parsed.probes);
  return parsed as unknown as ProviderParityInput;
}

function assertRedacted(text: string): void {
  assertNoSecretLike(text, 'provider parity artifacts');
}

function markdownCell(value: unknown): string {
  const text = value === null || value === undefined
    ? ''
    : Array.isArray(value)
      ? value.join(', ')
      : String(value);
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderProviderParityMarkdown(report: ProviderParityReport): string {
  const lines = [
    '# Provider/Fallback Parity Report',
    '',
    `Generated: ${report.generatedAtUtc}`,
    `Target main: ${report.targetMain}`,
    `Verdict: ${report.verdict}`,
    '',
    '| verdict | host | instance | primary | fallbacks | credentials | probe | reasons |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const row of report.rows) {
    lines.push([
      row.verdict,
      row.host,
      row.instance,
      row.primaryProvider,
      row.fallbackProviders,
      row.credentialState,
      row.probeState,
      row.reasons,
    ].map(markdownCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  return `${lines.join('\n')}\n`;
}

function writeReportOutputs(report: ProviderParityReport, args: ProviderParityReportArgs): void {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const md = renderProviderParityMarkdown(report);
  assertRedacted(json);
  assertRedacted(md);
  if (args.jsonOut) writeFileSync(args.jsonOut, json, 'utf8');
  if (args.mdOut) writeFileSync(args.mdOut, md, 'utf8');
  if (!args.jsonOut && !args.mdOut) process.stdout.write(json);
}

export function run(argv = process.argv.slice(2), cwd = process.cwd()): ProviderParityReport | null {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log('Usage: provider-parity-report.ts --input input.json [--json-out report.json] [--md-out report.md]');
      return null;
    }
    const inputPath = path.resolve(cwd, args.inputPath);
    const input = readInput(inputPath);
    const report = evaluateProviderParity(input);
    writeReportOutputs(report, {
      ...args,
      jsonOut: args.jsonOut ? path.resolve(cwd, args.jsonOut) : undefined,
      mdOut: args.mdOut ? path.resolve(cwd, args.mdOut) : undefined,
    });
    const exitCode = exitCodeForProviderParityReport(report);
    if (exitCode !== 0) process.exitCode = exitCode;
    return report;
  } catch (err) {
    console.error(`provider parity report failed: ${(err as Error).message}`);
    process.exitCode = 2;
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run();
}
