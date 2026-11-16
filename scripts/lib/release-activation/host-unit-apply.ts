/** One all-member transaction for `release:activate-host`; never calls the single-instance apply. */
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { resolveLaunchdReleaseSelection } from '../launchd-release-selector.ts';
import { backupSqliteConsistent } from '../sqlite-consistent-backup.ts';
import { readSchemaMigrationLevel } from '../sqlite-schema-level.ts';
import {
  activationIdentityFailure, BOT_ERRORS_HEALTH_CONSUMER_CHANGED, checkRootPlistHelper, isUnconfirmedPlistProtection,
  launchdState, recheckBotErrorsHealthConsumer, reloadLabel, repointSymlink, stopLabel, UNCONFIRMED_PLIST_PROTECTION_STEP,
  verifyAuxDefinitions, verifyInstance, withActivationLock, writePlist,
  type ActivationIdentity, type ActivationSide, type InstanceObservation, type StepRecord,
} from './apply.ts';
import { loadedJobDefinition, type ActivationHost } from './host.ts';
import {
  backupDirectoryFailure, bootstrapEntrypointFor, recheckCandidateRefreshRollbackFence, recheckRollbackRefreshFenceTarget,
  type ActivationContext, wrapperTargetFor,
} from './plan.ts';
import { parsePlist } from '../../check-service-units.ts';
import { verifyReviewedOutsideUnits, type ReviewedOutsideUnit } from './host-unit-plan.ts';

const PRIVATE_FILE_MODE = 0o600;

export interface HostUnitApplyContext {
  release: string;
  commit: string;
  backupDir: string;
  members: ActivationContext[];
  /** A wrapper path has one backup and one atomic repoint, even when several jobs consume it. */
  sharedLaunchers: ReadonlyMap<string, readonly string[]>;
  /** Explicit host jobs whose ProgramArguments are staged outside a member surface. */
  hostAuxiliaries?: readonly { label: string; plistPath: string; installedSha256: string; staged: string; expectCurrent: string }[];
  /**
   * The fleet console has a separate wrapper link and is never inferred from the bot wrapper.
   * Its plist is reloaded but never written, so it must keep the digest the plan read.
   */
  hostLaunchers?: readonly { label: string; plistPath: string; installedSha256: string; link: string; wrapper: 'whatsoup-fleet'; expectCurrent: string }[];
  /**
   * Watchdogs are stopped before selectors move and restarted only after a verified terminal state.
   * Their plists are never written, so each must keep the digest the plan read.
   */
  watchdogs?: readonly { label: string; plistPath: string; installedSha256: string }[];
  /** Read-only v3 declarations rechecked before the first backup or selector mutation. */
  outsideUnits?: readonly ReviewedOutsideUnit[];
}

export interface HostUnitApplyOutcome {
  outcome: 'activated' | 'refused' | 'rolled-back' | 'rollback-unverified' | 'rollback-blocked-migrated' | 'rollback-blocked-refresh-fence';
  backupPath: string | null;
  failure: string | null;
  steps: StepRecord[];
  members: Array<{ instance: string; verification: InstanceObservation | null; schemaBefore: number | null; schemaAfter: number | null; schemaError: string | null; databaseBackup: { path: string; pages: number; quickCheck: 'ok' } | null }>;
  schemaGates: Array<{ stage: 'before-rollback' | 'after-quiesce'; members: Array<{ instance: string; before: number | null; after: number | null; error: string | null; changed: boolean }> }>;
  rollback: { verified: boolean; steps: StepRecord[] } | null;
}

function stamp(epoch: number): string { return new Date(epoch).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }
function allLabels(contexts: readonly ActivationContext[], role: 'primary' | 'aux'): Array<{ context: ActivationContext; label: string; plistPath: string }> {
  return contexts.flatMap((context) => context.staged
    .filter((entry) => role === 'primary' ? entry.label === context.instanceLabel : entry.label !== context.instanceLabel)
    .map((entry) => ({ context, label: entry.label, plistPath: entry.plistPath })))
    .sort((left, right) => left.label.localeCompare(right.label));
}
function sameArgs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function schema(pathname: string, before: number): { after: number | null; error: string | null; changed: boolean } {
  try { const after = readSchemaMigrationLevel(pathname); return { after, error: null, changed: after !== before }; }
  catch (error) { return { after: null, error: error instanceof Error ? error.message : String(error), changed: true }; }
}

function memberRecords(context: HostUnitApplyContext): HostUnitApplyOutcome['members'] {
  return context.members.map((member) => ({ instance: member.args.instance, verification: null, schemaBefore: null, schemaAfter: null, schemaError: null, databaseBackup: null }));
}

/**
 * Apply only after the caller has rebuilt and accepted the complete host plan,
 * as the only writer of this user's launchd state: the same activation lock as
 * `release:activate`, so a held lock refuses before any effect.
 */
export async function applyHostUnitActivation(host: ActivationHost, context: HostUnitApplyContext): Promise<HostUnitApplyOutcome> {
  const representative = context.members[0];
  const refused = (failure: string, steps: StepRecord[]): HostUnitApplyOutcome => ({ outcome: 'refused', backupPath: null, failure, steps, members: memberRecords(context), schemaGates: [], rollback: null });
  if (representative === undefined) return refused('host unit has no members', []);
  return withActivationLock(representative.home,
    (failure) => refused(failure, [{ step: 'acquire-activation-lock', ok: false, detail: failure }]),
    () => applyHoldingLock(host, context, representative));
}

async function applyHoldingLock(host: ActivationHost, context: HostUnitApplyContext, representative: ActivationContext): Promise<HostUnitApplyOutcome> {
  const steps: StepRecord[] = [];
  const schemaGates: HostUnitApplyOutcome['schemaGates'] = [];
  const members = memberRecords(context);
  const backupPath = path.join(context.backupDir, `activation-host-${context.commit.slice(0, 12)}-${stamp(host.now())}`);
  const fail = (outcome: HostUnitApplyOutcome['outcome'], failure: string, rollback: HostUnitApplyOutcome['rollback'] = null): HostUnitApplyOutcome => ({ outcome, backupPath: existsSync(backupPath) ? backupPath : null, failure, steps, members, schemaGates, rollback });
  const primary = allLabels(context.members, 'primary');
  const memberAuxiliaries = allLabels(context.members, 'aux');
  const hostAuxiliaries = context.hostAuxiliaries ?? [];
  const hostLaunchers = context.hostLaunchers ?? [];
  const watchdogs = context.watchdogs ?? [];
  const outsideUnits = context.outsideUnits ?? [];
  const externalAuxiliaries = hostAuxiliaries.map((auxiliary) => ({ context: representative, label: auxiliary.label, plistPath: auxiliary.plistPath, staged: auxiliary.staged }));
  const launcherLabels = hostLaunchers.map((launcher) => ({ context: representative, label: launcher.label, plistPath: launcher.plistPath, staged: null }));
  const auxiliary = [...memberAuxiliaries, ...externalAuxiliaries, ...launcherLabels].sort((left, right) => left.label.localeCompare(right.label));
  const affected = [...primary, ...auxiliary];
  const launchers = [
    ...[...context.sharedLaunchers.keys()].map((link) => ({ link, target: wrapperTargetFor(context.release) })),
    ...hostLaunchers.map((launcher) => ({ link: launcher.link, target: path.join(context.release, 'deploy', launcher.wrapper) })),
  ];
  // What the plan accepted: each launcher on a declared old release, each written plist at its planned digest,
  // and each launcher and watchdog plist this run loads but never writes at the digest the plan read.
  const writtenPlists = [...context.members.flatMap((member) => member.staged), ...hostAuxiliaries];
  const unwrittenPlists = [...hostLaunchers, ...watchdogs].map((entry) => ({ label: entry.label, plistPath: entry.plistPath, installedSha256: entry.installedSha256, staged: null }));
  const identity: ActivationIdentity = {
    links: [
      ...[...context.sharedLaunchers.keys()].map((link) => ({
        link, previous: context.members.filter((member) => member.wrapperLink === link).map((member) => wrapperTargetFor(member.args.expectCurrent)), activated: wrapperTargetFor(context.release),
      })),
      ...hostLaunchers.map((launcher) => ({
        link: launcher.link, previous: [path.join(launcher.expectCurrent, 'deploy', launcher.wrapper)], activated: path.join(context.release, 'deploy', launcher.wrapper),
      })),
    ],
    plists: [...writtenPlists, ...unwrittenPlists],
  };
  const identityHolds = (step: string, sides: readonly ActivationSide[], records: StepRecord[]): boolean => {
    const foreign = activationIdentityFailure(identity, sides);
    records.push(foreign === null ? { step, ok: true } : { step, ok: false, detail: foreign });
    return foreign === null;
  };
  /** For a plist this run never writes: the reload refuses, loading nothing, once its bytes are not the planned ones. */
  const admitUnwritten = (label: string): (() => string | null) | undefined => {
    const entry = unwrittenPlists.find((candidate) => candidate.label === label);
    return entry === undefined ? undefined : () => activationIdentityFailure({ links: [], plists: [entry] }, ['previous']);
  };

  const installedMatchesLoaded = async (label: string, plistPath: string): Promise<boolean> => {
    try {
      const installed = parsePlist(readFileSync(plistPath, 'utf8'));
      const loaded = await loadedJobDefinition(host, representative.domain, label);
      return installed !== null && loaded !== null
        && loaded.path === plistPath
        && loaded.program === installed.programArguments[0]
        && sameArgs(loaded.arguments, installed.programArguments);
    } catch { return false; }
  };
  const verifyHostSelectors = async (targetRelease: string | null): Promise<string | null> => {
    try {
      for (const auxiliary of hostAuxiliaries) {
        const root = targetRelease ?? auxiliary.expectCurrent;
        if (resolveLaunchdReleaseSelection(auxiliary.plistPath).releasePath !== root) return `${auxiliary.label}: selector does not resolve ${root}`;
        if (!(await installedMatchesLoaded(auxiliary.label, auxiliary.plistPath))) return `${auxiliary.label}: installed and loaded definitions differ`;
      }
      for (const launcher of hostLaunchers) {
        const root = targetRelease ?? launcher.expectCurrent;
        if (readlinkSync(launcher.link) !== path.join(root, 'deploy', launcher.wrapper)) return `${launcher.label}: wrapper link does not resolve ${root}`;
        if (resolveLaunchdReleaseSelection(launcher.plistPath).releasePath !== root) return `${launcher.label}: selector does not resolve ${root}`;
        if (!(await installedMatchesLoaded(launcher.label, launcher.plistPath))) return `${launcher.label}: installed and loaded definitions differ`;
      }
      return null;
    } catch (error) { return error instanceof Error ? error.message : String(error); }
  };

  const outsideChecks = await verifyReviewedOutsideUnits(host, outsideUnits);
  const outsideFailure = outsideChecks.find((entry) => !entry.ok);
  if (outsideFailure !== undefined) return fail('refused', `${outsideFailure.label}: ${outsideFailure.detail}`);
  const restoreWatchdogs = async (records: StepRecord[]): Promise<boolean> => {
    let restored = true;
    for (const watchdog of watchdogs) {
      const error = await reloadLabel(host, representative, watchdog.label, watchdog.plistPath, admitUnwritten(watchdog.label));
      records.push(error === null ? { step: `restore-watchdog:${watchdog.label}`, ok: true } : { step: `restore-watchdog:${watchdog.label}`, ok: false, detail: error });
      if (error !== null) restored = false;
    }
    return restored;
  };

  try {
    mkdirSync(context.backupDir, { recursive: true, mode: 0o700 });
    // mkdir leaves an existing directory as it is; one that is not private refuses, never gets chmod.
    const backupDir = backupDirectoryFailure(context.backupDir);
    if (backupDir !== null) return fail('refused', backupDir);
    mkdirSync(backupPath, { mode: 0o700 });
    for (const member of context.members) {
      const directory = path.join(backupPath, 'members', member.args.instance);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const backup = await backupSqliteConsistent(member.dbPath, path.join(directory, 'bot.db'));
      const record = members.find((entry) => entry.instance === member.args.instance)!;
      record.databaseBackup = { path: backup.backupPath, pages: backup.pages, quickCheck: backup.quickCheck };
      record.schemaBefore = readSchemaMigrationLevel(backup.backupPath);
      for (const staged of member.staged) {
        copyFileSync(staged.plistPath, path.join(directory, `${staged.label}.plist`));
        chmodSync(path.join(directory, `${staged.label}.plist`), PRIVATE_FILE_MODE);
        writeFileSync(path.join(directory, `${staged.label}.staged.plist`), staged.staged!, { mode: PRIVATE_FILE_MODE });
        const lint = await host.exec('plutil', ['-lint', path.join(directory, `${staged.label}.staged.plist`)]);
        if (lint.code !== 0) return fail('refused', `${staged.label}: staged plist failed plutil -lint`);
        const stagedPath = path.join(directory, `${staged.label}.staged.plist`);
        if (staged.label !== member.instanceLabel && resolveLaunchdReleaseSelection(stagedPath).releasePath !== context.release) return fail('refused', `${staged.label}: staged auxiliary does not select the target release`);
        if (staged.label === member.instanceLabel) {
          const parsed = parsePlist(readFileSync(stagedPath, 'utf8'));
          if (parsed === null) return fail('refused', `${staged.label}: staged primary is not parseable`);
          if (parsed.programArguments[0] === member.wrapperLink) continue;
          if (resolveLaunchdReleaseSelection(stagedPath).releasePath !== context.release) return fail('refused', `${staged.label}: staged primary does not select the target release`);
        }
      }
    }
    const hostBackupDir = path.join(backupPath, 'host-auxiliaries');
    mkdirSync(hostBackupDir, { recursive: true, mode: 0o700 });
    for (const auxiliary of hostAuxiliaries) {
      const backup = path.join(hostBackupDir, `${auxiliary.label}.plist`);
      copyFileSync(auxiliary.plistPath, backup); chmodSync(backup, PRIVATE_FILE_MODE);
      writeFileSync(path.join(hostBackupDir, `${auxiliary.label}.staged.plist`), auxiliary.staged, { mode: PRIVATE_FILE_MODE });
      const lint = await host.exec('plutil', ['-lint', path.join(hostBackupDir, `${auxiliary.label}.staged.plist`)]);
      if (lint.code !== 0) return fail('refused', `${auxiliary.label}: staged plist failed plutil -lint`);
      if (resolveLaunchdReleaseSelection(path.join(hostBackupDir, `${auxiliary.label}.staged.plist`)).releasePath !== context.release) return fail('refused', `${auxiliary.label}: staged host auxiliary does not select the target release`);
    }
    for (const launcher of hostLaunchers) {
      const backup = path.join(hostBackupDir, `${launcher.label}.plist`);
      copyFileSync(launcher.plistPath, backup); chmodSync(backup, PRIVATE_FILE_MODE);
    }
    for (const watchdog of watchdogs) {
      const backup = path.join(hostBackupDir, `${watchdog.label}.plist`);
      copyFileSync(watchdog.plistPath, backup); chmodSync(backup, PRIVATE_FILE_MODE);
    }
    for (const launcher of launchers) writeFileSync(path.join(backupPath, `launcher-${Buffer.from(launcher.link).toString('hex')}.before`), readlinkSync(launcher.link), { mode: PRIVATE_FILE_MODE });
    steps.push({ step: 'backup-and-stage-all-members-and-host-auxiliaries', ok: true });
    // A missing or outdated root helper refuses here, before the switch, not as a failed switch and a rollback.
    // Only a plist this run writes can need the helper.
    const helperCheck = checkRootPlistHelper(host, writtenPlists.map((entry) => entry.plistPath));
    if (helperCheck !== null) {
      steps.push(helperCheck);
      if (!helperCheck.ok) return fail('refused', helperCheck.detail!);
    }
  } catch (error) { return fail('refused', error instanceof Error ? error.message : String(error)); }

  // Another writer's link or plist refuses here, before any watchdog is stopped.
  if (!identityHolds('recheck-live-identity-before-quiesce', ['previous'], steps)) return fail('refused', steps.at(-1)!.detail!);
  const previous = new Map<string, number | null>();
  for (const item of primary) previous.set(item.label, (await launchdState(host, item.context.domain, item.label)).pid);
  for (const watchdog of watchdogs) {
    const error = await stopLabel(host, representative, watchdog.label);
    steps.push(error === null ? { step: `quiesce-watchdog:${watchdog.label}`, ok: true } : { step: `quiesce-watchdog:${watchdog.label}`, ok: false, detail: error });
    if (error !== null) {
      const restored = await restoreWatchdogs(steps);
      return fail(restored ? 'refused' : 'rollback-unverified', error);
    }
  }
  // release:activate's rechecks before its switch, for every member. Only the watchdogs have changed so far.
  let refusal: string | null = null;
  for (const member of context.members) {
    const fence = recheckCandidateRefreshRollbackFence(member);
    steps.push({ step: `recheck-refresh-rollback-fence-requirement-before-switch:${member.args.instance}`, ok: fence.ok, detail: fence.detail });
    if (!fence.ok) { refusal = 'refresh rollback fence requirement changed or cannot be revalidated before switch'; break; }
    const consumer = await recheckBotErrorsHealthConsumer(host, member);
    if (consumer !== null) steps.push({ ...consumer, step: `${consumer.step}:${member.args.instance}` });
    if (consumer !== null && !consumer.ok) { refusal = BOT_ERRORS_HEALTH_CONSUMER_CHANGED; break; }
  }
  // No await from this recheck into the first writePlist, which then rechecks each plist against its backup.
  if (refusal === null && !identityHolds('recheck-live-identity-before-switch', ['previous'], steps)) refusal = steps.at(-1)!.detail!;
  if (refusal !== null) {
    const restored = await restoreWatchdogs(steps);
    return fail(restored ? 'refused' : 'rollback-unverified', refusal);
  }
  let failure: string | null = null;
  let protectionUnconfirmed = false;
  let watchdogsMayBeRunning = false;
  try {
    for (const launcher of launchers) repointSymlink(launcher.link, launcher.target);
    // writePlist refuses a plist whose bytes no longer match its backup, so a write between staging and
    // this switch fails the activation instead of being overwritten.
    for (const item of [...primary, ...memberAuxiliaries]) {
      const original = readFileSync(path.join(backupPath, 'members', item.context.args.instance, `${item.label}.plist`), 'utf8');
      await writePlist(host, item.plistPath, item.context.staged.find((entry) => entry.label === item.label)!.staged!, original);
    }
    for (const auxiliary of hostAuxiliaries) {
      const original = readFileSync(path.join(backupPath, 'host-auxiliaries', `${auxiliary.label}.plist`), 'utf8');
      await writePlist(host, auxiliary.plistPath, auxiliary.staged, original);
    }
    steps.push({ step: 'switch-all-selectors', ok: true });
    for (const item of [...primary, ...auxiliary]) {
      const error = await reloadLabel(host, item.context, item.label, item.plistPath, admitUnwritten(item.label));
      steps.push(error === null ? { step: `reload:${item.label}`, ok: true } : { step: `reload:${item.label}`, ok: false, detail: error });
      if (error !== null) { failure = error; break; }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    protectionUnconfirmed = isUnconfirmedPlistProtection(error);
    steps.push({ step: 'switch', ok: false, detail: failure });
  }

  if (failure === null) for (const member of context.members) {
    const result = await verifyInstance(host, member, { entrypoint: bootstrapEntrypointFor(context.release), commit: member.newCommit, previousPid: previous.get(member.instanceLabel) ?? null, requireResponderPid: true });
    members.find((entry) => entry.instance === member.args.instance)!.verification = result.observation;
    steps.push({ step: `verify:${member.instanceLabel}`, ok: result.ok });
    if (!result.ok) { failure = `${member.instanceLabel}: verification failed`; break; }
    const aux = await verifyAuxDefinitions(host, member, context.release, member.args.expectCurrent);
    steps.push(aux === null ? { step: `verify-aux:${member.args.instance}`, ok: true } : { step: `verify-aux:${member.args.instance}`, ok: false, detail: aux });
    if (aux !== null) { failure = aux; break; }
  }
  if (failure === null) {
    const hostSelectors = await verifyHostSelectors(context.release);
    steps.push(hostSelectors === null ? { step: 'verify-host-auxiliaries', ok: true } : { step: 'verify-host-auxiliaries', ok: false, detail: hostSelectors });
    if (hostSelectors !== null) failure = hostSelectors;
  }
  if (failure === null && !identityHolds('verify-live-identity', ['activated'], steps)) failure = steps.at(-1)!.detail!;
  if (failure === null) {
    watchdogsMayBeRunning = true;
    const restored = await restoreWatchdogs(steps);
    if (restored) return fail('activated', '');
    failure = 'watchdog restoration failed';
  }

  const gate = (stage: 'before-rollback' | 'after-quiesce'): boolean => {
    let clear = true;
    const observations: HostUnitApplyOutcome['schemaGates'][number]['members'] = [];
    for (const member of context.members) {
    const record = members.find((entry) => entry.instance === member.args.instance)!;
      const observed = schema(member.dbPath, record.schemaBefore!);
      record.schemaAfter = observed.after;
      record.schemaError = observed.error;
      observations.push({ instance: member.args.instance, before: record.schemaBefore, after: observed.after, error: observed.error, changed: observed.changed });
      if (observed.changed) clear = false;
    }
    schemaGates.push({ stage, members: observations });
    return clear;
  };
  // A plist write that may have dropped protection makes every rollback unverified, as in release:activate.
  const rollbackSteps: StepRecord[] = protectionUnconfirmed ? [{ ...UNCONFIRMED_PLIST_PROTECTION_STEP }] : [];
  // The old release must still provide each candidate's refresh rollback fence, or it is never restarted.
  const refreshFenceBlocks = (stage: 'before-instance-stop' | 'after-instance-stop'): boolean => {
    let blocked = false;
    for (const member of context.members) {
      const fence = recheckRollbackRefreshFenceTarget(member);
      rollbackSteps.push({ step: `recheck-refresh-rollback-fence-${stage}:${member.args.instance}`, ok: fence.ok, detail: fence.detail });
      if (!fence.ok) blocked = true;
    }
    return blocked;
  };
  if (watchdogsMayBeRunning) {
    for (const watchdog of watchdogs) {
      const stopped = await stopLabel(host, representative, watchdog.label);
      rollbackSteps.push(stopped === null ? { step: `requiesce-watchdog:${watchdog.label}`, ok: true } : { step: `requiesce-watchdog:${watchdog.label}`, ok: false, detail: stopped ?? undefined });
      if (stopped !== null) return fail('rollback-unverified', failure, { verified: false, steps: rollbackSteps });
    }
  }
  if (!gate('before-rollback')) return fail('rollback-blocked-migrated', failure, watchdogsMayBeRunning || protectionUnconfirmed ? { verified: false, steps: rollbackSteps } : null);
  if (refreshFenceBlocks('before-instance-stop')) return fail('rollback-blocked-refresh-fence', failure, { verified: false, steps: rollbackSteps });
  // Either side of each file is still this run's own; anything else is another writer's state.
  if (!identityHolds('recheck-live-identity-before-instance-stop', ['previous', 'activated'], rollbackSteps)) return fail('rollback-unverified', failure, { verified: false, steps: rollbackSteps });
  for (const item of [...primary, ...auxiliary]) {
    const stopped = await stopLabel(host, item.context, item.label);
    rollbackSteps.push(stopped === null ? { step: `stop:${item.label}`, ok: true } : { step: `stop:${item.label}`, ok: false, detail: stopped ?? undefined });
    if (stopped !== null) return fail('rollback-unverified', failure, { verified: false, steps: rollbackSteps });
  }
  if (!gate('after-quiesce')) return fail('rollback-blocked-migrated', failure, { verified: false, steps: rollbackSteps });
  if (refreshFenceBlocks('after-instance-stop')) return fail('rollback-blocked-refresh-fence', failure, { verified: false, steps: rollbackSteps });
  if (!identityHolds('recheck-live-identity-before-restore', ['previous', 'activated'], rollbackSteps)) return fail('rollback-unverified', failure, { verified: false, steps: rollbackSteps });
  try {
    for (const launcher of launchers) repointSymlink(launcher.link, readFileSync(path.join(backupPath, `launcher-${Buffer.from(launcher.link).toString('hex')}.before`), 'utf8'));
    // A plist the forward switch never reached still holds its original; any other must hold the staged bytes.
    for (const member of context.members) for (const staged of member.staged) {
      const original = readFileSync(path.join(backupPath, 'members', member.args.instance, `${staged.label}.plist`), 'utf8');
      if (readFileSync(staged.plistPath, 'utf8') !== original) await writePlist(host, staged.plistPath, original, staged.staged!);
    }
    for (const auxiliary of hostAuxiliaries) {
      const original = readFileSync(path.join(backupPath, 'host-auxiliaries', `${auxiliary.label}.plist`), 'utf8');
      if (readFileSync(auxiliary.plistPath, 'utf8') !== original) await writePlist(host, auxiliary.plistPath, original, auxiliary.staged);
    }
    for (const item of affected) {
      const error = await reloadLabel(host, item.context, item.label, item.plistPath, admitUnwritten(item.label));
      rollbackSteps.push(error === null ? { step: `reload:${item.label}`, ok: true } : { step: `reload:${item.label}`, ok: false, detail: error });
    }
  } catch (error) { rollbackSteps.push({ step: 'restore', ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  for (const member of context.members) {
    const verified = await verifyInstance(host, member, { entrypoint: bootstrapEntrypointFor(member.args.expectCurrent), commit: member.oldCommit, previousPid: null, requireResponderPid: true });
    rollbackSteps.push({ step: `verify-old:${member.instanceLabel}`, ok: verified.ok });
    const aux = await verifyAuxDefinitions(host, member, member.args.expectCurrent, context.release);
    rollbackSteps.push(aux === null ? { step: `verify-old-aux:${member.args.instance}`, ok: true } : { step: `verify-old-aux:${member.args.instance}`, ok: false, detail: aux });
  }
  const hostSelectors = await verifyHostSelectors(null);
  rollbackSteps.push(hostSelectors === null ? { step: 'verify-old-host-auxiliaries', ok: true } : { step: 'verify-old-host-auxiliaries', ok: false, detail: hostSelectors });
  const oldTerminalVerified = rollbackSteps.every((step) => step.ok);
  if (oldTerminalVerified) await restoreWatchdogs(rollbackSteps);
  else for (const watchdog of watchdogs) {
    rollbackSteps.push({ step: `watchdog-retained:${watchdog.label}`, ok: false, detail: 'old terminal verification failed' });
  }
  const rollback = { verified: rollbackSteps.every((step) => step.ok), steps: rollbackSteps };
  return fail(rollback.verified ? 'rolled-back' : 'rollback-unverified', failure, rollback);
}
