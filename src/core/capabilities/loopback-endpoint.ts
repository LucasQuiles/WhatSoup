const LOOPBACK_ROOT = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$/i;

export function parseLoopbackCapabilityOrigin(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || value.includes('?')
    || value.includes('#')
    || !LOOPBACK_ROOT.test(value)
  ) {
    return null;
  }

  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return null;
  }

  const hostname = endpoint.hostname.toLowerCase();
  const loopbackHost = hostname === '127.0.0.1'
    || hostname === 'localhost'
    || hostname === '::1'
    || hostname === '[::1]';
  if (
    endpoint.protocol !== 'http:'
    || endpoint.username !== ''
    || endpoint.password !== ''
    || endpoint.pathname !== '/'
    || endpoint.search !== ''
    || endpoint.hash !== ''
    || !loopbackHost
  ) {
    return null;
  }

  return endpoint.origin;
}

export function isLoopbackCapabilityEndpoint(value: unknown): boolean {
  return parseLoopbackCapabilityOrigin(value) !== null;
}
