// tests/core/settings-template-zod-equivalence.test.ts
//
// Equivalence net for #2203: `isValidPermissionsSettings` (exported) and the
// module-private `isValidPermissionsShape` in `src/core/settings-template.ts`
// move from hand-rolled typeof ladders to Zod schemas. The verbatim
// pre-conversion ladders are kept below as the reference implementation.
//
// Each case carries two expected verdicts:
//   - `full`  — shape + REQUIRED_DENY floor subset (isValidPermissionsSettings)
//   - `shape` — shape only (isValidPermissionsShape, observed through the
//               mergeSettingsJson branch: custom preserved vs defaults fallback)

import { describe, it, expect } from 'vitest';
import {
  isValidPermissionsSettings,
  mergeSettingsJson,
  applyRequiredDeny,
  AGENT_DEFAULT_ALLOW,
  REQUIRED_DENY,
  type PermissionsSettings,
} from '../../src/core/settings-template.ts';

// --- Reference implementation: verbatim pre-#2203 hand-rolled ladders. ---
// Do not modernize these — they define the value space the Zod schemas must
// reproduce exactly.
function referenceIsValidPermissionsShape(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const p = (v as Record<string, unknown>).permissions;
  if (typeof p !== 'object' || p === null) return false;
  const perms = p as Record<string, unknown>;
  return Array.isArray(perms.allow)
    && (perms.allow as unknown[]).every((x: unknown) => typeof x === 'string')
    && Array.isArray(perms.deny)
    && (perms.deny as unknown[]).every((x: unknown) => typeof x === 'string')
    && perms.defaultMode === 'bypassPermissions';
}

function referenceIsValidPermissionsSettings(v: unknown): boolean {
  if (!referenceIsValidPermissionsShape(v)) return false;
  const denyList = (v as PermissionsSettings).permissions.deny;
  const denySet = new Set(denyList);
  for (const required of REQUIRED_DENY) {
    if (!denySet.has(required)) return false;
  }
  return true;
}

// Distinctive allow marker so the mergeSettingsJson branch (custom preserved
// vs defaults fallback) is observable without ambiguity.
const MARKER_ALLOW = ['Equivalence__Marker__Tool'];
const FLOOR = [...REQUIRED_DENY];

function validPermissions(): Record<string, unknown> {
  return { allow: [...MARKER_ALLOW], deny: [...FLOOR], defaultMode: 'bypassPermissions' };
}

interface Case {
  name: string;
  value: unknown;
  full: boolean;
  shape: boolean;
}

const cases: Case[] = [
  // Accepted shapes.
  { name: 'canonical settings with full deny floor', value: { permissions: validPermissions() }, full: true, shape: true },
  { name: 'enabledPlugins record tolerated', value: { permissions: validPermissions(), enabledPlugins: { a: true } }, full: true, shape: true },
  { name: 'enabledPlugins wrong type tolerated (ladder never validated it)', value: { permissions: validPermissions(), enabledPlugins: 'nope' }, full: true, shape: true },
  { name: 'extra top-level key tolerated', value: { permissions: validPermissions(), junk: 42 }, full: true, shape: true },
  { name: 'extra key inside permissions tolerated', value: { permissions: { ...validPermissions(), extra: true } }, full: true, shape: true },
  { name: 'allow empty array', value: { permissions: { ...validPermissions(), allow: [] } }, full: true, shape: true },
  { name: 'allow containing empty string', value: { permissions: { ...validPermissions(), allow: [''] } }, full: true, shape: true },
  { name: 'deny superset of floor', value: { permissions: { ...validPermissions(), deny: [...FLOOR, 'extra-deny'] } }, full: true, shape: true },
  // Floor-only rejection: shape passes, subset check fails.
  { name: 'deny floor missing one entry', value: { permissions: { ...validPermissions(), deny: FLOOR.slice(1) } }, full: false, shape: true },
  { name: 'deny empty array', value: { permissions: { ...validPermissions(), deny: [] } }, full: false, shape: true },
  // allow field rejections.
  { name: 'allow non-string entry (number)', value: { permissions: { ...validPermissions(), allow: [42] } }, full: false, shape: false },
  { name: 'allow non-string entry (null)', value: { permissions: { ...validPermissions(), allow: ['Bash', null] } }, full: false, shape: false },
  { name: 'allow string instead of array', value: { permissions: { ...validPermissions(), allow: 'Bash' } }, full: false, shape: false },
  { name: 'allow missing', value: { permissions: { deny: [...FLOOR], defaultMode: 'bypassPermissions' } }, full: false, shape: false },
  { name: 'allow null', value: { permissions: { ...validPermissions(), allow: null } }, full: false, shape: false },
  // deny field rejections.
  { name: 'deny non-string entry', value: { permissions: { ...validPermissions(), deny: [...FLOOR, 7] } }, full: false, shape: false },
  { name: 'deny object instead of array', value: { permissions: { ...validPermissions(), deny: {} } }, full: false, shape: false },
  { name: 'deny missing', value: { permissions: { allow: [...MARKER_ALLOW], defaultMode: 'bypassPermissions' } }, full: false, shape: false },
  // defaultMode rejections.
  { name: 'defaultMode wrong literal', value: { permissions: { ...validPermissions(), defaultMode: 'default' } }, full: false, shape: false },
  { name: 'defaultMode missing', value: { permissions: { allow: [...MARKER_ALLOW], deny: [...FLOOR] } }, full: false, shape: false },
  { name: 'defaultMode null', value: { permissions: { ...validPermissions(), defaultMode: null } }, full: false, shape: false },
  // permissions member rejections.
  { name: 'permissions null', value: { permissions: null }, full: false, shape: false },
  { name: 'permissions missing', value: {}, full: false, shape: false },
  { name: 'permissions string', value: { permissions: 'perms' }, full: false, shape: false },
  { name: 'permissions bare array', value: { permissions: [] }, full: false, shape: false },
  // Top-level rejections.
  { name: 'top-level null', value: null, full: false, shape: false },
  { name: 'top-level undefined', value: undefined, full: false, shape: false },
  { name: 'top-level string', value: 'settings', full: false, shape: false },
  { name: 'top-level number', value: 42, full: false, shape: false },
  { name: 'top-level boolean', value: true, full: false, shape: false },
  { name: 'top-level bare array', value: [], full: false, shape: false },
  { name: 'top-level function', value: () => undefined, full: false, shape: false },
];

describe('isValidPermissionsSettings equivalence', () => {
  for (const c of cases) {
    it(`${c.name} → full=${c.full}`, () => {
      // The table must encode exactly what the pre-conversion ladders decided.
      expect(referenceIsValidPermissionsSettings(c.value)).toBe(c.full);
      expect(isValidPermissionsSettings(c.value)).toBe(c.full);
    });
  }
});

describe('isValidPermissionsShape equivalence (observed through mergeSettingsJson)', () => {
  for (const c of cases) {
    // Falsy customs short-circuit to defaults before the shape check runs, so
    // the shape verdict is unobservable for them; the guard-level cases above
    // still cover their rejection.
    if (!c.value) continue;
    it(`${c.name} → shape=${c.shape}`, () => {
      expect(referenceIsValidPermissionsShape(c.value)).toBe(c.shape);

      const merged = mergeSettingsJson('agent', c.value as PermissionsSettings | undefined);
      expect(merged).not.toBeNull();
      if (c.shape) {
        const custom = c.value as PermissionsSettings;
        expect(merged!.permissions.allow).toEqual(custom.permissions.allow);
        expect(merged!.permissions.deny).toEqual(applyRequiredDeny(custom.permissions.deny));
        expect(merged!.permissions.defaultMode).toBe('bypassPermissions');
      } else {
        // Invalid shape falls back to the defaults template.
        expect(merged!.permissions.allow).toEqual([...AGENT_DEFAULT_ALLOW]);
        expect(merged!.permissions.deny).toEqual(applyRequiredDeny([]));
      }
    });
  }

  it('undefined custom falls back to defaults', () => {
    const merged = mergeSettingsJson('agent', undefined);
    expect(merged).not.toBeNull();
    expect(merged!.permissions.allow).toEqual([...AGENT_DEFAULT_ALLOW]);
  });

  it('valid custom keeps extra top-level keys through the merge spread', () => {
    const custom = {
      permissions: validPermissions(),
      enabledPlugins: { keep: true },
      junk: 'kept',
    } as unknown as PermissionsSettings;
    const merged = mergeSettingsJson('agent', custom);
    expect(merged).not.toBeNull();
    expect((merged as unknown as Record<string, unknown>).enabledPlugins).toEqual({ keep: true });
    expect((merged as unknown as Record<string, unknown>).junk).toBe('kept');
  });

  it('non-agent type returns null regardless of custom', () => {
    expect(mergeSettingsJson('chat', { permissions: validPermissions() } as unknown as PermissionsSettings)).toBeNull();
  });
});
