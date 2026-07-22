import { describe, expect, it } from 'vitest';
import { isSignalTcpHost, SIGNAL_TCP_HOST_LABEL } from '../../src/lib/signal-endpoint.ts';

describe('Signal plaintext TCP host policy', () => {
  it.each(['127.0.0.1', '::1', 'localhost'])('accepts the canonical host %s', (host) => {
    expect(isSignalTcpHost(host)).toBe(true);
    expect(SIGNAL_TCP_HOST_LABEL).toContain(host);
  });

  it.each(['127.0.0.2', '127.255.255.255', '[::1]', 'LOCALHOST', '', 42, null])(
    'rejects an unsupported host %s',
    (host) => {
      expect(isSignalTcpHost(host)).toBe(false);
    },
  );
});
