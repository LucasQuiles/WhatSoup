import { createHash } from 'node:crypto';

/**
 * The outbound_ops.payload_hash of a payload string. DurabilityEngine.createOutboundOp
 * stores this value, so any code that matches ops by payload hash must use it too.
 */
export function outboundPayloadHash(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

/** The payload string the outbound queue and sendTracked write for a text op. */
export function textOpPayload(text: string): string {
  return JSON.stringify({ text });
}
