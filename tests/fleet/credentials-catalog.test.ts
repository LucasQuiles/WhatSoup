// tests/fleet/credentials-catalog.test.ts
import { describe, it, expect } from 'vitest';
import { buildProviderCatalog, PROVIDER_VERIFY_DESCRIPTORS } from '../../src/fleet/routes/providers.ts';
import { CREDENTIAL_ALLOWLIST, CREDENTIAL_WRITE_BLOCKLIST } from '../../src/fleet/routes/credentials.ts';

describe('catalog ↔ credential allowlist cross-check (SSOT drift guard)', () => {
  it('every catalog credentialService is allowlisted and not blocklisted', () => {
    const services = buildProviderCatalog()
      .map((e) => e.credentialService)
      .filter((s): s is string => s !== null);
    expect(services.length).toBeGreaterThan(0);
    const violations = services.filter(
      (s) => !CREDENTIAL_ALLOWLIST.has(s) || CREDENTIAL_WRITE_BLOCKLIST.has(s),
    );
    expect(violations).toEqual([]);
  });

  it('every verify descriptor is an https literal with a typed auth scheme', () => {
    const entries = Object.entries(PROVIDER_VERIFY_DESCRIPTORS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [service, d] of entries) {
      expect(CREDENTIAL_ALLOWLIST.has(service), `${service} must be allowlisted`).toBe(true);
      expect(d.url.startsWith('https://'), `${service} verify URL must be https`).toBe(true);
      expect(['bearer', 'x-api-key']).toContain(d.auth);
    }
  });
});
