/** Host-unit release activation: one declaration, one group transaction, one receipt. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeAtomicPrivateFileSync } from '../src/lib/private-fs.ts';
import { CliArgError, isHelpFlag, takeValue } from './lib/cli-args.ts';
import { applyHostUnitActivation } from './lib/release-activation/host-unit-apply.ts';
import { createDefaultActivationHost, type ActivationHost } from './lib/release-activation/host.ts';
import { buildHostUnitPlan } from './lib/release-activation/host-unit-plan.ts';

export const RELEASE_ACTIVATE_HOST_EXIT = { ok: 0, rolledBack: 1, refused: 2, rollbackUnverified: 3, rollbackBlockedMigrated: 4 } as const;
export interface HostActivationArgs { unit: string; release: string; backupDir: string; mode: 'plan' | 'apply'; exitTimeoutSeconds: number; verifyTimeoutSeconds: number; }
const USAGE = 'Usage: release:activate-host --unit /absolute/host-unit.json --release /absolute/release --backup-dir /absolute/backups [--exit-timeout S] [--verify-timeout S] [--plan|--apply]';
function absolute(flag: string, value: string): string { if (!path.isAbsolute(value)) throw new CliArgError(`${flag} must be an absolute path`); return path.normalize(value).replace(/\/+$/, '') || '/'; }
function seconds(flag: string, value: string): number { if (!/^[1-9]\d*$/.test(value) || Number(value) > 3600) throw new CliArgError(`${flag} must be an integer between 1 and 3600`); return Number(value); }
export function parseHostActivationArgs(argv: readonly string[]): HostActivationArgs {
  const values = new Map<string, string>(); let mode: 'plan' | 'apply' | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (isHelpFlag(flag)) throw new CliArgError(USAGE);
    if (flag === '--plan' || flag === '--apply') { if (mode !== null) throw new CliArgError('--plan and --apply are mutually exclusive'); mode = flag.slice(2) as 'plan' | 'apply'; continue; }
    if (!['--unit', '--release', '--backup-dir', '--exit-timeout', '--verify-timeout'].includes(flag) || values.has(flag)) throw new CliArgError(`Unknown or duplicate argument: ${flag}`);
    const taken = takeValue(argv, index, flag); values.set(flag, taken.value); index = taken.index;
  }
  const required = (flag: string) => { const value = values.get(flag); if (!value) throw new CliArgError(`${flag} is required`); return absolute(flag, value); };
  return { unit: required('--unit'), release: required('--release'), backupDir: required('--backup-dir'), mode: mode ?? 'plan', exitTimeoutSeconds: values.has('--exit-timeout') ? seconds('--exit-timeout', values.get('--exit-timeout')!) : 60, verifyTimeoutSeconds: values.has('--verify-timeout') ? seconds('--verify-timeout', values.get('--verify-timeout')!) : 180 };
}
function outcomeExit(outcome: 'activated' | 'refused' | 'rolled-back' | 'rollback-unverified' | 'rollback-blocked-migrated'): number {
  if (outcome === 'activated') return RELEASE_ACTIVATE_HOST_EXIT.ok;
  if (outcome === 'rolled-back') return RELEASE_ACTIVATE_HOST_EXIT.rolledBack;
  if (outcome === 'rollback-unverified') return RELEASE_ACTIVATE_HOST_EXIT.rollbackUnverified;
  if (outcome === 'rollback-blocked-migrated') return RELEASE_ACTIVATE_HOST_EXIT.rollbackBlockedMigrated;
  return RELEASE_ACTIVATE_HOST_EXIT.refused;
}

export async function runReleaseActivateHostCli(
  argv: readonly string[], host: ActivationHost = createDefaultActivationHost(),
  io: { stdout: (text: string) => void; stderr: (text: string) => void } = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) },
): Promise<number> {
  let args: HostActivationArgs;
  try { args = parseHostActivationArgs(argv); } catch (error) { io.stderr(`${error instanceof Error ? error.message : String(error)}\n`); return RELEASE_ACTIVATE_HOST_EXIT.refused; }
  const plan = await buildHostUnitPlan(host, { unitPath: args.unit, release: args.release, backupDir: args.backupDir, mode: args.mode, exitTimeoutSeconds: args.exitTimeoutSeconds, verifyTimeoutSeconds: args.verifyTimeoutSeconds });
  if (args.mode === 'plan' || plan.applyContext === null) { io.stdout(`${JSON.stringify(args.mode === 'apply' ? { ...plan.document, outcome: 'refused' } : plan.document, null, 2)}\n`); return plan.ready && args.mode === 'plan' ? RELEASE_ACTIVATE_HOST_EXIT.ok : RELEASE_ACTIVATE_HOST_EXIT.refused; }
  const outcome = await applyHostUnitActivation(host, plan.applyContext);
  const receipt = { ...plan.document, mode: 'apply', outcome };
  let receiptWritten = outcome.backupPath === null;
  if (outcome.backupPath !== null) {
    try { writeAtomicPrivateFileSync(path.join(outcome.backupPath, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'receipt'); receiptWritten = true; }
    catch { io.stderr('release:activate-host: receipt-write-failed\n'); }
  }
  io.stdout(`${JSON.stringify(receipt, null, 2)}\n`);
  return receiptWritten ? outcomeExit(outcome.outcome) : RELEASE_ACTIVATE_HOST_EXIT.rollbackUnverified;
}
const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) process.exitCode = await runReleaseActivateHostCli(process.argv.slice(2));
