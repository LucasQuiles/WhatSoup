import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { ZodError, type ZodIssue } from 'zod';
import { resolveExtends } from './extends.ts';
import { PolicySchema, ProfileNameSchema, type Policy } from './schema.ts';

const DEFAULT_PROFILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'profiles');

type PlainObject = Record<string, unknown>;

export interface LoadPolicyOptions {
  profileDir?: string | undefined;
}

export function loadPolicy(path: string, options: LoadPolicyOptions = {}): Policy {
  const policyName = basename(path);
  const profileDir = options.profileDir ?? DEFAULT_PROFILE_DIR;
  const raw = resolvePolicyGraph(readPolicyFile(path), {
    currentName: basename(path, '.yaml'),
    profileDir,
    stack: [],
  });

  try {
    return PolicySchema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`policy invalid for ${policyName}: ${formatIssues(error.issues)}`, { cause: error });
    }
    throw error;
  }
}

function readPolicyFile(path: string): unknown {
  const policyName = basename(path);
  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`policy file read failed for ${policyName}`, { cause: error });
  }

  try {
    return parseYaml(text);
  } catch (error) {
    throw new Error(`policy yaml parse failed for ${policyName}`, { cause: error });
  }
}

interface ResolveGraphContext {
  currentName: string;
  profileDir: string;
  stack: string[];
}

function resolvePolicyGraph(raw: unknown, ctx: ResolveGraphContext): unknown {
  if (!isPlainObject(raw)) return raw;

  const parentName = parentProfileName(raw);
  if (!parentName) return raw;
  if (parentName === ctx.currentName && parentName === 'development') return raw;
  if (parentName === ctx.currentName || ctx.stack.includes(parentName)) {
    throw new Error(`profile extends cycle: ${[...ctx.stack, ctx.currentName, parentName].join(' -> ')}`);
  }

  const parentPath = resolve(ctx.profileDir, `${parentName}.yaml`);
  if (!existsSync(parentPath)) {
    throw new Error(`parent profile not found: ${parentName}`);
  }

  const parent = resolvePolicyGraph(readPolicyFile(parentPath), {
    currentName: parentName,
    profileDir: ctx.profileDir,
    stack: [...ctx.stack, ctx.currentName],
  });
  if (!isPlainObject(parent)) return raw;

  rejectForbiddenDomainWeakening(parent, raw);
  return resolveExtends(parent, raw);
}

function parentProfileName(raw: PlainObject): string | undefined {
  const candidate = raw.extends;
  if (typeof candidate !== 'string') return undefined;
  return ProfileNameSchema.safeParse(candidate).success ? candidate : undefined;
}

function rejectForbiddenDomainWeakening(parent: PlainObject, child: PlainObject): void {
  const parentDomains = readForbiddenDomains(parent);
  const childDomains = readForbiddenDomains(child);
  if (parentDomains === undefined || parentDomains.length === 0 || childDomains === undefined) return;

  const missing = parentDomains.filter((domain) => !childDomains.includes(domain));
  if (missing.length > 0) {
    throw new Error(`cannot weaken forbidden mute domains: ${missing.join(', ')}`);
  }
}

function readForbiddenDomains(raw: PlainObject): string[] | undefined {
  const muteConstraints = raw.mute_constraints;
  if (!isPlainObject(muteConstraints)) return undefined;
  const forbiddenDomains = muteConstraints.forbidden_domains;
  return Array.isArray(forbiddenDomains)
    ? forbiddenDomains.filter((domain): domain is string => typeof domain === 'string')
    : undefined;
}

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function formatIssues(issues: ZodIssue[]): string {
  return issues.map(formatIssue).join('; ');
}

function formatIssue(issue: ZodIssue): string {
  const path = issue.path.length === 0 ? '<root>' : issue.path.join('.');
  return `${path}: ${issue.message}`;
}
