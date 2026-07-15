import { describe, expect, it } from 'vitest';

import {
  formatProviderErrorForUser,
  formatThrownErrorForUser,
} from '../../src/lib/provider-errors.ts';

describe('formatProviderErrorForUser', () => {
  describe('empty / null input', () => {
    it('returns a default message for undefined', () => {
      expect(formatProviderErrorForUser(undefined)).toBe(
        'Request failed with an unknown error.',
      );
    });

    it('returns a default message for empty string', () => {
      expect(formatProviderErrorForUser('')).toBe(
        'Request failed with an unknown error.',
      );
    });

    it('returns a default message for whitespace-only string', () => {
      expect(formatProviderErrorForUser('   \n\t  ')).toBe(
        'Request failed with an unknown error.',
      );
    });
  });

  describe('malformed streaming fragment', () => {
    it('detects the sentinel and returns a clean message', () => {
      expect(formatProviderErrorForUser('malformed_streaming_fragment')).toBe(
        'The streaming response contained a malformed fragment. Please try again.',
      );
    });
  });

  describe('generic provider internal error', () => {
    it('detects OpenAI-style internal error with request ID', () => {
      const raw =
        'An error occurred while processing your request. request_id: req_abc123def456';
      expect(formatProviderErrorForUser(raw)).toBe(
        'The AI service returned an internal error. Please try again in a moment.',
      );
    });

    it('detects OpenAI-style internal error with help URL', () => {
      const raw =
        'An error occurred while processing your request. Please visit help.openai.com.';
      expect(formatProviderErrorForUser(raw)).toBe(
        'The AI service returned an internal error. Please try again in a moment.',
      );
    });

    it('does NOT trigger on similar but non-matching text', () => {
      const raw = 'An error occurred while processing something else entirely';
      expect(formatProviderErrorForUser(raw)).toBe(raw);
    });
  });

  describe('Cloudflare / HTML error pages', () => {
    it('detects HTML error page with Cloudflare hint', () => {
      const raw = '<!doctype html><html><body>cloudflare error 502 bad gateway</body></html>';
      const result = formatProviderErrorForUser(raw);
      expect(result).toContain('HTML error page');
      expect(result).toContain('CDN or gateway');
    });

    it('detects HTTP 521 Cloudflare error code', () => {
      const raw = '521 <!doctype html><html>cloudflare</html>';
      const result = formatProviderErrorForUser(raw);
      expect(result).toContain('temporarily unavailable');
      expect(result).toContain('521');
    });

    it('detects bare Cloudflare 524 status without HTML', () => {
      const raw = '524 <!doctype html><html></html>';
      const result = formatProviderErrorForUser(raw);
      expect(result).toContain('temporarily unavailable');
      expect(result).toContain('524');
    });

    it('does NOT trigger on normal 4xx with HTML', () => {
      const raw = '404 <!doctype html><html>not found</html>';
      // 404 < 500, so this should not be treated as a Cloudflare error.
      // It falls through to HTTP status prefix formatting.
      const result = formatProviderErrorForUser(raw);
      expect(result).toContain('404');
    });
  });

  describe('HTTP status prefix', () => {
    it('formats "429 Too Many Requests: rate exceeded"', () => {
      expect(formatProviderErrorForUser('429 Too Many Requests: rate exceeded')).toBe(
        'HTTP 429: Too Many Requests: rate exceeded',
      );
    });

    it('formats "HTTP 503 Service Unavailable"', () => {
      expect(formatProviderErrorForUser('HTTP 503 Service Unavailable')).toBe(
        'HTTP 503: Service Unavailable',
      );
    });

    it('does NOT treat JSON body as a plain HTTP prefix', () => {
      const raw = '429 {"error":{"type":"rate_limit_exceeded","message":"slow down"}}';
      // The JSON path should be triggered, not the plain HTTP path.
      const result = formatProviderErrorForUser(raw);
      expect(result).toContain('rate_limit_exceeded');
      expect(result).toContain('slow down');
    });
  });

  describe('JSON error payloads', () => {
    it('parses nested OpenAI-style error object', () => {
      const raw = JSON.stringify({
        error: {
          type: 'rate_limit_exceeded',
          message: 'You exceeded your current quota.',
        },
      });
      expect(formatProviderErrorForUser(raw)).toBe(
        'API error rate_limit_exceeded: You exceeded your current quota.',
      );
    });

    it('parses nested error object with HTTP prefix', () => {
      const raw = '429 {"error":{"type":"rate_limit_exceeded","message":"slow down"}}';
      expect(formatProviderErrorForUser(raw)).toBe(
        'HTTP 429 rate_limit_exceeded: slow down',
      );
    });

    it('parses Anthropic-style error object', () => {
      const raw = JSON.stringify({
        type: 'error',
        error: {
          type: 'overloaded_error',
          message: 'Overloaded',
        },
      });
      expect(formatProviderErrorForUser(raw)).toBe(
        'API error overloaded_error: Overloaded',
      );
    });

    it('parses flat error payload with code field', () => {
      const raw = JSON.stringify({
        error: { code: 'insufficient_balance' },
        message: 'Your balance is too low.',
      });
      expect(formatProviderErrorForUser(raw)).toBe(
        'API error insufficient_balance: Your balance is too low.',
      );
    });

    it('parses flat error payload (error as string + message)', () => {
      const raw = JSON.stringify({
        error: 'insufficient_balance',
        message: 'Your balance is too low.',
      });
      expect(formatProviderErrorForUser(raw)).toBe(
        'API error insufficient_balance: Your balance is too low.',
      );
    });

    it('strips "Error:" prefix before JSON', () => {
      const raw = 'Error: {"error":{"type":"bad_request","message":"invalid model"}}';
      expect(formatProviderErrorForUser(raw)).toBe(
        'API error bad_request: invalid model',
      );
    });

    it('strips "api error:" prefix before JSON', () => {
      const raw = 'api error: {"error":{"type":"server_error","message":"oops"}}';
      expect(formatProviderErrorForUser(raw)).toBe(
        'API error server_error: oops',
      );
    });

    it('ignores non-error JSON (no error/type/request_id fields)', () => {
      const raw = JSON.stringify({ foo: 'bar', baz: 42 });
      // Should fall through to raw text (which is valid JSON but not an error).
      expect(formatProviderErrorForUser(raw)).toBe(raw);
    });
  });

  describe('plain text passthrough', () => {
    it('returns short plain text as-is', () => {
      const raw = 'Connection timeout';
      expect(formatProviderErrorForUser(raw)).toBe(raw);
    });

    it('truncates very long text with ellipsis', () => {
      const raw = 'x'.repeat(800);
      const result = formatProviderErrorForUser(raw);
      expect(result.length).toBeLessThanOrEqual(601); // 600 + ellipsis
      expect(result.endsWith('…')).toBe(true);
    });

    it('truncates at 600 chars exactly (boundary)', () => {
      const raw = 'x'.repeat(600);
      expect(formatProviderErrorForUser(raw)).toBe(raw);
    });

    it('does NOT truncate text at 599 chars', () => {
      const raw = 'x'.repeat(599);
      expect(formatProviderErrorForUser(raw)).toBe(raw);
      expect(formatProviderErrorForUser(raw).endsWith('…')).toBe(false);
    });
  });
});

describe('formatThrownErrorForUser', () => {
  it('formats an Error object', () => {
    const err = new Error('429 Too Many Requests: slow down');
    expect(formatThrownErrorForUser(err)).toBe(
      'HTTP 429: Too Many Requests: slow down',
    );
  });

  it('formats a string thrown value', () => {
    expect(formatThrownErrorForUser('something broke')).toBe('something broke');
  });

  it('formats an object thrown value', () => {
    expect(formatThrownErrorForUser({ code: 500 })).toBe('[object Object]');
  });

  it('formats null', () => {
    expect(formatThrownErrorForUser(null)).toBe(
      'Request failed with an unknown error.',
    );
  });

  it('formats undefined', () => {
    expect(formatThrownErrorForUser(undefined)).toBe(
      'Request failed with an unknown error.',
    );
  });

  it('formats a JSON error payload from an Error message', () => {
    const err = new Error('{"error":{"type":"rate_limit","message":"too fast"}}');
    expect(formatThrownErrorForUser(err)).toBe(
      'API error rate_limit: too fast',
    );
  });
});
