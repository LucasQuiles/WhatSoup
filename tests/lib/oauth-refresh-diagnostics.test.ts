import { describe, expect, it } from 'vitest';

import {
  classifyOAuthRefreshFailureReason,
  dedupFailurePrefixes,
  formatOAuthRefreshFailure,
  OAUTH_REFRESH_FAILURE_REASONS,
  reasonLabel,
  redactLocalPaths,
} from '../../src/lib/oauth-refresh-diagnostics.ts';

describe('classifyOAuthRefreshFailureReason', () => {
  it('classifies refresh_token_reused', () => {
    expect(classifyOAuthRefreshFailureReason('The refresh token was reused')).toBe(
      'refresh_token_reused',
    );
  });

  it('classifies invalid_grant (RFC 6749)', () => {
    expect(classifyOAuthRefreshFailureReason('error: invalid_grant')).toBe('invalid_grant');
  });

  it('classifies sign_in_again', () => {
    expect(classifyOAuthRefreshFailureReason('Please sign in again')).toBe('sign_in_again');
  });

  it('classifies re-authenticate as sign_in_again', () => {
    expect(classifyOAuthRefreshFailureReason('Re-authenticate required')).toBe('sign_in_again');
  });

  it('classifies invalid_refresh_token', () => {
    expect(classifyOAuthRefreshFailureReason('invalid refresh token')).toBe(
      'invalid_refresh_token',
    );
  });

  it('classifies token_invalidated', () => {
    expect(classifyOAuthRefreshFailureReason('Token invalidated')).toBe('token_invalidated');
  });

  it('classifies revoked', () => {
    expect(classifyOAuthRefreshFailureReason('The token was revoked')).toBe('revoked');
  });

  it('returns null for unrecognized message', () => {
    expect(classifyOAuthRefreshFailureReason('something went wrong')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(classifyOAuthRefreshFailureReason('')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(classifyOAuthRefreshFailureReason('INVALID_GRANT')).toBe('invalid_grant');
    expect(classifyOAuthRefreshFailureReason('Token REVOKED')).toBe('revoked');
  });

  it('prefers specific over general (refresh_token_reused before invalid_grant)', () => {
    expect(
      classifyOAuthRefreshFailureReason('invalid_grant: refresh token reused'),
    ).toBe('refresh_token_reused');
  });
});

describe('OAUTH_REFRESH_FAILURE_REASONS', () => {
  it('contains all 6 reasons', () => {
    expect(OAUTH_REFRESH_FAILURE_REASONS).toHaveLength(6);
  });
});

describe('reasonLabel', () => {
  it('returns a label for each reason', () => {
    for (const reason of OAUTH_REFRESH_FAILURE_REASONS) {
      const label = reasonLabel(reason);
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe('redactLocalPaths', () => {
  it('redacts .lock paths', () => {
    expect(redactLocalPaths('failed to open /home/user/auth.lock')).toContain('<local-path>');
    expect(redactLocalPaths('failed to open /home/user/auth.lock')).not.toContain('/home/user');
  });

  it('redacts .token paths', () => {
    expect(redactLocalPaths('/tmp/xyz/token.token')).toBe('<local-path>');
  });

  it('redacts .credentials paths', () => {
    expect(redactLocalPaths('/var/app/credentials.creds')).toBe('<local-path>');
  });

  it('redacts .auth paths', () => {
    expect(redactLocalPaths('locked at /home/q/.config/session.auth')).toBe(
      'locked at <local-path>',
    );
  });

  it('does not touch plain text without path-like patterns', () => {
    expect(redactLocalPaths('just an error message')).toBe('just an error message');
  });

  it('handles empty string', () => {
    expect(redactLocalPaths('')).toBe('');
  });

  it('redacts multiple paths in one string', () => {
    const out = redactLocalPaths('lock1: /home/a.lock lock2: /tmp/b.lock');
    expect(out.match(/<local-path>/g)).toHaveLength(2);
  });
});

describe('dedupFailurePrefixes', () => {
  it('collapses repeated Error: prefix', () => {
    expect(dedupFailurePrefixes('Error: Error: OAuth failed')).toBe('Error: OAuth failed');
  });

  it('collapses triple prefix', () => {
    expect(dedupFailurePrefixes('Error: Error: Error: failed')).toBe('Error: failed');
  });

  it('collapses different repeated prefixes', () => {
    expect(dedupFailurePrefixes('Layer1: Layer1: something')).toBe('Layer1: something');
  });

  it('does not collapse different prefixes', () => {
    expect(dedupFailurePrefixes('Error: OAuthError: failed')).toBe('Error: OAuthError: failed');
  });

  it('handles text without prefixes', () => {
    expect(dedupFailurePrefixes('just a message')).toBe('just a message');
  });

  it('handles empty string', () => {
    expect(dedupFailurePrefixes('')).toBe('');
  });

  it('trims trailing whitespace', () => {
    expect(dedupFailurePrefixes('Error: Error: failed   ')).toBe('Error: failed');
  });
});

describe('formatOAuthRefreshFailure', () => {
  it('classifies, redacts, and hints for oauth mode', () => {
    const result = formatOAuthRefreshFailure({
      message: 'Error: Error: invalid_grant at /home/user/auth.lock',
      provider: 'anthropic',
      authMode: 'oauth',
    });
    expect(result.reason).toBe('invalid_grant');
    expect(result.message).not.toContain('Error: Error:');
    expect(result.message).not.toContain('/home/user');
    expect(result.hint).toContain('anthropic');
    expect(result.hint).toContain('Re-authenticate');
  });

  it('gives top-up hint for api_key mode', () => {
    const result = formatOAuthRefreshFailure({
      message: 'invalid_grant',
      authMode: 'api_key',
    });
    expect(result.hint).toContain('top up credits');
  });

  it('defaults authMode to oauth', () => {
    const result = formatOAuthRefreshFailure({ message: 'revoked' });
    expect(result.hint).toContain('Re-authenticate');
  });

  it('handles unrecognized reason', () => {
    const result = formatOAuthRefreshFailure({ message: 'something weird happened' });
    expect(result.reason).toBeNull();
    expect(result.hint).toContain('refresh failed');
  });

  it('handles empty message', () => {
    const result = formatOAuthRefreshFailure({ message: '' });
    expect(result.reason).toBeNull();
    expect(result.message).toBe('');
  });

  it('omits provider label when not provided', () => {
    const result = formatOAuthRefreshFailure({ message: 'invalid_grant' });
    expect(result.hint.startsWith('invalid grant')).toBe(true);
  });

  it('includes provider label when provided', () => {
    const result = formatOAuthRefreshFailure({
      message: 'invalid_grant',
      provider: 'openai',
    });
    expect(result.hint.startsWith('openai:')).toBe(true);
  });

  it('redacts lock paths in the cleaned message', () => {
    const result = formatOAuthRefreshFailure({
      message: 'failed at /tmp/session.lock',
    });
    expect(result.message).toContain('<local-path>');
    expect(result.message).not.toContain('/tmp/session.lock');
  });

  it('dedups prefixes in the cleaned message', () => {
    const result = formatOAuthRefreshFailure({
      message: 'Error: Error: Error: invalid_grant',
    });
    expect(result.message).toBe('Error: invalid_grant');
  });
});
