/** Strict, declarative membership input for the host activation coordinator. */
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { parsePlist } from '../../check-service-units.ts';
import { classifyAuthenticatedHealth, type ActivationHost, loadedDomainInventory, loadedJobDefinition } from './host.ts';
import { resolveLaunchdReleaseSelection } from '../launchd-release-selector.ts';
import { configRoot } from '../../../src/fleet/paths.ts';
import { isNonEmptyString } from '../../../src/lib/type-guards.ts';
import { AUX_RENDERERS, LABEL_PATTERN, mentionsReleaseRoot, renderAuxPlist, type AuxRenderer } from './plan.ts';
import { buildActivationContext, plistDigest, preconditionsMet, wrapperTargetFor, type ActivationArgs, type ActivationContext } from './plan.ts';
import { checkPathRebasePlist, isLegacyPathRebaseLabel, rebaseLegacyHostAuxiliaryForPathRebase, SHELL_TOKEN_PATH, type LegacyPathRebaseLabel } from './legacy-host-auxiliaries.ts';
import { readStrictPlist, strictPlistStrings, strictStringArray, strictStringDict, type StrictPlistDict } from './strict-plist.ts';
import { checkoutCommit } from './tool-commit.ts';
import type { HostUnitApplyContext } from './host-unit-apply.ts';

export interface HostUnitMember {
  instance: string;
  expectCurrent: string;
  auxLabels: Array<{ label: string; renderer: AuxRenderer }>;
}

export type HostAuxiliaryMode = 'setup-timer' | 'path-rebase' | 'fleet-wrapper' | 'quiesce';

/**
 * An explicitly declared host job outside any instance's own launchd surface.
 * Modes are deliberately closed: the coordinator is not a general plist
 * editor, and every selector-bearing host job must name its old root or link.
 */
export interface HostUnitAuxiliary {
  label: string;
  mode: HostAuxiliaryMode;
  expectCurrent: string | null;
  link: string | null;
}

export interface OutsideUnitReviewInput {
  roots: string[];
  links: string[];
  files: Array<{ path: string; sha256: string }>;
  argumentBindings: Array<{ index: number; path: string; kind: 'review-file' | 'runtime-data' }>;
}

/** A reviewed, non-WhatSoup LaunchAgent which this transaction never edits. */
export interface HostUnitOutsideUnit {
  label: string;
  plistSha256: string;
  loadState: 'loaded' | 'unloaded-113';
  reviewInputs: OutsideUnitReviewInput;
}

/** The plan binds the declaration to this host's exact selection tuple. */
export interface ReviewedOutsideUnit extends HostUnitOutsideUnit {
  plistPath: string;
  domain: string;
  selectionRoots: string[];
  selectionLinks: string[];
}

export interface HostUnitDeclaration {
  schemaVersion: 1 | 2 | 3;
  members: HostUnitMember[];
  hostAuxiliaries: HostUnitAuxiliary[];
  outsideUnits: HostUnitOutsideUnit[];
}

const HOST_AUXILIARY_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HOST_TIMER_LABELS = new Set(['com.whatsoup.harness-maintenance', 'com.whatsoup.reply-guarantee']);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const INTERPRETER = /^(?:ba|z|da|k|fi)?sh$|^(?:env|node|nodejs|osascript|perl|ruby)$|^python(?:\d+(?:\.\d+)*)?$/;
const PYTHON_MODULE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
/**
 * WhatSoup launchd jobs retired from the standard, each with the home-relative script it ran: no manifest entry; the
 * templates stay tracked until they can be deleted and are excluded from release exports
 * (docs/releases/2026-11-20-token-backup-job-retired.md). Planning refuses a host that still has one
 * installed or loaded, by name and with the files to remove; it never loads, reloads or counts one as a member.
 */
const RETIRED_JOBS: ReadonlyMap<string, string> = new Map([
  ['com.whatsoup.ms365-token-backup', path.join('.local', 'bin', 'ms365-token-backup')],
]);

function absolute(value: unknown): string | null {
  return typeof value === 'string' && path.isAbsolute(value) ? path.normalize(value).replace(/\/+$/, '') || '/' : null;
}

function instance(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : null;
}

function orderedAbsolutePaths(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const entries = value.map(absolute);
  if (entries.some((entry) => entry === null)) return null;
  const paths = entries as string[];
  return paths.every((entry, index) => index === 0 || paths[index - 1]! < entry) ? paths : null;
}

function parseReviewInputs(value: unknown): OutsideUnitReviewInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'roots' && key !== 'links' && key !== 'files' && key !== 'argumentBindings')) return null;
  const roots = orderedAbsolutePaths(input['roots']); const links = orderedAbsolutePaths(input['links']);
  if (roots === null || links === null || !Array.isArray(input['files']) || !Array.isArray(input['argumentBindings'])) return null;
  const files: OutsideUnitReviewInput['files'] = [];
  for (const rawFile of input['files']) {
    if (typeof rawFile !== 'object' || rawFile === null || Array.isArray(rawFile)) return null;
    const file = rawFile as Record<string, unknown>;
    if (Object.keys(file).some((key) => key !== 'path' && key !== 'sha256')) return null;
    const filePath = absolute(file['path']); const sha256 = typeof file['sha256'] === 'string' ? file['sha256'] : null;
    if (filePath === null || sha256 === null || !SHA256.test(sha256) || (files.at(-1)?.path ?? '') >= filePath) return null;
    files.push({ path: filePath, sha256 });
  }
  const argumentBindings: OutsideUnitReviewInput['argumentBindings'] = [];
  for (const rawBinding of input['argumentBindings']) {
    if (typeof rawBinding !== 'object' || rawBinding === null || Array.isArray(rawBinding)) return null;
    const binding = rawBinding as Record<string, unknown>;
    if (Object.keys(binding).some((key) => key !== 'index' && key !== 'path' && key !== 'kind')) return null;
    const index = typeof binding['index'] === 'number' ? binding['index'] : null; const bindingPath = absolute(binding['path']);
    const kind = binding['kind'] === 'review-file' || binding['kind'] === 'runtime-data' ? binding['kind'] : null;
    if (index === null || !Number.isSafeInteger(index) || index <= 0 || bindingPath === null || kind === null || (argumentBindings.at(-1)?.index ?? -1) >= index) return null;
    argumentBindings.push({ index, path: bindingPath, kind });
  }
  return { roots, links, files, argumentBindings };
}

/** Read the versioned declaration. Unknown keys and ambiguous ownership fail closed. */
export function parseHostUnitDeclaration(value: unknown): HostUnitDeclaration | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const schemaVersion = input['schemaVersion'];
  if ((schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3) || !Array.isArray(input['members'])
    || Object.keys(input).some((key) => key !== 'schemaVersion' && key !== 'members' && key !== 'hostAuxiliaries' && key !== 'outsideUnits')
    || (schemaVersion === 1 && input['hostAuxiliaries'] !== undefined)
    || (schemaVersion === 1 && input['outsideUnits'] !== undefined)
    || ((schemaVersion === 2 || schemaVersion === 3) && !Array.isArray(input['hostAuxiliaries']))
    || (schemaVersion !== 3 && input['outsideUnits'] !== undefined)
    || (schemaVersion === 3 && !Array.isArray(input['outsideUnits']))) return null;
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
  const hostAuxiliaries: HostUnitAuxiliary[] = [];
  const rawHostAuxiliaries: unknown[] = schemaVersion === 1 ? [] : input['hostAuxiliaries'] as unknown[];
  for (const rawAuxiliary of rawHostAuxiliaries) {
    if (typeof rawAuxiliary !== 'object' || rawAuxiliary === null || Array.isArray(rawAuxiliary)) return null;
    const auxiliary = rawAuxiliary as Record<string, unknown>;
    const label = typeof auxiliary['label'] === 'string' && HOST_AUXILIARY_LABEL.test(auxiliary['label']) ? auxiliary['label'] : null;
    const mode = typeof auxiliary['mode'] === 'string' ? auxiliary['mode'] as HostAuxiliaryMode : null;
    if (label === null || mode === null || seenLabels.has(label) || members.some((member) => label === `com.whatsoup.${member.instance}`)) return null;
    const knownModeLabel = (mode === 'path-rebase' && isLegacyPathRebaseLabel(label))
      || (mode === 'setup-timer' && HOST_TIMER_LABELS.has(label))
      || (mode === 'fleet-wrapper' && label === 'com.whatsoup.whatsoup-fleet')
      || (mode === 'quiesce' && members.some((member) => label === `com.whatsoup.${member.instance}-watchdog`));
    if (!knownModeLabel) return null;
    const expectedKeys = mode === 'fleet-wrapper' ? ['label', 'mode', 'expectCurrent', 'link']
      : mode === 'quiesce' ? ['label', 'mode']
        : mode === 'setup-timer' || mode === 'path-rebase' ? ['label', 'mode', 'expectCurrent'] : null;
    if (expectedKeys === null || Object.keys(auxiliary).some((key) => !expectedKeys.includes(key))) return null;
    const expectCurrent = mode === 'quiesce' ? null : absolute(auxiliary['expectCurrent']);
    const link = mode === 'fleet-wrapper' ? absolute(auxiliary['link']) : null;
    if ((mode !== 'quiesce' && expectCurrent === null) || (mode === 'fleet-wrapper' && link === null)) return null;
    seenLabels.add(label);
    hostAuxiliaries.push({ label, mode, expectCurrent, link });
  }
  const outsideUnits: HostUnitOutsideUnit[] = [];
  const rawOutsideUnits: unknown[] = schemaVersion === 3 ? input['outsideUnits'] as unknown[] : [];
  for (const rawOutsideUnit of rawOutsideUnits) {
    if (typeof rawOutsideUnit !== 'object' || rawOutsideUnit === null || Array.isArray(rawOutsideUnit)) return null;
    const outsideUnit = rawOutsideUnit as Record<string, unknown>;
    if (Object.keys(outsideUnit).some((key) => key !== 'label' && key !== 'plistSha256' && key !== 'loadState' && key !== 'reviewInputs')) return null;
    const label = isNonEmptyString(outsideUnit['label']) && HOST_AUXILIARY_LABEL.test(outsideUnit['label']) ? outsideUnit['label'] : null;
    const plistSha256 = isNonEmptyString(outsideUnit['plistSha256']) ? outsideUnit['plistSha256'] : null;
    const loadState = outsideUnit['loadState'] === 'loaded' || outsideUnit['loadState'] === 'unloaded-113' ? outsideUnit['loadState'] : null;
    const reviewInputs = parseReviewInputs(outsideUnit['reviewInputs']);
    if (label === null || label.startsWith('com.whatsoup.') || label === 'com.bot-errors.health' || seenLabels.has(label)
      || members.some((member) => label === `com.whatsoup.${member.instance}`) || plistSha256 === null || !SHA256.test(plistSha256)
      || loadState === null || reviewInputs === null) return null;
    seenLabels.add(label);
    outsideUnits.push({ label, plistSha256, loadState, reviewInputs });
  }
  return members.length === 0 ? null : { schemaVersion, members, hostAuxiliaries, outsideUnits };
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
 * A closed-form path names exactly the path it spells: absolute, unchanged by normalization, and
 * with no trailing slash (the root aside), so it has no empty, `.` or `..` segment. Path-rebase
 * decides "below the root" only for closed-form paths. hasPathUnder stays lexical: the outside-unit
 * proofs use it in the refusing direction, where a stricter check would admit more.
 */
function closedFormPath(value: string): boolean {
  return path.posix.isAbsolute(value) && path.posix.normalize(value) === value && (value === '/' || !value.endsWith('/'));
}
function programArgumentsUnder(programArguments: readonly string[], root: string): boolean {
  return programArguments.some((argument) => path.isAbsolute(argument) && hasPathUnder(argument, root));
}
function rebaseProgramArguments(programArguments: readonly string[], expectCurrent: string, release: string): string[] {
  return programArguments.map((argument) => hasPathUnder(argument, expectCurrent)
    ? `${release}${argument.slice(expectCurrent.length)}`
    : argument);
}
function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rebase only a declared selected root and retain every other plist field byte-for-byte. The installed plist, with
 * the declared root, and the staged result, with the target release, must each pass checkPathRebasePlist: the strict
 * reading, the closed root and environment key sets, and the exact argv of one of the four closed contracts.
 */
function stagePathRebase(installed: string, expectCurrent: string, release: string, label: LegacyPathRebaseLabel, home: string): { staged: string | null; error: string | null } {
  const current = checkPathRebasePlist(label, installed, expectCurrent, home);
  if (!current.ok) return { staged: null, error: current.error };
  const source = rebaseLegacyHostAuxiliaryForPathRebase(installed, current.programArguments, label, expectCurrent, release, home) ?? installed;
  const read = readStrictPlist(source);
  if (!read.ok) return { staged: null, error: read.error };
  // The legacy wrapper's profile default, rewritten above, is the only shell-style exception, and a root that lands in
  // a shell argument must be a shell token. No value can be proven never to reach a shell, so only a bare shell-token
  // path is rewritten; a command that merely starts with the root is refused below like any other embedded
  // reference. The values are the strict reader's decoded strings, so text inside a comment is not a value.
  for (const value of strictPlistStrings(read.root)) {
    // Outside closed form a shell token names a path other than its spelling, whether or not it contains the root:
    // <root>/../x leaves the root, and <root>.bak/../<name>/x or <parent>/./<name>/x name it without being "below" it.
    const shellToken = SHELL_TOKEN_PATH.test(value);
    if (shellToken && !closedFormPath(value)) return { staged: null, error: 'absolute plist string value is not in closed form (empty, . or .. segment, or trailing slash)' };
    if (!value.includes(expectCurrent)) continue;
    // A closed-form shell token starting with the root is the root, a path below it (rewritten below), or a
    // distinct prefix sibling such as <root>2/x (retained). Embedded shell fragments and other opaque strings,
    // including a sibling outside the shell-token grammar, are unsafe to rewrite.
    if (shellToken && value.startsWith(expectCurrent)) continue;
    return { staged: null, error: 'expected-current root is embedded in a non-path string value' };
  }
  // The target release then lands in each rewritten value, so it must be a closed-form shell token too.
  if (!SHELL_TOKEN_PATH.test(release) || !closedFormPath(release)) return { staged: null, error: 'target release is not a closed-form shell-token path (^/[A-Za-z0-9._/-]+$)' };
  const encodedCurrent = escapeXml(expectCurrent);
  const encodedRelease = escapeXml(release);
  const rootString = new RegExp(`(<string>)${escapeForRegExp(encodedCurrent)}((?:/[^<]*)?)(</string>)`, 'g');
  const staged = source.replace(rootString, (_match, open: string, suffix: string, close: string) => `${open}${encodedRelease}${suffix}${close}`);
  if (staged === source || mentionsReleaseRoot(staged, expectCurrent)) return { staged: null, error: 'staged plist did not remove the declared expected-current root' };
  const target = checkPathRebasePlist(label, staged, release, home);
  return target.ok ? { staged, error: null } : { staged: null, error: `staged plist: ${target.error}` };
}
/**
 * A selector parser rejecting an unrelated app is not itself evidence that it
 * consumes a unit release.
 */
function provenOutsideUnit(installed: ReturnType<typeof parsePlist>, installedText: string | null, roots: readonly string[], links: readonly string[]): boolean {
  const argv = installed?.programArguments ?? [];
  if (installedText === null || argv.length === 0 || !path.isAbsolute(argv[0]!)) return false;
  if (INTERPRETER.test(path.basename(argv[0]!))) return false;
  if ([...roots, ...links].some((root) => mentionsReleaseRoot(installedText, root))) return false;
  return argv.every((argument) => !links.includes(argument) && !roots.some((root) => path.isAbsolute(argument) && hasPathUnder(argument, root)));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readDigest(filePath: string): { bytes: Buffer; sha256: string } | null {
  try {
    const bytes = readFileSync(filePath);
    return { bytes, sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  } catch { return null; }
}

function isRegularFile(filePath: string): boolean {
  try { return statSync(filePath).isFile(); } catch { return false; }
}

function isDirectory(directoryPath: string): boolean {
  try { return statSync(directoryPath).isDirectory(); } catch { return false; }
}

/**
 * Clear when no environment key the strict reader decoded is one that `refusedKey` names. Null keys mean
 * EnvironmentVariables is not a dict of strings; the reader has already refused a duplicate key and any markup.
 */
function installedEnvironmentClear(environmentKeys: readonly string[] | null, refusedKey: (key: string) => boolean): boolean {
  return environmentKeys !== null && !environmentKeys.some(refusedKey);
}

/** What the outside-unit proofs read from a strictly read plist; null when ProgramArguments holds a non-string. */
function outsideUnitDefinition(plist: StrictPlistDict): { label: string | null; programArguments: string[]; workingDirectory: string | null; environmentKeys: string[] | null } | null {
  const programArguments = strictStringArray(plist, 'ProgramArguments');
  if ('error' in programArguments) return null;
  const label = plist.get('Label');
  const workingDirectory = plist.get('WorkingDirectory');
  const environment = strictStringDict(plist, 'EnvironmentVariables');
  return {
    // Trimmed as parsePlist trims it. Only the root dictionary's Label is read; a nested Label does not count.
    label: label?.kind === 'string' ? label.value.trim() : null,
    programArguments: programArguments.values,
    workingDirectory: workingDirectory?.kind === 'string' ? workingDirectory.value : null,
    environmentKeys: 'error' in environment ? null : [...environment.entries.keys()],
  };
}

function reviewedPythonModuleSources(workingDirectory: string, moduleName: string): string[] | null {
  if (!PYTHON_MODULE.test(moduleName)) return null;
  const segments = moduleName.split('.');
  const packages = segments.slice(0, -1);
  const source = path.join(workingDirectory, ...segments.slice(0, -1), `${segments.at(-1)}.py`);
  return [...packages.map((_segment, index) => path.join(workingDirectory, ...packages.slice(0, index + 1), '__init__.py')), source];
}

function resolveSelectedPaths(selected: readonly string[]): string[] | null {
  try { return selected.map((entry) => realpathSync(entry)); } catch { return null; }
}

function resolveExistingAncestor(filePath: string): string | null {
  let candidate = filePath;
  for (;;) {
    try { return realpathSync(candidate); }
    catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : null;
      const parent = path.dirname(candidate);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === candidate) return null;
      try {
        if (lstatSync(candidate).isSymbolicLink()) return null;
      } catch (statusError) {
        const statusCode = typeof statusError === 'object' && statusError !== null && 'code' in statusError ? (statusError as { code?: unknown }).code : null;
        if (statusCode !== 'ENOENT' && statusCode !== 'ENOTDIR') return null;
      }
      candidate = parent;
    }
  }
}

function underSelectedPath(filePath: string, selected: readonly string[], resolvedSelected: readonly string[], allowMissingLeaf: boolean): boolean | null {
  if (selected.some((root) => hasPathUnder(filePath, root))) return true;
  const resolved = allowMissingLeaf ? resolveExistingAncestor(filePath) : (() => { try { return realpathSync(filePath); } catch { return null; } })();
  if (resolved === null) return null;
  return resolvedSelected.some((root) => hasPathUnder(resolved, root));
}

function reviewTupleSha256(outsideUnit: HostUnitOutsideUnit): string {
  const normalized = {
    label: outsideUnit.label,
    plistSha256: outsideUnit.plistSha256,
    loadState: outsideUnit.loadState,
    roots: outsideUnit.reviewInputs.roots,
    links: outsideUnit.reviewInputs.links,
    files: outsideUnit.reviewInputs.files,
    argumentBindings: outsideUnit.reviewInputs.argumentBindings,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}

/**
 * The declaration binds ordinary interpreter file launchers without attempting
 * to interpret arbitrary shell or language command lines. `inline` remains
 * pinned by the reviewed plist and still requires a reviewed source input.
 */
function interpreterScriptIndex(programArguments: readonly string[]): number | 'inline' | 'python-module' | null {
  const executable = path.basename(programArguments[0] ?? '');
  const first = programArguments[1];
  if (executable === 'bash' || executable === 'sh' || executable === 'zsh') {
    if (first === '-c' || first === '-lc') return 'inline';
    return first !== undefined && !first.startsWith('-') ? 1 : null;
  }
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(executable)) {
    if (first === '-m') return programArguments.length === 3 && PYTHON_MODULE.test(programArguments[2] ?? '') ? 'python-module' : null;
    if (first === '-I') return programArguments[2] !== undefined && !programArguments[2]!.startsWith('-') ? 2 : null;
    return first !== undefined && !first.startsWith('-') ? 1 : null;
  }
  if (executable === 'node' || executable === 'nodejs') return first !== undefined && !first.startsWith('-') ? 1 : null;
  return null;
}

/**
 * Re-read the finite outside-unit declaration. It is deliberately proof-only:
 * the host transaction never stages, writes, reloads, or stops these jobs.
 */
export async function verifyReviewedOutsideUnits(
  host: ActivationHost,
  outsideUnits: readonly ReviewedOutsideUnit[],
): Promise<Array<{ label: string; ok: boolean; detail: string }>> {
  const results: Array<{ label: string; ok: boolean; detail: string }> = [];
  for (const outsideUnit of outsideUnits) {
    const fail = (detail: string): void => { results.push({ label: outsideUnit.label, ok: false, detail }); };
    if (!sameStrings(outsideUnit.reviewInputs.roots, outsideUnit.selectionRoots)
      || !sameStrings(outsideUnit.reviewInputs.links, outsideUnit.selectionLinks)) {
      fail('review roots or links do not exactly bind the selected host tuple'); continue;
    }
    const selected = [...outsideUnit.selectionRoots, ...outsideUnit.selectionLinks];
    const resolvedSelected = resolveSelectedPaths(selected);
    if (resolvedSelected === null) { fail('selected root or launcher unavailable'); continue; }
    if (outsideUnit.reviewInputs.files.some((file) => file.path === outsideUnit.plistPath)) {
      fail('review input path duplicates the installed plist'); continue;
    }
    const plist = readDigest(outsideUnit.plistPath);
    if (plist === null) { fail('installed plist is unavailable'); continue; }
    const plistText = plist.bytes.toString('utf8');
    if (plist.sha256 !== outsideUnit.plistSha256) { fail('installed plist digest differs from the reviewed declaration'); continue; }
    // Only the empty stub is exempt from review: any other plist left installed can load at the next login.
    if (outsideUnit.loadState === 'unloaded-113' && plist.bytes.length !== 0) { fail('unloaded-113 plist is not a zero-byte stub'); continue; }
    if (selected.some((root) => mentionsReleaseRoot(plistText, root))) { fail('installed plist references a selected root or launcher'); continue; }
    let filesValid = true;
    for (const file of outsideUnit.reviewInputs.files) {
      const location = underSelectedPath(file.path, selected, resolvedSelected, false);
      const source = readDigest(file.path);
      if (location !== false || source === null || source.sha256 !== file.sha256 || selected.some((root) => mentionsReleaseRoot(source.bytes.toString('utf8'), root))) { filesValid = false; break; }
    }
    if (!filesValid) { fail('reviewed source input is unavailable, changed, or selects a unit root'); continue; }
    if (outsideUnit.loadState === 'unloaded-113') {
      const unloaded = await host.exec('/bin/launchctl', ['print', `${outsideUnit.domain}/${outsideUnit.label}`], { timeoutMs: 5_000 });
      if (unloaded.code !== 113 || unloaded.timedOut === true) { fail('job is not the reviewed explicit launchctl exit 113 state'); continue; }
      results.push({ label: outsideUnit.label, ok: true, detail: 'reviewed explicit exit 113' }); continue;
    }
    // A loaded unit's plist is read strictly, so a character reference or a CDATA section cannot hide an environment
    // key or a working directory from the proofs below. The zero-byte unloaded-113 stub above is never parsed.
    const read = readStrictPlist(plistText);
    if (!read.ok) { fail(`installed loaded plist is unreadable: ${read.error}`); continue; }
    const installed = outsideUnitDefinition(read.root);
    if (installed === null || installed.label !== outsideUnit.label || installed.programArguments.length === 0) { fail('installed loaded plist is unreadable or has a mismatched label'); continue; }
    const interpreter = INTERPRETER.test(path.basename(installed.programArguments[0]!));
    const reviewedFiles = new Set(outsideUnit.reviewInputs.files.map((file) => file.path));
    let pythonModule: { workingDirectory: string; sources: string[] } | null = null;
    if (interpreter) {
      if (reviewedFiles.size === 0) { fail('loaded interpreter has no reviewed source input'); continue; }
      const scriptIndex = interpreterScriptIndex(installed.programArguments);
      if (scriptIndex === null) { fail('loaded interpreter form is not a bounded reviewed launch form'); continue; }
      const absoluteArguments = installed.programArguments
        .map((argument, index) => ({ argument, index }))
        .filter(({ argument, index }) => index > 0 && path.isAbsolute(argument));
      const bindings = outsideUnit.reviewInputs.argumentBindings;
      const complete = bindings.length === absoluteArguments.length && absoluteArguments.every(({ argument, index }, position) => {
        const binding = bindings[position];
        return binding !== undefined && binding.index === index && binding.path === argument;
      });
      if (!complete) { fail('loaded interpreter has an unbound or mismatched absolute argument'); continue; }
      let bindingsValid = true;
      for (const binding of bindings) {
        const location = underSelectedPath(binding.path, selected, resolvedSelected, binding.kind === 'runtime-data');
        if (location !== false || (binding.kind === 'review-file' && !reviewedFiles.has(binding.path))
          || (binding.kind === 'runtime-data' && reviewedFiles.has(binding.path))) { bindingsValid = false; break; }
      }
      if (!bindingsValid) { fail('loaded interpreter binding is not a reviewed source or declared outside runtime data path'); continue; }
      if (scriptIndex === 'python-module') {
        const plistWorkingDirectory = installed.workingDirectory;
        const workingDirectory = plistWorkingDirectory === null ? null : absolute(plistWorkingDirectory);
        const cwdLocation = workingDirectory === null ? null : underSelectedPath(workingDirectory, selected, resolvedSelected, false);
        const sources = workingDirectory === null ? null : reviewedPythonModuleSources(workingDirectory, installed.programArguments[2]!);
        if (workingDirectory === null || workingDirectory !== plistWorkingDirectory || cwdLocation !== false
          || !isDirectory(workingDirectory) || sources === null || !installedEnvironmentClear(installed.environmentKeys, (key) => key.startsWith('PYTHON'))
          || sources.some((source) => !reviewedFiles.has(source) || !isRegularFile(source))) {
          fail('loaded Python module lacks an exact outside working-directory, environment, or reviewed package source proof'); continue;
        }
        pythonModule = { workingDirectory, sources };
      } else if (scriptIndex !== 'inline') {
        const scriptPath = absolute(installed.programArguments[scriptIndex]);
        const scriptBinding = bindings.find((binding) => binding.index === scriptIndex);
        if (scriptPath === null || scriptBinding?.path !== scriptPath || scriptBinding.kind !== 'review-file' || !reviewedFiles.has(scriptPath)) {
          fail('loaded interpreter script is not bound to a reviewed source input'); continue;
        }
      }
    }
    const loaded = await loadedJobDefinition(host, outsideUnit.domain, outsideUnit.label);
    const exact = loaded !== null && loaded.path === outsideUnit.plistPath
      && loaded.program === installed.programArguments[0] && sameArgs(loaded.arguments, installed.programArguments);
    if (!exact) { fail('loaded definition differs from the reviewed installed plist'); continue; }
    if (pythonModule !== null && (loaded.workingDirectory !== pythonModule.workingDirectory || loaded.pythonEnvironmentKeys.length !== 0)) {
      fail('loaded Python module working directory or environment differs from the reviewed installed proof'); continue;
    }
    results.push({ label: outsideUnit.label, ok: true, detail: 'exact installed and loaded reviewed definition' });
  }
  return results;
}
/**
 * A manifestless old release is admitted only by the HEAD of its own work tree:
 * tool-commit.ts asks git with the clean git environment and accepts the answer
 * only when git's top level is this release directory, so an inherited
 * GIT_DIR/GIT_WORK_TREE or an enclosing checkout yields no commit.
 */
async function exactOldCommit(host: ActivationHost, context: ActivationContext): Promise<string | null> {
  if (context.oldCommit !== null) return context.oldCommit;
  const commit = await checkoutCommit(context.args.expectCurrent, async (file, args, { env, timeoutMs }) => {
    // host.exec runs the child with exactly these variables plus the tool's PATH.
    const variables = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const result = await host.exec(file, args, { env: variables, timeoutMs });
    return { code: result.code, stdout: result.stdout };
  });
  if (commit === null) return null;
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
  // A member or host auxiliary is never another configured instance's primary label (an instance as fleet
  // discovery finds it, <config root>/<name>/config.json): the declaration does not widen the member set
  // (docs/runbooks/release-deployment.md, `npm run release:activate-host`). A declared member's label
  // refuses at parse. Only a com.whatsoup.<name> label can be an instance's primary label.
  const auxiliaryNotInstance = (id: string, label: string): void => {
    const named = label.startsWith('com.whatsoup.') ? instance(label.slice('com.whatsoup.'.length)) : null;
    const configured = named !== null && existsSync(path.join(configRoot(), named, 'config.json'));
    check(`${id}:${label}`, !configured, configured ? 'names another configured instance' : 'names no configured instance');
  };
  for (const member of declaration.members) {
    for (const auxiliary of member.auxLabels) auxiliaryNotInstance('member-aux-not-instance', auxiliary.label);
  }
  for (const auxiliary of declaration.hostAuxiliaries) auxiliaryNotInstance('host-aux-not-instance', auxiliary.label);

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
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const selectionRoots = [options.release, ...declaration.members.map((member) => member.expectCurrent), ...declaration.hostAuxiliaries.flatMap((auxiliary) => auxiliary.expectCurrent === null ? [] : [auxiliary.expectCurrent])]
    .sort().filter((root, index, values) => index === 0 || values[index - 1] !== root);
  const selectionLinks = [...contexts.map((context) => context.wrapperLink), ...declaration.hostAuxiliaries.flatMap((auxiliary) => auxiliary.link === null ? [] : [auxiliary.link])]
    .sort().filter((link, index, values) => index === 0 || values[index - 1] !== link);
  const outsideUnits: ReviewedOutsideUnit[] = declaration.outsideUnits.map((outsideUnit) => ({
    ...outsideUnit, plistPath: path.join(launchAgentsDir, `${outsideUnit.label}.plist`), domain, selectionRoots, selectionLinks,
  }));
  for (const outsideUnit of await verifyReviewedOutsideUnits(host, outsideUnits)) {
    check(`outside-unit:${outsideUnit.label}`, outsideUnit.ok, outsideUnit.detail);
  }
  const declaredLabels = new Set<string>();
  const shared = new Map<string, string[]>();
  const documentMembers: Array<Record<string, unknown>> = [];
  for (const member of declaration.members) {
    declaredLabels.add(`com.whatsoup.${member.instance}`);
    for (const auxiliary of member.auxLabels) declaredLabels.add(auxiliary.label);
  }
  for (const auxiliary of declaration.hostAuxiliaries) declaredLabels.add(auxiliary.label);
  // The bounded host inventory admits the one closed non-WhatSoup release
  // consumer, so only a successful inventory can prove it is absent. A
  // failed per-job read never establishes absence.
  if (!declaredLabels.has('com.bot-errors.health')) {
    const loadedBotErrors = inventory?.find((entry) => entry.label === 'com.bot-errors.health');
    const absent = inventory !== null && loadedBotErrors === undefined;
    check('closed-host-aux-declared:com.bot-errors.health', absent,
      inventory === null ? 'loaded domain unavailable; bot-errors absence unproven'
        : loadedBotErrors === undefined ? 'absent from accepted loaded domain inventory'
          : 'loaded bot-errors health job must be explicitly declared');
  }
  const installedLabels = (() => {
    try { return readdirSync(launchAgentsDir).filter((name) => name.endsWith('.plist')).map((name) => name.slice(0, -'.plist'.length)); }
    catch { check('installed-inventory', false, 'LaunchAgents unreadable'); return [] as string[]; }
  })();
  const unionLabels = new Set([...installedLabels, ...(inventory ?? []).map((entry) => entry.label)]);
  for (const label of unionLabels) {
    const retiredScript = RETIRED_JOBS.get(label);
    // A configured instance owns its name: it is checked as an instance below, never as the retired job.
    if (retiredScript !== undefined && !existsSync(path.join(configRoot(), label.slice('com.whatsoup.'.length), 'config.json'))) {
      const canonicalPlist = path.join(launchAgentsDir, `${label}.plist`);
      const isLoaded = inventory?.some((entry) => entry.label === label) === true;
      // launchd may have loaded the job from another plist; that file is the one that can load it again.
      const loadedFrom = isLoaded ? (await loadedJobDefinition(host, domain, label))?.path ?? null : null;
      const present = (file: string): boolean => { try { lstatSync(file); return true; } catch { return false; } };
      const remove = [...(loadedFrom !== null && loadedFrom !== canonicalPlist ? [loadedFrom] : []), ...[canonicalPlist, path.join(os.homedir(), retiredScript)].filter(present)];
      const bootOut = !isLoaded ? '' : loadedFrom === null ? 'boot the job out, then ' : `boot the job out (loaded from ${loadedFrom}), then `;
      check(`retired:${label}`, false, `retired from the standard; ${bootOut}remove ${remove.length > 0 ? remove.join(' and ') : canonicalPlist}`);
      continue;
    }
    // Each closed host auxiliary obtains its own exact loaded definition below:
    // the standard inventory intentionally filters external labels.
    if (declaration.hostAuxiliaries.some((auxiliary) => auxiliary.label === label) || declaration.outsideUnits.some((outsideUnit) => outsideUnit.label === label)) continue;
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
        check(`unowned-selector:${label}`, provenOutsideUnit(installed, installedText, selectionRoots, selectionLinks), 'unrecognized selector must be an absolute non-interpreter executable with no unit-root or launcher references');
        continue;
      }
      const selectedLink = contexts.some((context) => installed?.programArguments[0] === context.wrapperLink) || declaration.hostAuxiliaries.some((auxiliary) => auxiliary.link !== null && installed?.programArguments[0] === auxiliary.link);
      const releaseDependent = selection.releasePath === options.release || declaration.members.some((member) => selection!.releasePath === member.expectCurrent)
        || declaration.hostAuxiliaries.some((auxiliary) => auxiliary.expectCurrent !== null && selection!.releasePath === auxiliary.expectCurrent);
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
      shared.set(context.wrapperLink, [...(shared.get(context.wrapperLink) ?? []), context.instanceLabel]);
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
  const hostAuxiliaryApply: Array<{ label: string; mode: 'path-rebase' | 'setup-timer'; home: string; plistPath: string; installedSha256: string; staged: string; expectCurrent: string }> = [];
  // Launcher and watchdog plists are loaded but never written: apply rechecks them against the digest read here.
  const hostLaunchers: Array<{ label: string; plistPath: string; installedSha256: string; link: string; wrapper: 'whatsoup-fleet'; expectCurrent: string }> = [];
  const watchdogs: Array<{ label: string; plistPath: string; installedSha256: string }> = [];
  for (const auxiliary of declaration.hostAuxiliaries) {
    const plistPath = path.join(launchAgentsDir, `${auxiliary.label}.plist`);
    const installed = (() => { try { return readFileSync(plistPath, 'utf8'); } catch { return null; } })();
    const parsed = installed === null ? null : parsePlist(installed);
    const loaded = await loadedJobDefinition(host, domain, auxiliary.label);
    const exactLoaded = parsed !== null && loaded !== null && loaded.path === plistPath
      && loaded.program === parsed.programArguments[0] && sameArgs(loaded.arguments, parsed.programArguments);
    check(`host-aux-installed-loaded-match:${auxiliary.label}`, exactLoaded, 'exact path/program/arguments');
    // A path-rebase plist is read strictly before any other proof reads it: the regular-expression reader can read
    // text launchd never sees (a binary plist's string object) and miss text launchd does see (a UTF-16 plist).
    const strict = installed !== null && auxiliary.mode === 'path-rebase' ? readStrictPlist(installed) : null;
    if (strict !== null && !strict.ok) { check(`host-aux-plist-staged:${auxiliary.label}`, false, strict.error); continue; }
    if (installed === null || parsed === null || loaded === null) continue;
    if (auxiliary.mode === 'quiesce') {
      check(`host-watchdog-outside-unit:${auxiliary.label}`, provenOutsideUnit(parsed, installed, selectionRoots, selectionLinks), 'watchdog must not select a member, host auxiliary, or managed launcher root');
      watchdogs.push({ label: auxiliary.label, plistPath, installedSha256: plistDigest(installed) });
      continue;
    }
    const expectCurrent = auxiliary.expectCurrent!;
    if (auxiliary.mode === 'fleet-wrapper') {
      const selected = parsed.programArguments[0] === auxiliary.link;
      let linkCurrent = false;
      try { linkCurrent = readlinkSync(auxiliary.link!) === path.join(expectCurrent, 'deploy', 'whatsoup-fleet'); } catch { /* recorded below */ }
      let resolverCurrent = false;
      try { resolverCurrent = resolveLaunchdReleaseSelection(plistPath).releasePath === expectCurrent; } catch { /* recorded below */ }
      check(`host-aux-on-expected-release:${auxiliary.label}`, selected && linkCurrent && resolverCurrent, 'fleet ProgramArguments and wrapper link select the declared expected-current release');
      hostLaunchers.push({ label: auxiliary.label, plistPath, installedSha256: plistDigest(installed), link: auxiliary.link!, wrapper: 'whatsoup-fleet', expectCurrent });
      continue;
    }
    const onExpected = programArgumentsUnder(parsed.programArguments, expectCurrent);
    check(`host-aux-on-expected-release:${auxiliary.label}`, onExpected, 'ProgramArguments select the declared expected-current release');
    const rendered = auxiliary.mode === 'path-rebase'
      ? isLegacyPathRebaseLabel(auxiliary.label)
        ? stagePathRebase(installed, expectCurrent, options.release, auxiliary.label, os.homedir())
        : { staged: null, error: 'undeclared legacy path-rebase label' }
      : await renderAuxPlist(host, { label: auxiliary.label, renderer: 'setup-timer' }, {
        release: options.release, home: os.homedir(), installedPath: plistPath, installed, instance: contexts[0]!.args.instance,
      });
    let staged = rendered.staged;
    let stagedOk = rendered.error === null && staged !== null;
    let stagedDetail = rendered.error ?? 'staged';
    if (stagedOk) {
      const stagedParsed = parsePlist(staged!);
      if (stagedParsed === null || !programArgumentsUnder(stagedParsed.programArguments, options.release)
        || mentionsReleaseRoot(staged!, expectCurrent)) {
        stagedOk = false;
        stagedDetail = 'staged plist does not select only the target release';
      } else if (stagedParsed.label !== auxiliary.label) {
        // Apply writes the staged content to <label>.plist and reloads that label.
        stagedOk = false;
        stagedDetail = 'staged plist Label is not the declared host auxiliary label';
      } else if (auxiliary.mode === 'setup-timer'
        && !sameArgs(stagedParsed.programArguments, rebaseProgramArguments(parsed.programArguments, expectCurrent, options.release))) {
        stagedOk = false;
        stagedDetail = 'rendered ProgramArguments drift after exact root rebase';
      }
    }
    check(`host-aux-plist-staged:${auxiliary.label}`, stagedOk, stagedDetail);
    if (stagedOk) hostAuxiliaryApply.push({ label: auxiliary.label, mode: auxiliary.mode, home: os.homedir(), plistPath, installedSha256: plistDigest(installed), staged: staged!, expectCurrent });
  }

  // A host operator may use the standard launcher even when every member
  // plist is direct. It joins the existing launcher transaction only if it
  // already resolves to one declared rollback root; an unrelated link stays
  // outside the host unit.
  for (const link of new Set(contexts.map((context) => context.wrapperLink))) {
    if (shared.has(link)) continue;
    const linkContexts = contexts.filter((context) => context.wrapperLink === link);
    try {
      const target = readlinkSync(link);
      if (linkContexts.some((context) => target === wrapperTargetFor(context.args.expectCurrent))) {
        shared.set(link, []);
        check(`direct-only-launcher:${link}`, true, 'selects a declared old release');
      } else {
        check(`direct-only-launcher:${link}`, true, 'readable symlink selects an undeclared root; outside unit');
      }
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : null;
      check(`direct-only-launcher:${link}`, code === 'ENOENT', code === 'ENOENT'
        ? 'absent operator launcher; outside unit'
        : 'operator launcher is unreadable or not a symlink');
    }
  }

  // Every installed and loaded job consuming a selected shared launcher must
  // be declared. Do not infer membership from a label prefix.
  for (const [link, consumers] of shared) {
    const observed: string[] = [];
    for (const label of installedLabels) {
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
      try { if (parsePlist(readFileSync(plistPath, 'utf8'))?.programArguments[0] === link) observed.push(label); } catch { check(`shared-launcher-readable:${label}`, false, 'installed plist unreadable'); }
    }
    const expected = [...consumers].sort(); const actual = observed.sort();
    check(`shared-launcher-members:${link}`, sameArgs(expected, actual), `expected ${expected.length}, observed ${actual.length}`);
    try {
      const owner = contexts.find((context) => consumers.includes(context.instanceLabel))
        ?? contexts.find((context) => context.wrapperLink === link && readlinkSync(link) === wrapperTargetFor(context.args.expectCurrent));
      check(`shared-launcher-on-current:${link}`, owner !== undefined && readlinkSync(link) === path.join(owner.args.expectCurrent, 'deploy', 'whatsoup'), 'expected current target');
    } catch { check(`shared-launcher-on-current:${link}`, false, 'link unreadable'); }
  }
  for (const launcher of hostLaunchers) {
    const observed = installedLabels.filter((label) => {
      try { return parsePlist(readFileSync(path.join(launchAgentsDir, `${label}.plist`), 'utf8'))?.programArguments[0] === launcher.link; } catch { return false; }
    }).sort();
    check(`shared-launcher-members:${launcher.link}`, sameArgs([launcher.label], observed), `expected 1, observed ${observed.length}`);
  }
  for (const label of declaredLabels) check(`loaded-no-extra-declaration:${label}`, true, 'declared');
  const ready = checks.every((entry) => entry.ok) && contexts.every(preconditionsMet);
  const commit = contexts[0]?.newCommit ?? null;
  const applyContext = ready && commit !== null ? { release: options.release, commit, backupDir: options.backupDir, members: contexts, sharedLaunchers: shared, hostAuxiliaries: hostAuxiliaryApply, hostLaunchers, watchdogs, outsideUnits } : null;
  return {
    ready,
    applyContext,
    document: {
      mode: options.mode, ready, toolCommit: await host.toolCommit(), release: { path: options.release, commit }, backupDir: options.backupDir,
      members: documentMembers, hostAuxiliaries: declaration.hostAuxiliaries.map((auxiliary) => ({ label: auxiliary.label, mode: auxiliary.mode, plistDigest: digestFile(path.join(launchAgentsDir, `${auxiliary.label}.plist`)) })), outsideUnits: declaration.outsideUnits.map((outsideUnit) => ({ label: outsideUnit.label, loadState: outsideUnit.loadState, plistDigest: digestFile(path.join(launchAgentsDir, `${outsideUnit.label}.plist`)), reviewTupleSha256: reviewTupleSha256(outsideUnit) })), sharedLaunchers: [...shared.entries()].map(([link, consumers]) => ({ link, consumers })),
      preconditions: checks,
      actions: ['backup-all-members-and-host-auxiliaries', 'quiesce-watchdogs', 'stage-all-selectors', 'switch-all-selectors', 'reload-primary-then-auxiliary', 'verify-all-members', 'restore-watchdogs', 'group-rollback'],
    },
  };
}
