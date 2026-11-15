/** Strict, declarative membership input for the host activation coordinator. */
import { readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { parsePlist } from '../../check-service-units.ts';
import { classifyAuthenticatedHealth, type ActivationHost, loadedDomainInventory, loadedJobDefinition } from './host.ts';
import { resolveLaunchdReleaseSelection } from '../launchd-release-selector.ts';
import { configRoot } from '../../../src/fleet/paths.ts';
import { AUX_RENDERERS, LABEL_PATTERN, mentionsReleaseRoot, type AuxRenderer } from './plan.ts';
import { buildActivationContext, preconditionsMet, type ActivationArgs, type ActivationContext } from './plan.ts';
import type { HostUnitApplyContext } from './host-unit-apply.ts';

export interface HostUnitMember {
  instance: string;
  expectCurrent: string;
  auxLabels: Array<{ label: string; renderer: AuxRenderer }>;
}

export interface HostUnitDeclaration {
  schemaVersion: 1;
  members: HostUnitMember[];
}

function absolute(value: unknown): string | null {
  return typeof value === 'string' && path.isAbsolute(value) ? path.normalize(value).replace(/\/+$/, '') || '/' : null;
}

function instance(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : null;
}

/** Read the versioned declaration. Unknown keys and ambiguous ownership fail closed. */
export function parseHostUnitDeclaration(value: unknown): HostUnitDeclaration | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input['schemaVersion'] !== 1 || !Array.isArray(input['members']) || Object.keys(input).some((key) => key !== 'schemaVersion' && key !== 'members')) return null;
  const seenInstances = new Set<string>();
  const seenLabels = new Set<string>();
  const members: HostUnitMember[] = [];
  for (const rawMember of input['members']) {
    if (typeof rawMember !== 'object' || rawMember === null || Array.isArray(rawMember)) return null;
    const member = rawMember as Record<string, unknown>;
    if (Object.keys(member).some((key) => key !== 'instance' && key !== 'expectCurrent' && key !== 'auxLabels')) return null;
    const name = instance(member['instance']);
    const expectCurrent = absolute(member['expectCurrent']);
    if (name === null || expectCurrent === null || seenInstances.has(name) || !Array.isArray(member['auxLabels'])) return null;
    if (seenLabels.has(`com.whatsoup.${name}`)) return null;
    seenInstances.add(name);
    const auxLabels: HostUnitMember['auxLabels'] = [];
    for (const rawAux of member['auxLabels']) {
      if (typeof rawAux !== 'object' || rawAux === null || Array.isArray(rawAux)) return null;
      const aux = rawAux as Record<string, unknown>;
      if (Object.keys(aux).some((key) => key !== 'label' && key !== 'renderer')) return null;
      const label = typeof aux['label'] === 'string' ? aux['label'] : null;
      const renderer = typeof aux['renderer'] === 'string' ? aux['renderer'] : null;
      if (label === null || !LABEL_PATTERN.test(label) || label === `com.whatsoup.${name}`
        || renderer === null || !(AUX_RENDERERS as readonly string[]).includes(renderer) || seenLabels.has(label)) return null;
      seenLabels.add(label);
      auxLabels.push({ label, renderer: renderer as AuxRenderer });
    }
    members.push({ instance: name, expectCurrent, auxLabels });
  }
  if (members.some((member) => seenLabels.has(`com.whatsoup.${member.instance}`))) return null;
  return members.length === 0 ? null : { schemaVersion: 1, members };
}

export function readHostUnitDeclaration(filePath: string): HostUnitDeclaration | null {
  try {
    return parseHostUnitDeclaration(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    return null;
  }
}

export interface HostUnitPlan {
  ready: boolean;
  document: Record<string, unknown>;
  applyContext: HostUnitApplyContext | null;
}

function sameArgs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function digestFile(filePath: string): string | null {
  try { return `sha256:${createHash('sha256').update(readFileSync(filePath)).digest('hex')}`; } catch { return null; }
}
function hasPathUnder(value: string, root: string): boolean {
  return value === root || value.startsWith(`${root}/`);
}
/**
 * A selector parser rejecting an unrelated app is not itself evidence that it
 * consumes a unit release. Admit only an absolute non-shell executable whose
 * argv contains neither a selected root nor a selected shared launcher.
 */
function provenOutsideUnit(installed: ReturnType<typeof parsePlist>, installedText: string | null, roots: readonly string[], links: readonly string[]): boolean {
  const argv = installed?.programArguments ?? [];
  if (installedText === null || argv.length === 0 || !path.isAbsolute(argv[0]!)) return false;
  if (/^(?:ba|z|da|k|fi)?sh$|^(?:env|node|nodejs|osascript|perl|ruby)$|^python(?:\d+(?:\.\d+)*)?$/.test(path.basename(argv[0]!))) return false;
  if ([...roots, ...links].some((root) => mentionsReleaseRoot(installedText, root))) return false;
  return argv.every((argument) => !links.includes(argument) && !roots.some((root) => path.isAbsolute(argument) && hasPathUnder(argument, root)));
}
async function exactOldCommit(host: ActivationHost, context: ActivationContext): Promise<string | null> {
  if (context.oldCommit !== null) return context.oldCommit;
  const result = await host.exec('git', ['-C', context.args.expectCurrent, 'rev-parse', 'HEAD'], { timeoutMs: 5_000 });
  const commit = result.code === 0 ? result.stdout.trim() : '';
  if (!/^[0-9a-f]{40}$/.test(commit)) return null;
  context.oldCommit = commit;
  return commit;
}

/**
 * Rebuild every member's existing activation context, then add the host-wide
 * installed/loaded membership proof. This performs no mutation.
 */
export async function buildHostUnitPlan(
  host: ActivationHost,
  options: { unitPath: string; release: string; backupDir: string; mode: 'plan' | 'apply'; exitTimeoutSeconds: number; verifyTimeoutSeconds: number },
): Promise<HostUnitPlan> {
  const declaration = readHostUnitDeclaration(options.unitPath);
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  const check = (id: string, ok: boolean, detail: string): boolean => { checks.push({ id, ok, detail }); return ok; };
  check('platform-macos-launchd', host.platform === 'darwin', host.platform);
  check('unit-declaration', declaration !== null, declaration === null ? 'invalid schema or label ownership' : `${declaration.members.length} members`);
  if (declaration === null) return { ready: false, document: { mode: options.mode, ready: false, preconditions: checks, members: [] }, applyContext: null };

  const memberArgs = (member: HostUnitMember): ActivationArgs => ({
    instance: member.instance, release: options.release, expectCurrent: member.expectCurrent, auxLabels: member.auxLabels,
    healthPort: null, backupDir: options.backupDir, wrapperLink: null, mode: options.mode, skipWrapperLinkPrecondition: true,
    exitTimeoutSeconds: options.exitTimeoutSeconds, verifyTimeoutSeconds: options.verifyTimeoutSeconds,
  });
  const contexts = await Promise.all(declaration.members.map((member) => buildActivationContext(host, memberArgs(member))));
  for (const context of contexts) {
    const commit = await exactOldCommit(host, context);
    check(`old-commit:${context.args.instance}`, commit !== null, commit === null ? 'manifestless old release has no exact Git HEAD' : commit);
  }
  for (const context of contexts) for (const entry of context.preconditions) check(`${context.args.instance}:${entry.id}`, entry.ok, entry.detail);
  const ports = contexts.map((context) => context.healthPort).filter((port): port is number => port !== null);
  check('unique-health-ports', new Set(ports).size === ports.length && ports.length === contexts.length, `${ports.length} resolved ports`);
  try {
    const parent = statSync(path.dirname(options.backupDir));
    const owned = typeof process.getuid !== 'function' || parent.uid === process.getuid();
    check('backup-root-private-owned', parent.isDirectory() && owned && (parent.mode & 0o077) === 0, 'parent directory must be current-user private');
  } catch { check('backup-root-private-owned', false, 'backup parent is unavailable'); }
  const domain = `gui/${host.uid}`;
  const inventory = await loadedDomainInventory(host, domain);
  check('loaded-domain', inventory !== null, inventory === null ? 'unrecognized or unavailable' : `${inventory.length} selected labels`);
  const declaredLabels = new Set<string>();
  const shared = new Map<string, string[]>();
  const documentMembers: Array<Record<string, unknown>> = [];
  for (const member of declaration.members) {
    declaredLabels.add(`com.whatsoup.${member.instance}`);
    for (const auxiliary of member.auxLabels) declaredLabels.add(auxiliary.label);
  }
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const installedLabels = (() => {
    try { return readdirSync(launchAgentsDir).filter((name) => name.endsWith('.plist')).map((name) => name.slice(0, -'.plist'.length)); }
    catch { check('installed-inventory', false, 'LaunchAgents unreadable'); return [] as string[]; }
  })();
  const unionLabels = new Set([...installedLabels, ...(inventory ?? []).map((entry) => entry.label)]);
  for (const label of unionLabels) {
    const installedPath = path.join(launchAgentsDir, `${label}.plist`);
    const loadedService = inventory?.find((entry) => entry.label === label);
    check(`installed:${label}`, installedLabels.includes(label), installedPath);
    const loadedMustBeProven = declaredLabels.has(label) || label.startsWith('com.whatsoup.');
    if (loadedMustBeProven) check(`loaded:${label}`, loadedService !== undefined, loadedService === undefined ? 'not loaded' : `pid ${loadedService.pid}`);
    if (!installedLabels.includes(label)) continue;
    let installed;
    let installedText: string | null = null;
    try { installedText = readFileSync(installedPath, 'utf8'); installed = parsePlist(installedText); } catch { installed = null; }
    if (loadedMustBeProven) {
      if (loadedService === undefined) continue;
      const loaded = await loadedJobDefinition(host, domain, label);
      const matched = installed !== null && loaded !== null && loaded.path === installedPath && loaded.program === installed.programArguments[0] && sameArgs(loaded.arguments, installed.programArguments);
      check(`installed-loaded-match:${label}`, matched, 'exact path/program/arguments');
    }
    if (!declaredLabels.has(label)) {
      let selection: ReturnType<typeof resolveLaunchdReleaseSelection> | null = null;
      try { selection = resolveLaunchdReleaseSelection(installedPath); } catch {
        const roots = [options.release, ...declaration.members.map((member) => member.expectCurrent)];
        const links = contexts.map((context) => context.wrapperLink);
        check(`unowned-selector:${label}`, provenOutsideUnit(installed, installedText, roots, links), 'unrecognized selector must be an absolute non-interpreter executable with no unit-root or launcher references');
        continue;
      }
      const selectedLink = contexts.some((context) => installed?.programArguments[0] === context.wrapperLink);
      const releaseDependent = selection.releasePath === options.release || declaration.members.some((member) => selection!.releasePath === member.expectCurrent);
      check(`unowned-consumer:${label}`, !selectedLink && !releaseDependent, selectedLink || releaseDependent ? 'undeclared consumer selects a unit release or shared launcher' : 'affirmatively outside this unit');
    }
  }
  for (const context of contexts) {
    const all = context.staged.map((entry) => entry.label);
    for (const label of all) declaredLabels.add(label);
    const primary = inventory?.find((entry) => entry.label === context.instanceLabel);
    check(`loaded-primary:${context.instanceLabel}`, primary !== undefined && primary.pid > 0, primary === undefined ? 'missing' : `pid ${primary.pid}`);
    for (const staged of context.staged) {
      const service = inventory?.find((entry) => entry.label === staged.label);
      check(`loaded:${staged.label}`, service !== undefined, service === undefined ? 'missing' : `pid ${service.pid}`);
      const installed = (() => { try { return parsePlist(readFileSync(staged.plistPath, 'utf8')); } catch { return null; } })();
      const loaded = service === undefined ? null : await loadedJobDefinition(host, domain, staged.label);
      const match = installed !== null && loaded !== null
        && loaded.path === staged.plistPath && loaded.program === installed.programArguments[0] && sameArgs(loaded.arguments, installed.programArguments);
      check(`installed-loaded-match:${staged.label}`, match, 'exact path/program/arguments');
      if (staged.label !== context.instanceLabel && service !== undefined && service.pid === 0) check(`idle-aux-state:${staged.label}`, loaded?.state === 'not running', loaded?.state ?? 'unreadable');
    }
    let selectorMode: 'direct' | 'shared-link' | 'unknown' = 'unknown';
    const installed = context.staged.find((entry) => entry.label === context.instanceLabel);
    const parsed = installed === undefined ? null : (() => { try { return parsePlist(readFileSync(installed.plistPath, 'utf8')); } catch { return null; } })();
    if (parsed !== null && parsed.programArguments[0] === context.wrapperLink) {
      selectorMode = 'shared-link';
      shared.set(context.wrapperLink, [...(shared.get(context.wrapperLink) ?? []), context.args.instance]);
    } else if (parsed !== null) {
      selectorMode = 'direct';
      try { check(`direct-selector-target:${context.instanceLabel}`, resolveLaunchdReleaseSelection(installed!.plistPath).releasePath === context.args.expectCurrent, 'direct selector resolves expected current'); } catch { check(`direct-selector-target:${context.instanceLabel}`, false, 'direct selector unreadable'); }
    }
    if (selectorMode === 'shared-link') {
      try { check(`shared-selector-target:${context.instanceLabel}`, readlinkSync(context.wrapperLink) === path.join(context.args.expectCurrent, 'deploy', 'whatsoup'), 'shared launcher resolves expected current'); } catch { check(`shared-selector-target:${context.instanceLabel}`, false, 'shared launcher unreadable'); }
    }
    const currentService = inventory?.find((entry) => entry.label === context.instanceLabel);
    let healthOk = false;
    if (currentService !== undefined && context.healthToken !== null && context.healthPort !== null) {
      try {
        const response = await host.fetchHealth(context.healthPort, context.healthToken);
        const reading = classifyAuthenticatedHealth(response.status, response.body);
        healthOk = reading.projection === 'diagnostic' && reading.responderPid === currentService.pid && reading.connected === true && context.oldCommit !== null && reading.commit === context.oldCommit;
      } catch { healthOk = false; }
    }
    check(`authenticated-current-health:${context.instanceLabel}`, healthOk, healthOk ? 'pid/commit/connection matched' : 'missing, unauthenticated, wrong-pid, wrong-commit, or disconnected');
    documentMembers.push({
      instance: context.args.instance, label: context.instanceLabel, expectCurrent: context.args.expectCurrent,
      selectorMode, port: context.healthPort, oldCommit: context.oldCommit,
      configDigest: digestFile(path.join(configRoot(), context.args.instance, 'config.json')),
      plists: context.staged.map((entry) => ({ label: entry.label, digest: digestFile(entry.plistPath) })),
      auxiliaries: context.staged.filter((entry) => entry.label !== context.instanceLabel).map((entry) => entry.label),
    });
  }
  // Every loaded job consuming a selected shared launcher must be declared.
  for (const [link, consumers] of shared) {
    const observed: string[] = [];
    for (const service of inventory ?? []) {
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${service.label}.plist`);
      try { if (parsePlist(readFileSync(plistPath, 'utf8'))?.programArguments[0] === link) observed.push(service.label.slice('com.whatsoup.'.length)); } catch { check(`shared-launcher-readable:${service.label}`, false, 'installed plist unreadable'); }
    }
    const expected = [...consumers].sort(); const actual = observed.sort();
    check(`shared-launcher-members:${link}`, sameArgs(expected, actual), `expected ${expected.length}, observed ${actual.length}`);
    try { check(`shared-launcher-on-current:${link}`, readlinkSync(link) === path.join(declaration.members.find((member) => consumers.includes(member.instance))!.expectCurrent, 'deploy', 'whatsoup'), 'expected current target'); } catch { check(`shared-launcher-on-current:${link}`, false, 'link unreadable'); }
  }
  for (const label of declaredLabels) check(`loaded-no-extra-declaration:${label}`, true, 'declared');
  const ready = checks.every((entry) => entry.ok) && contexts.every(preconditionsMet);
  const commit = contexts[0]?.newCommit ?? null;
  const applyContext = ready && commit !== null ? { release: options.release, commit, backupDir: options.backupDir, members: contexts, sharedLaunchers: shared } : null;
  return {
    ready,
    applyContext,
    document: {
      mode: options.mode, ready, toolCommit: await host.toolCommit(), release: { path: options.release, commit }, backupDir: options.backupDir,
      members: documentMembers, sharedLaunchers: [...shared.entries()].map(([link, consumers]) => ({ link, consumers })),
      preconditions: checks,
      actions: ['backup-all-members', 'stage-all-selectors', 'switch-all-selectors', 'reload-primary-then-auxiliary', 'verify-all-members', 'group-rollback'],
    },
  };
}
