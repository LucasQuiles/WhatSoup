/**
 * Provider ID registry — single source of truth for the 6 supported provider
 * identifiers. Closes #447: previously every consumer site (validator, session
 * switches, console catalog) hardcoded its own copy of the ID list and could
 * drift silently. An unknown provider would fall through `default:` branches
 * in session.ts and alias to Claude semantics — a silent-corruption hazard.
 *
 * This test file pins the registry contract: the exported `PROVIDER_IDS`
 * array, the `isProviderId` type guard, and the discriminated-union shape.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PROVIDER_IDS,
  isProviderId,
  type ProviderId,
} from '../../../../src/runtimes/agent/providers/index.ts';

describe('Provider ID registry (#447)', () => {
  it('exposes the 6 canonical provider IDs as a frozen array', () => {
    expect(PROVIDER_IDS).toEqual([
      'claude-cli',
      'codex-cli',
      'gemini-cli',
      'opencode-cli',
      'openai-api',
      'anthropic-api',
    ]);
    expect(Object.isFrozen(PROVIDER_IDS)).toBe(true);
  });

  it('isProviderId returns true for every canonical ID', () => {
    for (const id of PROVIDER_IDS) {
      expect(isProviderId(id)).toBe(true);
    }
  });

  it('isProviderId returns false for unknown / mistyped IDs', () => {
    expect(isProviderId('claude')).toBe(false);
    expect(isProviderId('Claude-CLI')).toBe(false); // case-sensitive
    expect(isProviderId('claude_cli')).toBe(false); // wrong separator
    expect(isProviderId('gemini-api')).toBe(false); // doesn't exist
    expect(isProviderId('')).toBe(false);
    expect(isProviderId(null)).toBe(false);
    expect(isProviderId(undefined)).toBe(false);
    expect(isProviderId(42)).toBe(false);
    expect(isProviderId({})).toBe(false);
  });

  it('narrows the type via the guard', () => {
    const candidate: unknown = 'codex-cli';
    if (isProviderId(candidate)) {
      // Compile-time check: candidate is now ProviderId.
      const id: ProviderId = candidate;
      expect(id).toBe('codex-cli');
    } else {
      throw new Error('guard should have accepted "codex-cli"');
    }
  });

  it('every implementation file under providers/ has a registry entry', () => {
    // Anti-drift: if someone adds anthropic-api.ts or openai-api.ts (or a new
    // *-parser.ts mapping to a new provider) we want a single grep target.
    // This test pins the relationship between the impl files and PROVIDER_IDS.
    const dir = resolve(import.meta.dirname, '../../../../src/runtimes/agent/providers');
    const files = readdirSync(dir);

    // Each canonical ID must correspond to an impl file (api wrapper OR parser).
    // claude-cli is the exception: it runs through the session.ts default path
    // and has no dedicated file under providers/ (its unreachable class wrapper
    // was removed — QR-072), so it maps to null here.
    const idToFilePatterns: Record<ProviderId, RegExp[] | null> = {
      'claude-cli': null,
      'codex-cli': [/^codex-parser\.ts$/],
      'gemini-cli': [/^gemini-acp-parser\.ts$/],
      'opencode-cli': [/^opencode-parser\.ts$/],
      'openai-api': [/^openai-api\.ts$/],
      'anthropic-api': [/^anthropic-api\.ts$/],
    };

    for (const id of PROVIDER_IDS) {
      const patterns = idToFilePatterns[id];
      if (patterns === null) continue;
      const matched = patterns.some((p) => files.some((f) => p.test(f)));
      expect(matched, `expected an impl file for provider "${id}"`).toBe(true);
    }
  });
});
