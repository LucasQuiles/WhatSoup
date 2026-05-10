export interface TransportHealthInput {
  engineAlive: boolean;
  deliveriesSucceeded: number;
  deliveriesFailed: number;
  driftEvents: number;
}

export interface TransportHealthResult {
  broken: boolean;
  reason?: string;
}

export function detectTransportBroken(input: TransportHealthInput): TransportHealthResult {
  if (!input.engineAlive) {
    return { broken: false, reason: 'engine not alive - separate problem' };
  }

  if (input.driftEvents === 0) {
    return { broken: false, reason: 'no drift required delivery' };
  }

  if (input.deliveriesSucceeded > 0) {
    return { broken: false, reason: 'successful delivery observed' };
  }

  if (input.deliveriesFailed === 0) {
    return { broken: false, reason: 'drift observed without delivery attempts' };
  }

  return { broken: true, reason: 'drift accumulating with zero successful deliveries' };
}
