import type { AlertPayload, DeliveryResult, Sink } from './types.ts';

export interface ChainResult {
  deliveries: DeliveryResult[];
  failedAll: boolean;
}

export async function runChannelChain(sinks: Sink[], payload: AlertPayload): Promise<ChainResult> {
  const deliveries: DeliveryResult[] = [];
  let realSuccess = false;

  for (const sink of sinks) {
    const result = await safeDeliver(sink, payload);
    deliveries.push(result);
    if (result.ok && !sink.isDurableLog) {
      realSuccess = true;
      break;
    }
  }

  return { deliveries, failedAll: !realSuccess };
}

async function safeDeliver(sink: Sink, payload: AlertPayload): Promise<DeliveryResult> {
  try {
    return await sink.deliver(payload);
  } catch (error) {
    return {
      ok: false,
      channel: sink.name,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
