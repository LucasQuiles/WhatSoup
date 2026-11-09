export const TRANSPORT_AUTHORITY_URL_REQUIREMENT =
  'must use HTTPS or literal loopback HTTP (127.0.0.1 or [::1]) and cannot include credentials, query, or fragment';

const LITERAL_LOOPBACK_HTTP_URL = /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i;

/**
 * Parse an authority endpoint that can receive a protected-service bearer.
 * HTTP is permitted only when the original configuration spelled a literal
 * loopback address, avoiding DNS resolution and non-canonical loopback forms.
 */
export function parseTransportAuthorityUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (parsed.username !== ''
      || parsed.password !== ''
      || value.includes('?')
      || value.includes('#')) return null;
    if (parsed.protocol === 'https:') return parsed;
    if (parsed.protocol !== 'http:') return null;
    if (!LITERAL_LOOPBACK_HTTP_URL.test(value)) return null;
    return parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' ? parsed : null;
  } catch {
    return null;
  }
}
