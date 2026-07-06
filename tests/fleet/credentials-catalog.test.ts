// tests/fleet/credentials-catalog.test.ts
import { describe, it, expect } from 'vitest';
import { buildProviderCatalog, PROVIDER_VERIFY_DESCRIPTORS } from '../../src/fleet/routes/providers.ts';
import { CREDENTIAL_ALLOWLIST, CREDENTIAL_WRITE_BLOCKLIST } from '../../src/fleet/routes/credentials.ts';
import { CREDENTIAL_PROBE_DESCRIPTORS } from '../../src/lib/provider-credential-probes.ts';
import { SERVICE_ENV_MAP } from '../../src/lib/provider-key-service.ts';

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

describe('CREDENTIAL_PROBE_DESCRIPTORS invariants (SSRF / key-leak / drift guard)', () => {
  it('every descriptor key is a known SERVICE_ENV_MAP service', () => {
    const services = Object.keys(CREDENTIAL_PROBE_DESCRIPTORS);
    expect(services.length).toBeGreaterThan(0);
    for (const service of services) {
      expect(Object.keys(SERVICE_ENV_MAP), `${service} must be a known keyring service`).toContain(service);
    }
  });

  it('every url is a plain https host+path literal — no query string, credentials, or interpolation artifact', () => {
    for (const [service, d] of Object.entries(CREDENTIAL_PROBE_DESCRIPTORS)) {
      expect(d.url, `${service} url must be an https literal with no query/auth/interpolation`).toMatch(
        /^https:\/\/[a-z0-9.-]+\/[a-z0-9/_.-]*$/,
      );
    }
  });

  it('every descriptor declares an explicit method and a typed auth scheme', () => {
    for (const [service, d] of Object.entries(CREDENTIAL_PROBE_DESCRIPTORS)) {
      expect(['GET', 'POST'], `${service} method must be explicit`).toContain(d.method);
      expect(['bearer', 'x-api-key'], `${service} auth must be a typed scheme`).toContain(d.auth);
    }
  });

  it('anthropic is the only descriptor carrying the anthropic-version header', () => {
    for (const [service, d] of Object.entries(CREDENTIAL_PROBE_DESCRIPTORS)) {
      if (service === 'anthropic') {
        expect(d.extraHeaders).toEqual({ 'anthropic-version': '2023-06-01' });
      } else {
        expect(d.extraHeaders, `${service} should not carry extraHeaders`).toBeUndefined();
      }
    }
  });
});
