import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_PROBE_DESCRIPTORS,
  credentialProbeServices,
  type CredentialProbeDescriptor,
} from '../../src/lib/provider-credential-probes.ts';

describe('provider-credential-probes', () => {
  describe('CREDENTIAL_PROBE_DESCRIPTORS', () => {
    it('is a non-empty mapping', () => {
      expect(Object.keys(CREDENTIAL_PROBE_DESCRIPTORS).length).toBeGreaterThan(0);
    });

    it('contains anthropic probe', () => {
      expect(CREDENTIAL_PROBE_DESCRIPTORS.anthropic).toBeDefined();
    });

    it('contains deepseek probe', () => {
      expect(CREDENTIAL_PROBE_DESCRIPTORS.deepseek).toBeDefined();
    });

    it('contains minimax probe', () => {
      expect(CREDENTIAL_PROBE_DESCRIPTORS.minimax).toBeDefined();
    });

    it('contains openai probe', () => {
      expect(CREDENTIAL_PROBE_DESCRIPTORS.openai).toBeDefined();
    });

    it('each descriptor has required fields', () => {
      for (const [service, descriptor] of Object.entries(CREDENTIAL_PROBE_DESCRIPTORS)) {
        expect(descriptor.url, `${service} missing url`).toBeDefined();
        expect(descriptor.method, `${service} missing method`).toBeDefined();
        expect(descriptor.auth, `${service} missing auth`).toBeDefined();
      }
    });

    it('each descriptor has a valid URL', () => {
      for (const [service, descriptor] of Object.entries(CREDENTIAL_PROBE_DESCRIPTORS)) {
        expect(() => new URL(descriptor.url), `${service} has invalid URL`).not.toThrow();
      }
    });

    it('each descriptor has a valid method', () => {
      for (const descriptor of Object.values(CREDENTIAL_PROBE_DESCRIPTORS)) {
        expect(['GET', 'POST']).toContain(descriptor.method);
      }
    });

    it('each descriptor has a valid auth scheme', () => {
      for (const descriptor of Object.values(CREDENTIAL_PROBE_DESCRIPTORS)) {
        expect(['bearer', 'x-api-key']).toContain(descriptor.auth);
      }
    });

    it('anthropic probe has anthropic-version header', () => {
      const anthropic = CREDENTIAL_PROBE_DESCRIPTORS.anthropic;
      expect(anthropic.extraHeaders).toBeDefined();
      expect(anthropic.extraHeaders?.['anthropic-version']).toBe('2023-06-01');
    });

    it('deepseek probe uses bearer auth', () => {
      expect(CREDENTIAL_PROBE_DESCRIPTORS.deepseek.auth).toBe('bearer');
    });

    it('openai probe uses bearer auth', () => {
      expect(CREDENTIAL_PROBE_DESCRIPTORS.openai.auth).toBe('bearer');
    });

    it('does not include body for GET requests', () => {
      for (const descriptor of Object.values(CREDENTIAL_PROBE_DESCRIPTORS)) {
        if (descriptor.method === 'GET') {
          expect(descriptor.body).toBeUndefined();
        }
      }
    });

    it('anthropic probe targets the correct endpoint', () => {
      expect(CREDENTIAL_PROBE_DESCRIPTORS.anthropic.url).toBe('https://api.anthropic.com/v1/models');
    });

    it('openai probe targets the correct endpoint', () => {
      expect(CREDENTIAL_PROBE_DESCRIPTORS.openai.url).toBe('https://api.openai.com/v1/models');
    });
  });

  describe('credentialProbeServices', () => {
    it('returns a non-empty array', () => {
      const services = credentialProbeServices();
      expect(Array.isArray(services)).toBe(true);
      expect(services.length).toBeGreaterThan(0);
    });

    it('returns all service names from the descriptor map', () => {
      const services = credentialProbeServices();
      const expected = Object.keys(CREDENTIAL_PROBE_DESCRIPTORS);
      expect(new Set(services)).toEqual(new Set(expected));
    });

    it('returns services in sorted order', () => {
      const services = credentialProbeServices();
      const sorted = [...services].sort();
      expect(services).toEqual(sorted);
    });

    it('includes anthropic, deepseek, minimax, and openai', () => {
      const services = credentialProbeServices();
      expect(services).toContain('anthropic');
      expect(services).toContain('deepseek');
      expect(services).toContain('minimax');
      expect(services).toContain('openai');
    });

    it('each returned service has a matching descriptor', () => {
      for (const service of credentialProbeServices()) {
        expect(CREDENTIAL_PROBE_DESCRIPTORS[service]).toBeDefined();
      }
    });
  });
});
