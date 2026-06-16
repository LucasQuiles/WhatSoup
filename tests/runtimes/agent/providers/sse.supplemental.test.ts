// Supplemental coverage for readSseDataLines.
//
// INTENDED REPO PATH: tests/runtimes/agent/providers/sse.test.ts
//   (MERGE these `it()` blocks into the existing describe('readSseDataLines')
//    — do NOT create a second file; the existing file already covers the 8
//    branches from the prior plan: two data: lines, CRLF strip, `data: `
//    prefix, fragment-split-across-chunks, trailing-no-newline, non-data
//    field skip.)
//
// COVERAGE FINDING (important): the only remaining UNCOVERED region in
// src/runtimes/agent/providers/sse.ts is lines 37-43 — the post-flush
//   `if (buffer.length > 0) { ... }`
// block. This block is UNREACHABLE DEAD CODE under the current
// implementation and CANNOT be legitimately covered:
//
//   - The EOF path always calls `drainLines(decoder.decode(), true)` with
//     flush=true (line 35).
//   - `drainLines` with flush=true unconditionally executes `buffer = ''`
//     (line 18: `buffer = flush ? '' : lines.pop() ?? ''`).
//   - Therefore after line 35, `buffer` is ALWAYS `''`, so `buffer.length`
//     at line 37 is ALWAYS 0 and the block body (38-42) never runs.
//
// This was verified empirically, including the worst case (a multi-byte
// UTF-8 character split across two chunks): the completed character is
// emitted by the flush call at line 35, never via the line-37 block.
//
// RECOMMENDATION: annotate src/runtimes/agent/providers/sse.ts lines 37-43
// with `/* v8 ignore start */ ... /* v8 ignore stop */` (or delete the dead
// block — the trailing-no-newline case it appears to guard is already
// handled by the flush at line 35). Do NOT fake-cover it. The two tests
// below are BEHAVIORAL proofs that the trailing-no-newline frame is emitted
// by the flush path (not by the dead block), which is what justifies the
// v8-ignore annotation.

import { describe, expect, it } from 'vitest';
import { readSseDataLines } from '../../../../src/runtimes/agent/providers/sse.ts';

const enc = new TextEncoder();

function makeRawStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const results: string[] = [];
  for await (const line of readSseDataLines(stream)) results.push(line);
  return results;
}

describe('readSseDataLines (supplemental: EOF flush behavior)', () => {
  it('emits a multi-byte char that is split across two chunks (decoder stream flush)', async () => {
    // "data: café" — the é is two UTF-8 bytes; split the stream mid-character
    // so the decoder must complete it on the final flush (line 35), NOT via
    // the dead line-37 buffer block.
    const full = enc.encode('data: café');
    const stream = makeRawStream([full.slice(0, full.length - 1), full.slice(full.length - 1)]);
    expect(await collect(stream)).toEqual(['café']);
  });

  it('emits a single data: frame with no trailing newline via the flush path', async () => {
    // Single frame, no '\n' at all. Proves the final frame survives EOF even
    // when it never ends with a newline — handled by drainLines(..., true).
    const stream = makeRawStream([enc.encode('data: only-frame')]);
    expect(await collect(stream)).toEqual(['only-frame']);
  });

  it('yields the trimmed value for a data: frame padded with surrounding spaces', async () => {
    // Exercises the `.trim()` on the yielded payload (line 23 / 40 equivalent).
    const stream = makeRawStream([enc.encode('data:    spaced-out   \n')]);
    // Note: prefix is `data: ` (6 chars incl. one space); slice(6).trim()
    // removes the remaining leading/trailing whitespace.
    expect(await collect(stream)).toEqual(['spaced-out']);
  });
});
