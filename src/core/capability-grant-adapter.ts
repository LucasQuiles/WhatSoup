// src/core/capability-grant-adapter.ts
//
// WhatSoup wiring for the policy-agnostic capability-grant manager
// (src/lib/capability-grant.ts). Three pieces:
//
//  1. createSettingsPolicyAdapter — a PolicyAdapter backed by an instance's
//     .claude/settings.json permissions block. Reads permissions.{allow,deny};
//     persists deltas via workspace.writePermissionsSettings.
//
//  2. createFileGrantStore — a GrantStore backed by a 0600 JSON file so an
//     active grant survives process restarts and reconcile() can revert an
//     expired grant on the next startup.
//
//  3. assertGroupsRespectDenyFloor — a construction-time guard: no grant group
//     may unlock a capability that sits in the REQUIRED_DENY floor.
//
// SECURITY INVARIANT (privilege-escalation prevention): a grant must NEVER
// remove a REQUIRED_DENY floor entry from the deny list. This is enforced in
// TWO independent places:
//   - Front door: assertGroupsRespectDenyFloor rejects any group whose
//     capabilities intersect REQUIRED_DENY at manager-construction time.
//   - Back door: writePermissionsSettings re-unions REQUIRED_DENY into the deny
//     list on EVERY write (settings-template.applyRequiredDeny), so even if a
//     delta's removeDeny targeted a floor entry, it is re-added at persist time.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { writePermissionsSettings } from './workspace.ts';
import { REQUIRED_DENY } from './settings-template.ts';
import { writePrivateJsonMarkerSync } from '../lib/private-fs.ts';
import type {
  PolicyAdapter,
  PolicySnapshot,
  PolicyDelta,
  GrantStore,
  GrantRecord,
  GrantGroup,
  GrantGroupDefinition,
} from '../lib/capability-grant.ts';

/** Read the current permissions.{allow,deny} from an instance's settings.json. */
function readPermissionSets(settingsPath: string): { allow: string[]; deny: string[] } {
  if (!existsSync(settingsPath)) return { allow: [], deny: [] };
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      permissions?: { allow?: unknown; deny?: unknown };
    };
    const perms = parsed?.permissions ?? {};
    const asStrings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    return { allow: asStrings(perms.allow), deny: asStrings(perms.deny) };
  } catch {
    // Unreadable/corrupt settings.json — treat as empty. writePermissionsSettings
    // re-establishes the deny floor on the next write regardless.
    return { allow: [], deny: [] };
  }
}

/**
 * PolicyAdapter backed by `<claudeDir>/settings.json`. Every persist routes
 * through writePermissionsSettings, which re-unions the REQUIRED_DENY floor —
 * so this adapter cannot strip a floor entry no matter what delta it is given.
 */
export function createSettingsPolicyAdapter(claudeDir: string): PolicyAdapter {
  const settingsPath = join(claudeDir, 'settings.json');

  const read = async (): Promise<PolicySnapshot> => {
    const { allow, deny } = readPermissionSets(settingsPath);
    return { allow: new Set(allow), deny: new Set(deny) };
  };

  const apply = async (delta: PolicyDelta): Promise<void> => {
    const { allow: allowArr, deny: denyArr } = readPermissionSets(settingsPath);
    const allow = new Set(allowArr);
    const deny = new Set(denyArr);
    for (const c of delta.addAllow) allow.add(c);
    for (const c of delta.removeAllow) allow.delete(c);
    for (const c of delta.addDeny) deny.add(c);
    for (const c of delta.removeDeny) deny.delete(c);
    writePermissionsSettings(claudeDir, {
      permissions: {
        allow: [...allow],
        deny: [...deny],
        defaultMode: 'bypassPermissions',
      },
    });
  };

  return { read, apply };
}

/**
 * Shape schema for GrantRecord.
 *
 * `.passthrough()` because the previous hand-rolled guard only checked the
 * listed keys — payloads carrying unknown extra keys stay accepted.
 * `armedAtMs`/`expiresAtMs` use `.int().safe()` rather than plain `.int()`:
 * plain `.int()` accepts values like 2**60 (Number.isInteger true but
 * Number.isSafeInteger false), which the previous `Number.isSafeInteger`
 * check rejected. `satisfies` pins the schema output to the exported wire
 * type at compile time.
 */
const GrantRecordShapeSchema = z.object({
  version: z.literal(2),
  armedAtMs: z.number().int().safe().nonnegative(),
  expiresAtMs: z.number().int().safe().nullable(),
  group: z.string().min(1),
  capabilities: z.array(z.string()),
  addedToAllow: z.array(z.string()),
  removedFromDeny: z.array(z.string()),
}).passthrough() satisfies z.ZodType<GrantRecord>;

/**
 * Full schema: shape plus the cross-field checks the previous ladder
 * enforced inline — expiresAtMs (when non-null) must be strictly after
 * armedAtMs, and every addedToAllow/removedFromDeny entry must be a member
 * of capabilities.
 */
const GrantRecordSchema = GrantRecordShapeSchema.superRefine((record, ctx) => {
  if (record.expiresAtMs !== null && record.expiresAtMs <= record.armedAtMs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAtMs'],
      message: 'expiresAtMs must be greater than armedAtMs',
    });
  }
  for (const entry of record.addedToAllow) {
    if (!record.capabilities.includes(entry)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['addedToAllow'],
        message: `addedToAllow entry not present in capabilities: ${entry}`,
      });
    }
  }
  for (const entry of record.removedFromDeny) {
    if (!record.capabilities.includes(entry)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['removedFromDeny'],
        message: `removedFromDeny entry not present in capabilities: ${entry}`,
      });
    }
  }
});

/** Shape-check persisted rollback state before it can drive reconciliation. */
function isGrantRecord(v: unknown): v is GrantRecord {
  return GrantRecordSchema.safeParse(v).success;
}

/**
 * GrantStore backed by a single 0600 JSON file. write(null) clears the active
 * grant by removing the file. A malformed file rejects startup reconciliation:
 * treating unknown rollback state as "not armed" could leave policy elevated.
 */
export function createFileGrantStore(storePath: string): GrantStore {
  const read = async (): Promise<GrantRecord | null> => {
    if (!existsSync(storePath)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(storePath, 'utf8'));
    } catch (error) {
      throw new Error(`invalid capability grant store: ${storePath}`, { cause: error });
    }
    if (!isGrantRecord(parsed)) {
      throw new Error(`invalid capability grant store: ${storePath}`);
    }
    return parsed;
  };

  const write = async (record: GrantRecord | null): Promise<void> => {
    if (record === null) {
      if (existsSync(storePath)) rmSync(storePath);
      return;
    }
    writePrivateJsonMarkerSync(storePath, record, {
      label: 'capability grant store',
      directoryFsync: 'required',
    });
  };

  return { read, write };
}

/**
 * Construction-time floor guard. Throws if any grant group would unlock a
 * capability in the REQUIRED_DENY floor — a group like that could only ever
 * be a no-op (writePermissionsSettings would re-deny it) or a privilege-
 * escalation attempt, so we reject the configuration outright rather than
 * silently arm a grant that does nothing.
 */
export function assertGroupsRespectDenyFloor(
  groups: Record<GrantGroup, GrantGroupDefinition>,
): void {
  const floor = new Set<string>(REQUIRED_DENY);
  for (const [name, def] of Object.entries(groups)) {
    for (const cap of def.capabilities) {
      if (floor.has(cap)) {
        throw new Error(
          `capability-grant group '${name}' would unlock a REQUIRED_DENY floor entry: ${cap}`,
        );
      }
    }
  }
}
