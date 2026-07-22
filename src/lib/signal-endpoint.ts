export const SIGNAL_TCP_HOST_LABEL = '127.0.0.1, ::1, or localhost';

const SIGNAL_TCP_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);

export function isSignalTcpHost(value: unknown): value is string {
  return typeof value === 'string' && SIGNAL_TCP_HOSTS.has(value);
}
