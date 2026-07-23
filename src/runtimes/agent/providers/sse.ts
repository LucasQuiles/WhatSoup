/**
 * Iterate Server-Sent Event `data:` lines from a fetch response body.
 *
 * Provider APIs often omit the final trailing newline. Keep the parser line
 * oriented, but flush the decoder and remaining buffer at EOF so the final
 * frame is not lost.
 */
/**
 * QR-064: hard cap on the retained partial-line buffer. A compromised or
 * malfunctioning provider can stream one unterminated `data:` line (no `\n`),
 * which would otherwise grow `buffer` without bound → parent-process OOM.
 * Mirrors the subprocess-stdout cap in session.ts (1 MiB). A line legitimately
 * larger than this never occurs under the SSE event contract; exceeding it is
 * abusive, so we abort the stream — the throw propagates to the managed-loop
 * caller's crash/degrade path (session.ts) rather than buffering unbounded.
 */
const MAX_SSE_BUF = 1024 * 1024;

export interface SseDataFrame {
  readonly data: string;
  readonly rawData: string;
  readonly eventName?: string;
}

export interface SseReadObserver {
  /** Observe the exact bytes received from the wire before decoding/filtering. */
  readonly onWireBytes?: (byteLength: number) => void;
  /** Observe any non-empty physical line that the legacy data-only parser discards. */
  readonly onUnexpectedLine?: () => void;
}

export async function* readSseDataFrames(
  body: ReadableStream<Uint8Array>,
  observer?: SseReadObserver,
): AsyncGenerator<SseDataFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  let pendingEventName: string | undefined;

  const drainLines = function* (chunk: string, flush: boolean): Generator<SseDataFrame> {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = flush ? '' : lines.pop() ?? '';

    // Abort an unbounded no-newline line before it exhausts memory. Checked on
    // the RETAINED partial line (`buffer`) so many small newline-terminated
    // frames — which never retain more than the last partial — are unaffected.
    if (buffer.length > MAX_SSE_BUF) {
      throw new Error(
        `SSE data line exceeded ${MAX_SSE_BUF} bytes without a newline — aborting unbounded buffer`,
      );
    }

    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith('data: ')) {
        const rawData = line.slice(6);
        const eventName = pendingEventName;
        pendingEventName = undefined;
        yield { data: rawData.trim(), rawData, ...(eventName ? { eventName } : {}) };
      } else if (line.startsWith('event: ')) {
        const eventName = line.slice(7);
        if (pendingEventName !== undefined || !/^[a-z][a-z0-9_]*$/u.test(eventName)) {
          observer?.onUnexpectedLine?.();
          pendingEventName = undefined;
        } else {
          pendingEventName = eventName;
        }
      } else if (line.length === 0) {
        if (pendingEventName !== undefined) {
          observer?.onUnexpectedLine?.();
          pendingEventName = undefined;
        }
      } else if (line.length > 0) {
        observer?.onUnexpectedLine?.();
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      observer?.onWireBytes?.(value.byteLength);
      yield* drainLines(decoder.decode(value, { stream: true }), false);
    }

    // Flush at EOF: drainLines(flush=true) keeps every split segment (it does
    // not pop the last partial line), so a final `data:` frame that arrived
    // without a trailing newline is emitted here. `buffer` is always '' after
    // a flush drain, so no further leftover-buffer handling is reachable.
    yield* drainLines(decoder.decode(), true);
    if (pendingEventName !== undefined) {
      observer?.onUnexpectedLine?.();
      pendingEventName = undefined;
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

export async function* readSseDataLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  for await (const frame of readSseDataFrames(body)) {
    yield frame.data;
  }
}
