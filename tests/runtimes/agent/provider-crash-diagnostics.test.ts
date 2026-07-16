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

  it('redacts dynamic OpenCode permission patterns and classifies unattended rejection', () => {
    const privatePattern = '/workspace/private/.config/opencode/credentials.json';
    const text = sanitizeProviderCrashText(
      `permission requested: ${privatePattern}; auto-rejecting`,
    );

    expect(text).toBe(
      'permission requested: [REDACTED_PERMISSION_PATTERN]; auto-rejecting',
    );
    expect(text).not.toContain(privatePattern);
    expect(text).not.toContain('/workspace/private');
    expect(classifyProviderCrash(text)).toBe('provider_permission_denied');
  });

  it('redacts an OpenCode permission pattern before a split auto-reject suffix arrives', () => {
    const privatePattern = '/workspace/private/.config/opencode/credentials.json';
    const preview1 = appendProviderCrashPreview(
      '',
      `permission requested: ${privatePattern}`,
    );

    expect(preview1).toBe('permission requested: [REDACTED_PERMISSION_PATTERN]');
    expect(preview1).not.toContain(privatePattern);

    const preview2 = appendProviderCrashPreview(preview1, '; auto-rejecting');
    expect(preview2).toBe(
      'permission requested: [REDACTED_PERMISSION_PATTERN]; auto-rejecting',
    );
    expect(classifyProviderCrash(preview2)).toBe('provider_permission_denied');
  });

  it('QR-112: redacts a secret that straddles a stderr chunk boundary', () => {
    // Anthropic-style key; split so the FIRST chunk holds only `sk-a` (too short
    // to match the >=12-char token rule) and the SECOND chunk completes it. The
    // per-chunk sanitizer misses both halves; the stored preview is what the
    // direct-log sinks (session.ts / claude.ts 'claude stderr') emit, so the
    // fix must keep that stored buffer redacted.
    const suffix = 'ABCDEFGHIJKLMNOP1234';
    const fullSecret = `sk-ant-api03-${suffix}`;
    const chunk1 = 'auth error: invalid api key sk-a';
    const chunk2 = `nt-api03-${suffix} (exiting)`;
    expect(chunk1 + chunk2).toContain(fullSecret); // sanity: the split reconstructs the secret

    const preview1 = appendProviderCrashPreview('', chunk1);
    const preview2 = appendProviderCrashPreview(preview1, chunk2);

    // The completed secret must be redacted in the stored buffer (= what sinks log).
    expect(preview2).toContain('[REDACTED_TOKEN]');
    expect(preview2).not.toContain(fullSecret);
    expect(preview2).not.toContain(suffix);
    // Non-secret context is preserved.
    expect(preview2).toContain('auth error: invalid api key');
    expect(preview2).toContain('(exiting)');
    // The intermediate preview never held the full secret either.
    expect(preview1).not.toContain(fullSecret);
  });

  it('QR-112: still caps the accumulated preview at maxLength', () => {
    let preview = '';
    for (let i = 0; i < 50; i++) preview = appendProviderCrashPreview(preview, 'x'.repeat(100), 200);
    expect(preview.length).toBeLessThanOrEqual(200);
  });

  it.each([
    ['Please run /login before using provider CLI', 'provider_auth_required'],
    ['Invalid API key provided', 'provider_auth_required'],
    ['OAuth token expired; reconnect the provider account.', 'provider_auth_required'],
    // 401 bodies surfaced on the crash/stderr path (parity with
    // isProviderAuthRequiredMessage on the result-text path, #1368): a provider
    // CLI that prints these and exits non-zero must still demote to fallback.
    ['Failed to authenticate. API Error: 401', 'provider_auth_required'],
    ['Invalid authentication credentials', 'provider_auth_required'],
    ['Session limit reached until 5pm', 'provider_usage_limit'],
    ['429 Too Many Requests', 'provider_rate_limit'],
    ['spawn claude ENOENT', 'provider_binary_missing'],
    ['Permission denied opening credential cache', 'provider_permission_denied'],
    ['ECONNRESET while reading stream', 'provider_network_error'],
    ['Gateway timeout from provider', 'provider_timeout'],
    ['Internal server error 500', 'provider_server_error'],
    // 5xx with HTTP-ish context: these are real provider server errors.
    ['request failed with status: 503', 'provider_server_error'],
    ['request failed with status code 502', 'provider_server_error'],
    ['HTTP 502 from upstream', 'provider_server_error'],
    ['provider returned error 500', 'provider_server_error'],
  ])('classifies %s as %s', (text, crashClass) => {
    expect(classifyProviderCrash(text)).toBe(crashClass);
  });

  it.each([
    // Bare 5xx-looking numbers WITHOUT HTTP-ish context must not classify as
    // provider_server_error: this crashClass keys heal single-flight, so a
    // false positive suppresses healing of genuinely distinct crashes.
    ['TypeError: x is undefined at line 503 of foo.ts'],
    ['request took 550 ms before crashing'],
    ['request took 550ms before crashing'],
  ])('does NOT classify %s as provider_server_error', (text) => {
    expect(classifyProviderCrash(text)).not.toBe('provider_server_error');
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
