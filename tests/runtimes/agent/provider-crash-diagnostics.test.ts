import { describe, expect, it } from 'vitest';

import {
  appendProviderCrashPreview,
  buildProviderCrashMetadata,
  classifyProviderCrash,
  sanitizeProviderCrashText,
} from '../../../src/runtimes/agent/provider-crash-diagnostics.ts';

describe('provider crash diagnostics', () => {
  it('redacts common secrets and account identifiers from crash text', () => {
    const email = `lucas${'@'}example.com`;
    const secretValue = 'abcdefghijklmnopqrstuvwxyz';
    const text = sanitizeProviderCrashText(
      [
        `user ${email}`,
        `Bearer ${secretValue}`,
        `api_key=${secretValue}`,
        `refresh_token=${secretValue}`,
      ].join('\n'),
    );

    expect(text).toContain('[REDACTED_EMAIL]');
    expect(text).toContain('Bearer [REDACTED]');
    expect(text).toContain('api_key=[REDACTED]');
    expect(text).toContain('refresh_token=[REDACTED]');
    expect(text).not.toContain(email);
    expect(text).not.toContain(secretValue);
  });

  it.each([
    ['Please run /login before using provider CLI', 'provider_auth_required'],
    ['Invalid API key provided', 'provider_auth_required'],
    ['Session limit reached until 5pm', 'provider_usage_limit'],
    ['429 Too Many Requests', 'provider_rate_limit'],
    ['spawn claude ENOENT', 'provider_binary_missing'],
    ['Permission denied opening credential cache', 'provider_permission_denied'],
    ['ECONNRESET while reading stream', 'provider_network_error'],
    ['Gateway timeout from provider', 'provider_timeout'],
    ['Internal server error 500', 'provider_server_error'],
  ])('classifies %s as %s', (text, crashClass) => {
    expect(classifyProviderCrash(text)).toBe(crashClass);
  });

  it('keeps the newest bounded stderr preview', () => {
    const preview = appendProviderCrashPreview('old', `new-${'x'.repeat(20)}`, 10);
    expect(preview).toBe('xxxxxxxxxx');
  });

  it('builds metadata from classified preview before falling back', () => {
    expect(buildProviderCrashMetadata({
      provider: 'claude-cli',
      existingPreview: 'Invalid API key provided',
      fallbackClass: 'spawn_error',
    })).toMatchObject({
      provider: 'claude-cli',
      crashClass: 'provider_auth_required',
      stderrPreview: 'Invalid API key provided',
    });
  });
});
