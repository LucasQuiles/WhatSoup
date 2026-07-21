import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const PROTECTED_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'PINECONE_API_KEY',
  'ELEVENLABS_API_KEY',
  'WHATSOUP_HEALTH_TOKEN',
] as const;

// Ported from the credential-hardening series (2bde84ace) and ADAPTED:
// the original asserted the launcher performs NO credential resolution at all.
// Main has since grown a deliberate post-scrub resolution architecture the
// fleet depends on (instance-scoped health-token file/keyring flow, chat API
// keys), so the enforced boundary here is ORDERING, not absence: inherited
// environment values are scrubbed before the first subprocess and before any
// resolution, making the launcher's own keyring/file resolution the single
// supplier of these variables.
describe('deploy/whatsoup credential environment boundary', () => {
  const source = readFileSync('deploy/whatsoup', 'utf8');
  const scrub = `unset ${PROTECTED_ENV_NAMES.join(' ')}`;
  const scrubIndex = source.indexOf(scrub);

  it('scrubs inherited credential variables before the first subprocess', () => {
    const firstSubprocessIndex = source.indexOf('$(');

    expect(scrubIndex).toBeGreaterThan(-1);
    expect(firstSubprocessIndex).toBeGreaterThan(-1);
    expect(scrubIndex).toBeLessThan(firstSubprocessIndex);
  });

  it('scrubs before any deliberate credential resolution, so inherited values cannot shadow it', () => {
    const firstKeyringCall = source.indexOf('$(keyring_lookup');
    const firstHealthTokenRead = source.indexOf('whatsoup_read_private_health_token');

    expect(firstKeyringCall).toBeGreaterThan(-1);
    expect(scrubIndex).toBeLessThan(firstKeyringCall);
    expect(firstHealthTokenRead).toBeGreaterThan(-1);
    expect(scrubIndex).toBeLessThan(firstHealthTokenRead);
  });

  it('execs the runtime directly after scrubbing probe-only variables', () => {
    expect(source).toContain(
      'unset WHATSOUP_PREFLIGHT_IMPORT_ONLY WHATSOUP_PREFLIGHT_IMPORT_SENTINEL',
    );
    expect(source).toContain('exec "$NODE"');
    expect(source).toContain('"$REPO_ROOT/src/bootstrap.ts" "$INSTANCE"');
  });
});
