import { describe, expect, it } from 'vitest';
import { trustedActorApplicationContext } from '../../../src/runtimes/agent/trusted-actor-envelope.ts';

describe('trusted actor turn envelope', () => {
  it('does not emit an administrator attestation for an untrusted actor', () => {
    const prompt = trustedActorApplicationContext('untrusted_or_unknown');

    expect(prompt).toContain('actor_access=untrusted_or_unknown');
    expect(prompt).not.toContain('actor_access=administrator');
  });

  it('marks an authenticated administrator only in the server-authored envelope', () => {
    const prompt = trustedActorApplicationContext('administrator');

    expect(prompt).toContain('actor_access=administrator');
    expect(prompt).toContain('actor_role_attestation=verified_configured_administrator');
  });
});
