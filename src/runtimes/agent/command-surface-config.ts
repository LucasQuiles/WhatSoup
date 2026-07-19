// src/runtimes/agent/command-surface-config.ts
//
// W1-T9b: the command-surface-config OVERLAY. `resolveCommandSurface` is ONE
// pure function that resolves the effective per-sender command surface from
// three injected layers — platform catalog (T1), instance policy
// (config.json 'commandSurface' block), and per-sender prefs (T9a's
// PrefsStore) — with no I/O of its own (N13: db/clock/config are the
// CALLER's job to read and inject, never this function's).
//
// STRUCTURAL SECURITY (spec §R3c, not runtime-checked): the security axes
// (gate/venue/visibility) are ABSENT from both InstanceCommandSurfaceConfig
// and UserSurfacePrefs — they exist only on CommandSpec (the T1 catalog) —
// so there is no field for either layer to carry them through, by
// construction. Likewise UserSurfacePrefs has no "enable" field, so a user
// can only narrow (hide) what the instance already allows, never widen past
// it: `enabled = instanceEnabled && !userHidden` is an AND, not an OR.

import type { CommandSpec, CommandGate, CommandVenue, CommandVisibility } from './command-registry.ts';
import type { UserSurfacePrefs } from './command-surface-prefs-db.ts';

/**
 * Instance-level policy (config.json 'commandSurface' block, validated by
 * agent-config-validator.ts). May DISABLE commands and set cosmetic
 * defaults; may NOT touch the security axes — they simply aren't fields on
 * this shape.
 */
export interface InstanceCommandSurfaceConfig {
  readonly disabled?: readonly string[];
  readonly defaultVerbosity?: 'terse' | 'normal';
  readonly optionDefaults?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface EffectiveCommand {
  readonly name: string;
  readonly enabled: boolean;
  readonly gate: CommandGate; // from catalog — immutable
  readonly venue: CommandVenue | undefined; // from catalog — immutable
  readonly visibility: CommandVisibility; // from catalog — immutable
  readonly verbosity: 'terse' | 'normal';
  readonly optionDefaults: Readonly<Record<string, string>>;
}

export interface EffectiveCommandSurface {
  readonly commands: readonly EffectiveCommand[];
  readonly locale: string | undefined;
}

/**
 * THE pure resolve(). No I/O — the three layers are injected by the caller
 * (runtime/handler side, out of scope for T9a/T9b). Same inputs always
 * produce a deep-equal output; calling it twice with identical arguments
 * never observes a difference (no hidden clock/db/singleton reads inside).
 */
export function resolveCommandSurface(
  catalog: readonly CommandSpec[],
  instance: InstanceCommandSurfaceConfig,
  user: UserSurfacePrefs | null,
): EffectiveCommandSurface {
  // Case-insensitive name matching: classification lowercases command names
  // (commands.ts classifyInput), so policy lists must case-fold too —
  // otherwise disabled:['Status'] would silently no-op against the
  // lowercase catalog name 'status'.
  const disabledLower = new Set((instance.disabled ?? []).map((n) => n.toLowerCase()));
  const hiddenLower = new Set((user?.hidden ?? []).map((n) => n.toLowerCase()));
  const commands = catalog.map((spec): EffectiveCommand => {
    const specNameLower = spec.name.toLowerCase();
    const instanceEnabled = !disabledLower.has(specNameLower);
    const userHidden = hiddenLower.has(specNameLower);
    return {
      name: spec.name,
      enabled: instanceEnabled && !userHidden, // AND: user narrows only, never widens
      gate: spec.gate, // straight from catalog — never user/instance-set
      venue: spec.venue,
      visibility: spec.visibility,
      verbosity: user?.verbosity ?? instance.defaultVerbosity ?? 'normal',
      optionDefaults: { ...(instance.optionDefaults?.[spec.name] ?? {}), ...(user?.optionDefaults?.[spec.name] ?? {}) },
    };
  });
  return { commands, locale: user?.locale };
}
