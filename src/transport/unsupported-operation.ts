/**
 * Canonical `UnsupportedTransportOperationError` for non-WhatsApp transports.
 *
 * #2202: this class was declared three times — once each in
 * `transport/{imessage,signal,twilio}/connection-bridge.ts`. The declarations
 * were not byte-identical (each message names its own transport, and Signal's
 * omits the trailing sentence), but `code`, `name`, and the constructor shape
 * were duplicated verbatim in all three. Those are the parts that drift: a
 * change to the `code` string in one bridge would silently diverge from the
 * other two, and nothing would fail.
 *
 * The per-transport wording is preserved rather than unified. It is
 * operator-facing text that names the bridge and the transport, and collapsing
 * it into one generic sentence would lose information at the point where
 * someone is reading a thrown error.
 */
export class UnsupportedTransportOperationError extends Error {
  readonly code = 'UNSUPPORTED_TRANSPORT_OPERATION';

  /**
   * @param bridge    Bridge class name, e.g. `SignalConnection` — appears in brackets.
   * @param transport Human transport label, e.g. `iMessage`, `Signal`, `SMS`.
   * @param operation The unsupported operation, e.g. `sendMedia`.
   * @param detail    Optional trailing sentence. Signal deliberately has none.
   */
  constructor(bridge: string, transport: string, operation: string, detail?: string) {
    super(
      `[${bridge}] "${operation}" is not supported on the ${transport} transport`
      + (detail ? `. ${detail}` : ''),
    );
    this.name = 'UnsupportedTransportOperationError';
  }
}

/** Trailing sentence shared by the transports that have one. */
export const REQUIRES_WHATSAPP_DETAIL = 'This operation requires a WhatsApp connection.';
