import type { EventEmitter } from 'node:events';

export interface PostConnectRecoveryOptions {
  connectionManager: Pick<EventEmitter, 'once'>;
  recover: () => void | Promise<void>;
  historySyncTimeoutMs?: number;
  echoGraceMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForHistorySyncThenRecover({
  connectionManager,
  recover,
  historySyncTimeoutMs = 15_000,
  echoGraceMs = 10_000,
}: PostConnectRecoveryOptions): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve) => connectionManager.once('historySyncComplete', resolve)),
    delay(historySyncTimeoutMs),
  ]);
  await delay(echoGraceMs);
  await recover();
}
