/**
 * Iterate Server-Sent Event `data:` lines from a fetch response body.
 *
 * Provider APIs often omit the final trailing newline. Keep the parser line
 * oriented, but flush the decoder and remaining buffer at EOF so the final
 * frame is not lost.
 */
export async function* readSseDataLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const drainLines = function* (chunk: string, flush: boolean): Generator<string> {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = flush ? '' : lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith('data: ')) {
        yield line.slice(6).trim();
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* drainLines(decoder.decode(value, { stream: true }), false);
    }

    yield* drainLines(decoder.decode(), true);

    if (buffer.length > 0) {
      const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      if (line.startsWith('data: ')) {
        yield line.slice(6).trim();
      }
      buffer = '';
    }
  } finally {
    reader.releaseLock();
  }
}
