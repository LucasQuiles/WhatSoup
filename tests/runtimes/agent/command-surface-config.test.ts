/**
 * Unit tests for resolveCommandSurface() — W1-T9b, the ONE pure overlay
 * function that resolves platform catalog (T1) x instance policy x
 * per-sender prefs (T9a) into an EffectiveCommandSurface.
 *
 * Covers the acceptance set from W1-PACKET.md §W1-T9 T9b verbatim:
 *  - narrow-only hiding (instance-allowed command hidden by user -> off)
 *  - no widening (user hidden naming an instance-disabled command stays off)
 *  - immutability proof: gate/venue/visibility are structurally immune to
 *    cast-in adversarial instance/user configs, for EVERY catalog command
 *  - purity: same inputs -> deep-equal output, no db/clock/config read
 *  - instance-disable with no user prefs (including user === null)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { COMMAND_REGISTRY, type CommandSpec } from '../../../src/runtimes/agent/command-registry.ts';
import {
  resolveCommandSurface,
  type InstanceCommandSurfaceConfig,
  type EffectiveCommandSurface,
} from '../../../src/runtimes/agent/command-surface-config.ts';
import type { UserSurfacePrefs } from '../../../src/runtimes/agent/command-surface-prefs-db.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCE_PATH = join(REPO_ROOT, 'src/runtimes/agent/command-surface-config.ts');

// A small synthetic fixture catalog (not the real registry) for the narrow
// unit tests below, so those tests stay independent of T1 registry content
// drift. The immutability proof separately runs against the REAL
// COMMAND_REGISTRY to prove the guarantee for every shipped command.
const FIXTURE_CATALOG: readonly CommandSpec[] = [
  {
    name: 'status',
    summary: 'show status',
    syntax: '/status',
    tier: 'transport-local',
    gate: 'none',
    venue: 'any',
    visibility: 'end-user',
    errorClasses: ['internal'],
  },
  {
    name: 'kill-session',
    summary: 'kill a session',
    syntax: '/kill-session [N]',
    tier: 'transport-local',
    gate: 'admin',
    venue: 'dm',
    visibility: 'operator',
    errorClasses: ['not-authorized', 'internal'],
  },
  {
    name: 'help',
    summary: 'show help',
    syntax: '/help',
    tier: 'transport-local',
    gate: 'none',
    venue: 'any',
    visibility: 'end-user',
    errorClasses: ['internal'],
  },
];

describe('resolveCommandSurface — narrowing semantics', () => {
  it('user hides an instance-allowed command -> that command is disabled', () => {
    const instance: InstanceCommandSurfaceConfig = {};
    const user: UserSurfacePrefs = { hidden: ['status'] };
    const result = resolveCommandSurface(FIXTURE_CATALOG, instance, user);
    const status = result.commands.find((c) => c.name === 'status');
    expect(status?.enabled).toBe(false);
  });

  it('a command not named in hidden stays enabled (instance allows it, user has no opinion)', () => {
    const instance: InstanceCommandSurfaceConfig = {};
    const user: UserSurfacePrefs = { hidden: ['status'] };
    const result = resolveCommandSurface(FIXTURE_CATALOG, instance, user);
    const help = result.commands.find((c) => c.name === 'help');
    expect(help?.enabled).toBe(true);
  });

  it('user hidden names a command the instance already DISABLED -> stays disabled (AND, no widening)', () => {
    const instance: InstanceCommandSurfaceConfig = { disabled: ['kill-session'] };
    // The user's hidden list does NOT include kill-session — if resolve()
    // let a user's ABSENCE-of-hide widen past instance policy, this would
    // wrongly re-enable it. It must not.
    const user: UserSurfacePrefs = { hidden: ['status'] };
    const result = resolveCommandSurface(FIXTURE_CATALOG, instance, user);
    const kill = result.commands.find((c) => c.name === 'kill-session');
    expect(kill?.enabled).toBe(false);
  });

  it('instance disables a command + user has no prefs at all (null) -> stays disabled', () => {
    const instance: InstanceCommandSurfaceConfig = { disabled: ['kill-session'] };
    const result = resolveCommandSurface(FIXTURE_CATALOG, instance, null);
    const kill = result.commands.find((c) => c.name === 'kill-session');
    expect(kill?.enabled).toBe(false);
    // Everything else the instance didn't disable remains enabled with no
    // user layer applied at all.
    const status = result.commands.find((c) => c.name === 'status');
    expect(status?.enabled).toBe(true);
  });

  it('user === null -> instance policy alone applies, no throw, defaults kick in', () => {
    const instance: InstanceCommandSurfaceConfig = { defaultVerbosity: 'terse' };
    const result = resolveCommandSurface(FIXTURE_CATALOG, instance, null);
    expect(result.locale).toBeUndefined();
    for (const cmd of result.commands) {
      expect(cmd.verbosity).toBe('terse');
    }
  });
});

describe('resolveCommandSurface — case-insensitive name matching', () => {
  // Command classification lowercases the command name before lookup
  // (commands.ts classifyInput: `parts[0].toLowerCase()`), so surface
  // policy must match catalog names case-insensitively too — otherwise
  // disabled:['Status'] silently no-ops while /Status still classifies
  // as the status command.
  it("instance disabled:['Status'] disables the catalog 'status' command", () => {
    const instance: InstanceCommandSurfaceConfig = { disabled: ['Status'] };
    const result = resolveCommandSurface(FIXTURE_CATALOG, instance, null);
    const status = result.commands.find((c) => c.name === 'status');
    expect(status?.enabled).toBe(false);
  });

  it("user hidden:['STATUS'] hides the catalog 'status' command", () => {
    const user: UserSurfacePrefs = { hidden: ['STATUS'] };
    const result = resolveCommandSurface(FIXTURE_CATALOG, {}, user);
    const status = result.commands.find((c) => c.name === 'status');
    expect(status?.enabled).toBe(false);
  });

  it('mixed-case entries never disable a DIFFERENT command (only the case-folded match)', () => {
    const instance: InstanceCommandSurfaceConfig = { disabled: ['Kill-Session'] };
    const result = resolveCommandSurface(FIXTURE_CATALOG, instance, null);
    expect(result.commands.find((c) => c.name === 'kill-session')?.enabled).toBe(false);
    expect(result.commands.find((c) => c.name === 'status')?.enabled).toBe(true);
    expect(result.commands.find((c) => c.name === 'help')?.enabled).toBe(true);
  });
});

describe('resolveCommandSurface — no widening mechanism exists for the user layer', () => {
  it('a user object cast-in with an adversarial "enabled" widening field is ignored (no such field is read)', () => {
    const instance: InstanceCommandSurfaceConfig = { disabled: ['kill-session'] };
    // UserSurfacePrefs has NO enable/widen field — cast in an adversarial
    // object that tries to smuggle one anyway.
    const adversarialUser = { enabled: ['kill-session'], hidden: [] } as unknown as UserSurfacePrefs;
    const result = resolveCommandSurface(FIXTURE_CATALOG, instance, adversarialUser);
    const kill = result.commands.find((c) => c.name === 'kill-session');
    expect(kill?.enabled).toBe(false);
  });
});

describe('resolveCommandSurface — verbosity + optionDefaults resolution', () => {
  it('user verbosity overrides instance defaultVerbosity', () => {
    const instance: InstanceCommandSurfaceConfig = { defaultVerbosity: 'normal' };
    const user: UserSurfacePrefs = { verbosity: 'terse' };
    const result = resolveCommandSurface(FIXTURE_CATALOG, instance, user);
    expect(result.commands.every((c) => c.verbosity === 'terse')).toBe(true);
  });

  it('falls back to instance defaultVerbosity when user has no preference', () => {
    const instance: InstanceCommandSurfaceConfig = { defaultVerbosity: 'terse' };
    const result = resolveCommandSurface(FIXTURE_CATALOG, instance, {});
    expect(result.commands.every((c) => c.verbosity === 'terse')).toBe(true);
  });

  it('falls back to "normal" when neither layer sets verbosity', () => {
    const result = resolveCommandSurface(FIXTURE_CATALOG, {}, null);
    expect(result.commands.every((c) => c.verbosity === 'normal')).toBe(true);
  });

  it('optionDefaults merge per-command: user keys override instance keys for the same option', () => {
    const instance: InstanceCommandSurfaceConfig = {
      optionDefaults: { status: { format: 'short', color: 'green' } },
    };
    const user: UserSurfacePrefs = {
      optionDefaults: { status: { format: 'long' } },
    };
    const result = resolveCommandSurface(FIXTURE_CATALOG, instance, user);
    const status = result.commands.find((c) => c.name === 'status');
    expect(status?.optionDefaults).toEqual({ format: 'long', color: 'green' });
  });

  it('a command with no optionDefaults in either layer resolves to an empty object', () => {
    const result = resolveCommandSurface(FIXTURE_CATALOG, {}, null);
    const help = result.commands.find((c) => c.name === 'help');
    expect(help?.optionDefaults).toEqual({});
  });

  it('locale passes through from user prefs; undefined when user is null', () => {
    const withLocale = resolveCommandSurface(FIXTURE_CATALOG, {}, { locale: 'pt-BR' });
    expect(withLocale.locale).toBe('pt-BR');
    const withoutUser = resolveCommandSurface(FIXTURE_CATALOG, {}, null);
    expect(withoutUser.locale).toBeUndefined();
  });
});

describe('resolveCommandSurface — immutability proof (security axes, EVERY catalog command)', () => {
  it('gate/venue/visibility resolve to the catalog values for every real COMMAND_REGISTRY entry, regardless of adversarial cast-in instance/user configs', () => {
    // Neither InstanceCommandSurfaceConfig nor UserSurfacePrefs HAS a gate,
    // venue, or visibility field — so this cast is the only way to even
    // attempt smuggling one in, proving the guarantee is structural (the
    // real function body never reads `.gate`/`.venue`/`.visibility` off
    // either layer) rather than merely "nobody happened to test it". The
    // sentinel values below ('PWNED-INSTANCE'/'PWNED-USER') deliberately do
    // NOT collide with any real CommandGate/CommandVenue/CommandVisibility
    // value, so a bug that read the axis off either injected layer (instead
    // of the catalog) would be caught on EVERY command — not just on the
    // subset whose catalog values happen to coincidentally match a plausible
    // adversarial guess.
    const adversarialInstance = {
      disabled: [],
      gate: 'PWNED-INSTANCE-GATE',
      venue: 'PWNED-INSTANCE-VENUE',
      visibility: 'PWNED-INSTANCE-VISIBILITY',
    } as unknown as InstanceCommandSurfaceConfig;
    const adversarialUser = {
      hidden: [],
      gate: 'PWNED-USER-GATE',
      venue: 'PWNED-USER-VENUE',
      visibility: 'PWNED-USER-VISIBILITY',
    } as unknown as UserSurfacePrefs;

    const result = resolveCommandSurface(COMMAND_REGISTRY, adversarialInstance, adversarialUser);

    expect(result.commands).toHaveLength(COMMAND_REGISTRY.length);
    for (const spec of COMMAND_REGISTRY) {
      const resolved = result.commands.find((c) => c.name === spec.name);
      expect(resolved).toBeDefined();
      expect(resolved?.gate).toBe(spec.gate);
      expect(resolved?.venue).toBe(spec.venue);
      expect(resolved?.visibility).toBe(spec.visibility);
    }
  });

  it('the same proof holds when instance/user are entirely absent (null user, empty instance)', () => {
    const result = resolveCommandSurface(COMMAND_REGISTRY, {}, null);
    for (const spec of COMMAND_REGISTRY) {
      const resolved = result.commands.find((c) => c.name === spec.name);
      expect(resolved?.gate).toBe(spec.gate);
      expect(resolved?.venue).toBe(spec.venue);
      expect(resolved?.visibility).toBe(spec.visibility);
    }
  });
});

describe('resolveCommandSurface — purity', () => {
  it('same inputs called twice produce deep-equal (but independently constructed) output', () => {
    const instance: InstanceCommandSurfaceConfig = { disabled: ['kill-session'], defaultVerbosity: 'terse' };
    const user: UserSurfacePrefs = { hidden: ['status'], locale: 'en-GB' };
    const a: EffectiveCommandSurface = resolveCommandSurface(FIXTURE_CATALOG, instance, user);
    const b: EffectiveCommandSurface = resolveCommandSurface(FIXTURE_CATALOG, instance, user);
    expect(a).toEqual(b);
    expect(a).not.toBe(b); // fresh object each call — not memoized/cached state
  });

  it('is unaffected by call order / repetition (no internal accumulating state)', () => {
    const instance: InstanceCommandSurfaceConfig = { disabled: ['status'] };
    resolveCommandSurface(FIXTURE_CATALOG, instance, null);
    resolveCommandSurface(FIXTURE_CATALOG, instance, { hidden: ['help'] });
    const third = resolveCommandSurface(FIXTURE_CATALOG, instance, null);
    // Third call with the same args as the first must match the first,
    // proving the intervening differently-shaped call left no residue.
    const first = resolveCommandSurface(FIXTURE_CATALOG, instance, null);
    expect(third).toEqual(first);
  });

  it('does not mutate its inputs', () => {
    const instance: InstanceCommandSurfaceConfig = { disabled: ['status'], optionDefaults: { status: { a: '1' } } };
    const user: UserSurfacePrefs = { hidden: ['help'], optionDefaults: { status: { b: '2' } } };
    const instanceSnapshot = JSON.parse(JSON.stringify(instance));
    const userSnapshot = JSON.parse(JSON.stringify(user));
    resolveCommandSurface(FIXTURE_CATALOG, instance, user);
    expect(instance).toEqual(instanceSnapshot);
    expect(user).toEqual(userSnapshot);
  });

  it('source contains no db/clock/config/filesystem/network reads (static grep evidence for N13)', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    const forbidden = [
      'Date.now(',
      'new Date(',
      'readFileSync(',
      'require(',
      'fetch(',
      'db.raw',
      'process.env',
      'await ',
      'async ',
    ];
    for (const token of forbidden) {
      expect(source, `resolveCommandSurface source must not contain "${token}"`).not.toContain(token);
    }
  });
});
