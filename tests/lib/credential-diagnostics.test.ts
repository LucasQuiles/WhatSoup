import { describe, it, expect } from 'vitest';

import {
  diagnoseCredential,
  credentialSummary,
  type CredentialDiagnosticResult,
} from '../../src/lib/credential-diagnostics.ts';

describe('diagnoseCredential', () => {
  it('classifies a present, non-empty value as ok', () => {
    const result = diagnoseCredential('openai', 'sk-test-key-12345');
    expect(result).toEqual<CredentialDiagnosticResult>({
      service: 'openai',
      reasonCode: 'ok',
      usable: true,
      summary: 'credential ok for openai',
    });
  });

  it('classifies null as missing_credential', () => {
    const result = diagnoseCredential('openai', null);
    expect(result.reasonCode).toBe('missing_credential');
    expect(result.usable).toBe(false);
    expect(result.service).toBe('openai');
  });

  it('classifies undefined as missing_credential', () => {
    const result = diagnoseCredential('openai', undefined);
    expect(result.reasonCode).toBe('missing_credential');
    expect(result.usable).toBe(false);
  });

  it('classifies empty string as malformed', () => {
    const result = diagnoseCredential('openai', '');
    expect(result.reasonCode).toBe('malformed');
    expect(result.usable).toBe(false);
  });

  it('classifies whitespace-only string as malformed', () => {
    const result = diagnoseCredential('openai', '   ');
    expect(result.reasonCode).toBe('malformed');
    expect(result.usable).toBe(false);
  });

  it('classifies tab/newline-only string as malformed', () => {
    const result = diagnoseCredential('anthropic', '\t\n  ');
    expect(result.reasonCode).toBe('malformed');
    expect(result.usable).toBe(false);
  });

  it('passes through the service name in the result', () => {
    const result = diagnoseCredential('pinecone', 'key-value');
    expect(result.service).toBe('pinecone');
  });

  it('summary matches credentialSummary for the same inputs', () => {
    const cases: Array<[string | null | undefined, string]> = [
      ['valid-key', 'ok'],
      [null, 'missing_credential'],
      ['', 'malformed'],
      ['  ', 'malformed'],
      [undefined, 'missing_credential'],
    ];
    for (const [value, expectedCode] of cases) {
      const result = diagnoseCredential('openai', value);
      expect(result.summary).toBe(credentialSummary('openai', result.reasonCode));
      expect(result.reasonCode).toBe(expectedCode);
    }
  });
});

describe('credentialSummary', () => {
  it('returns a human-readable summary for ok', () => {
    expect(credentialSummary('openai', 'ok')).toBe('credential ok for openai');
  });

  it('returns a human-readable summary for missing_credential', () => {
    expect(credentialSummary('openai', 'missing_credential')).toBe('no credential found for openai');
  });

  it('returns a human-readable summary for malformed', () => {
    expect(credentialSummary('openai', 'malformed')).toBe('credential for openai is empty or whitespace');
  });

  it('returns a human-readable summary for unknown_service', () => {
    expect(credentialSummary('acme', 'unknown_service')).toBe('unknown service: acme');
  });

  it('returns a human-readable summary for invalid_expires', () => {
    expect(credentialSummary('openai', 'invalid_expires')).toBe('credential for openai has invalid expiry');
  });

  it('returns a human-readable summary for expired', () => {
    expect(credentialSummary('openai', 'expired')).toBe('credential for openai has expired');
  });

  it('returns a human-readable summary for expiring', () => {
    expect(credentialSummary('openai', 'expiring')).toBe('credential for openai expires soon');
  });

  it('throws on an unhandled reason code (exhaustive guard)', () => {
    // Cast to bypass the type system — simulates a future code added without
    // updating the switch.
    expect(() => credentialSummary('openai', 'future_code' as never)).toThrow(
      /unhandled credential reason code/,
    );
  });
});
