import { describe, expect, it } from 'vitest';
import { parseProtectedDeliveryConfig } from '../../src/core/protected-delivery-config.ts';
import {
  TEST_DELIVERY_BASE_URL,
  TEST_DELIVERY_HOST,
  TEST_PROTECTED_DELIVERY_PINS as pins,
} from '../helpers/protected-delivery-pins.ts';

const credential = { LINKS_MANAGED_TRANSPORT_TOKEN: 'token-from-environment' };
const withBaseUrl = (baseUrl: string) => ({ enabled: true, baseUrl, credentialEnv: 'LINKS_MANAGED_TRANSPORT_TOKEN' });

describe('protected delivery configuration', () => {
  it('is disabled without an explicit configuration object', () => {
    expect(parseProtectedDeliveryConfig(undefined, {}, pins)).toBeNull();
    expect(parseProtectedDeliveryConfig({ enabled: false }, {}, pins)).toBeNull();
  });

  it('requires an HTTPS endpoint and a credential selected outside the tool schema', () => {
    expect(parseProtectedDeliveryConfig(withBaseUrl(TEST_DELIVERY_BASE_URL), credential, pins)).toMatchObject({
      baseUrl: TEST_DELIVERY_BASE_URL,
      token: 'token-from-environment',
    });
    expect(() => parseProtectedDeliveryConfig(withBaseUrl('http://links.invalid'), credential, pins)).toThrow(/HTTPS/);
    expect(() => parseProtectedDeliveryConfig(withBaseUrl('https://links.invalid'), {}, pins)).toThrow(/approved/i);
    expect(() => parseProtectedDeliveryConfig(withBaseUrl(TEST_DELIVERY_BASE_URL), {}, pins)).toThrow(/credential/i);
  });

  it('accepts the pinned origin only in its normalized spellings with the fixed API path', () => {
    for (const baseUrl of [
      `https://${TEST_DELIVERY_HOST.toUpperCase()}/s/api/v1`,
      `https://${TEST_DELIVERY_HOST}:443/s/api/v1/`,
    ]) {
      expect(parseProtectedDeliveryConfig(withBaseUrl(baseUrl), credential, pins)).toMatchObject({
        baseUrl: TEST_DELIVERY_BASE_URL,
      });
    }
  });

  it('refuses lookalike origins, other ports and other API paths', () => {
    for (const baseUrl of [
      `https://evil${TEST_DELIVERY_HOST}/s/api/v1`,
      `https://${TEST_DELIVERY_HOST}.evil.invalid/s/api/v1`,
      `https://${TEST_DELIVERY_HOST}:8443/s/api/v1`,
      `https://${TEST_DELIVERY_HOST}./s/api/v1`,
      `https://www.${TEST_DELIVERY_HOST}/s/api/v1`,
      `https://links.example.test/s/api/v1`,
      `https://${TEST_DELIVERY_HOST}/s/api/v2`,
      `https://${TEST_DELIVERY_HOST}/`,
    ]) {
      expect(() => parseProtectedDeliveryConfig(withBaseUrl(baseUrl), credential, pins)).toThrow(/approved/i);
    }
  });

  it('refuses the test origin under the production pins', () => {
    expect(() => parseProtectedDeliveryConfig(withBaseUrl(TEST_DELIVERY_BASE_URL), credential)).toThrow(/approved/i);
  });

  it('rejects ambient and child-environment names for the managed credential', () => {
    for (const credentialEnv of ['LANG', 'PATH', 'OPENAI_API_KEY', 'WHATSOUP_MCP_SESSION_TOKEN']) {
      expect(() => parseProtectedDeliveryConfig({
        enabled: true,
        baseUrl: TEST_DELIVERY_BASE_URL,
        credentialEnv,
      }, { [credentialEnv]: 'synthetic-managed-token' }, pins)).toThrow(/reserved managed credential namespace/i);
    }
  });
});
