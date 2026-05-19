export function shutdownExitCode(signal: string): 0 | 1 {
  return signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1;
}
