import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SERVICE_ENV_MAP } from '../../src/lib/provider-key-service.ts';

const PROTECTED_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MINIMAX_API_KEY',
  'ZAI_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
  'FIREWORKS_API_KEY',
  'TOGETHER_API_KEY',
  'PINECONE_API_KEY',
  'ELEVENLABS_API_KEY',
  'WHATSOUP_HEALTH_TOKEN',
] as const;

describe('deploy/whatsoup credential environment boundary', () => {
  const source = readFileSync('deploy/whatsoup', 'utf8');

  it('scrubs protected credential variables before the first subprocess', () => {
    const scrub = `unset ${PROTECTED_ENV_NAMES.join(' ')}`;
    const scrubIndex = source.indexOf(scrub);
    const firstSubprocessIndex = source.indexOf('$(');

    expect(scrubIndex).toBeGreaterThan(-1);
    expect(firstSubprocessIndex).toBeGreaterThan(-1);
    expect(scrubIndex).toBeLessThan(firstSubprocessIndex);
  });

  it('covers every mapped credential name plus supported Google aliases', () => {
    const expected = new Set([
      ...Object.values(SERVICE_ENV_MAP),
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'GEMINI_API_KEY',
    ]);

    expect(new Set(PROTECTED_ENV_NAMES)).toEqual(expected);
  });

  it('does not resolve or export protected credentials in the launcher', () => {
    expect(source).not.toContain('keyring_lookup()');
    expect(source).not.toContain('macos_keychain_lookup()');
    expect(source).not.toContain('whatsoup_read_private_health_token');

    for (const name of PROTECTED_ENV_NAMES) {
      expect(source).not.toMatch(new RegExp(`\\bexport\\s+[^\\n]*\\b${name}\\b`));
      expect(source).not.toMatch(new RegExp(`\\b${name}=\\"?\\$\\(keyring_lookup`));
    }
  });

  it('execs the runtime directly after scrubbing probe-only variables', () => {
    expect(source).toContain(
      'unset WHATSOUP_PREFLIGHT_IMPORT_ONLY WHATSOUP_PREFLIGHT_IMPORT_SENTINEL',
    );
    expect(source).toContain('exec "$NODE"');
    expect(source).toContain('"$REPO_ROOT/src/bootstrap.ts" "$INSTANCE"');
  });
});
