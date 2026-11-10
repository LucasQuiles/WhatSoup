import { outboundPayloadHash, textOpPayload } from './outbound-payload-hash.ts';

/** The user-facing notice for a stalled-tool kill: a failure notice, never task fulfilment. */
export const STALLED_OPERATION_NOTICE = '_A tool call stalled and was terminated. Send your message again to retry._';

/**
 * Closed registry of agent failure notices. Only exact constants belong here:
 * a templated notice has no fixed payload hash and cannot be proven by one.
 */
export const AGENT_FAILURE_NOTICES: readonly string[] = Object.freeze([
  STALLED_OPERATION_NOTICE,
]);

/** outbound_ops.payload_hash of each registered notice sent as a text op. */
export const AGENT_FAILURE_NOTICE_PAYLOAD_HASHES: ReadonlySet<string> = new Set(
  AGENT_FAILURE_NOTICES.map((notice) => outboundPayloadHash(textOpPayload(notice))),
);
