// src/transport/unsupported-operation.ts
// Shared helper for graceful capability degradation across transports.
//
// All three transport bridges (signal/twilio/imessage) declare their own
// UnsupportedTransportOperationError class — each is a copy of the same shape:
//   { name: 'UnsupportedTransportOperationError', code: 'UNSUPPORTED_TRANSPORT_OPERATION' }
// This module duck-types on those two signals so callers (MCP tools, runtime
// helpers) don't have to import all three classes or know which transport
// threw. A later cleanup phase may consolidate the three classes; this helper
// remains the canonical detection path either way.
//
// Usage in a tool handler:
//
//   try {
//     await connection.sendRaw(chatJid, payload);
//   } catch (err) {
//     if (isUnsupportedTransportOperation(err)) return unsupportedToolError('sendRaw');
//     throw err;
//   }
//
// The agent LLM receives the toolError and learns not to retry the operation
// on this transport. The error code is stable so agents / prompts can key on
// it for transport-aware behaviour.

/** True iff err is an UnsupportedTransportOperationError from any bridge. */
export function isUnsupportedTransportOperation(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err !== 'object' && typeof err !== 'function') return false;
  const e = err as { name?: unknown; code?: unknown };
  // Accept either signal — a downstream wrap might lose one.
  return e.name === 'UnsupportedTransportOperationError'
    || e.code === 'UNSUPPORTED_TRANSPORT_OPERATION';
}

/**
 * Build a stable tool-error result for an unsupported operation. The agent
 * LLM sees this as the MCP tool result and learns the transport does not
 * support the operation.
 */
export function unsupportedToolError(
  operation: string,
): { error: 'unsupported_transport'; message: string } {
  return {
    error: 'unsupported_transport',
    message: `${operation} is not supported on this transport.`,
  };
}
