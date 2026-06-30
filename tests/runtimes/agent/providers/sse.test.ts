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

describe('sse.ts EOF trailing-frame flush', () => {
  it('flushes a trailing data: frame left without a final newline', async () => {
    // Final chunk carries a `data: ` line with no trailing newline, exercising
    // the EOF flush path (drainLines flush=true keeps the trailing segment).
    const stream = makeStream(['data: trailing']);
    expect(await collect(stream)).toEqual(['trailing']);
  });

  it('does not flush a trailing frame that is not a data: line', async () => {
    // Final chunk carries a non-data field with no trailing newline; the EOF
    // flush must drop it rather than yield it.
    const stream = makeStream(['event: no-data-here']);
    expect(await collect(stream)).toEqual([]);
  });
});

describe('sse.ts unbounded-buffer cap (QR-064)', () => {
  // A compromised/malfunctioning provider streaming one unterminated `data:`
  // line (no '\n') grows the parser's partial-line buffer unbounded → OOM. The
  // parser must abort once the un-newlined buffer exceeds MAX_SSE_BUF, mirroring
  // the subprocess-stdout cap in session.ts.
  const OVER = 1024 * 1024 + 1; // > MAX_SSE_BUF (1 MiB)

  it('throws when a single no-newline line exceeds the cap', async () => {
    const stream = makeStream([`data: ${'A'.repeat(OVER)}`]);
    await expect(collect(stream)).rejects.toThrow(/SSE|buffer|exceed/i);
  });

  it('throws when a no-newline line accumulates past the cap across chunks', async () => {
    const half = 'A'.repeat(600 * 1024); // two chunks, no newline → ~1.2 MiB
    const stream = makeStream([`data: ${half}`, half]);
    await expect(collect(stream)).rejects.toThrow(/SSE|buffer|exceed/i);
  });

  it('ALLOWS a large but under-cap newline-terminated line', async () => {
    const big = 'A'.repeat(1024 * 1024 - 1024); // < cap, then a newline flushes it
    const stream = makeStream([`data: ${big}\n`]);
    expect(await collect(stream)).toEqual([big]);
  });

  it('ALLOWS many small lines whose TOTAL exceeds the cap (per-line buffer stays small)', async () => {
    // 200k lines of `data: x\n` ≈ 1.4 MiB total, but each is flushed on its
    // newline so the retained buffer never approaches the cap → no throw.
    const n = 200_000;
    const stream = makeStream(['data: x\n'.repeat(n)]);
    const out = await collect(stream);
    expect(out.length).toBe(n);
    expect(out[0]).toBe('x');
  });
});
