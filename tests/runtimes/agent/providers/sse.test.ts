import { describe, expect, it } from 'vitest';
import { readSseDataLines } from '../../../../src/runtimes/agent/providers/sse.ts';

const enc = new TextEncoder();

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(enc.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const results: string[] = [];
  for await (const line of readSseDataLines(stream)) {
    results.push(line);
  }
  return results;
}

describe('readSseDataLines', () => {
  it('parses two standard data: lines', async () => {
    const stream = makeStream(['data: hello\ndata: world\n']);
    expect(await collect(stream)).toEqual(['hello', 'world']);
  });

  it('flushes a trailing line that has no final newline (EOF flush)', async () => {
    const stream = makeStream(['data: first\ndata: last']);
    expect(await collect(stream)).toEqual(['first', 'last']);
  });

  it('strips carriage returns from CRLF line terminators', async () => {
    const stream = makeStream(['data: alpha\r\ndata: beta\r\n']);
    expect(await collect(stream)).toEqual(['alpha', 'beta']);
  });

  it('reassembles a single data: line split across two chunks', async () => {
    const stream = makeStream(['data: par', 'tial\n']);
    expect(await collect(stream)).toEqual(['partial']);
  });

  it('ignores non-data SSE fields (event:, id:, retry:, : comments)', async () => {
    const stream = makeStream([
      'event: ping\nid: 42\nretry: 3000\n: this is a comment\ndata: payload\n',
    ]);
    expect(await collect(stream)).toEqual(['payload']);
  });
});
