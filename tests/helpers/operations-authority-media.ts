import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OperationsAuthorityClient } from '../../src/transport/operations-authority-client.ts';
import { renderTransportReviewCard } from '../../src/transport/operations-authority-gate.ts';

export const mediaInbound = {
  eventId: 'media-review', sender: '15551230000@s.whatsapp.net',
  conversation: '15551230000@s.whatsapp.net', receivedAt: '2026-11-02T14:30:00.000Z',
  text: '/review media-operation',
};
export const mediaOperation = {
  id: 'media-operation', account_id: 'pilot-account', action: 'whatsapp.send',
  digest: 'a'.repeat(64), state: 'pending',
};
export const mediaReview = (operation: Record<string, unknown>) => ({
  kind: 'review', review: {
    challenge: 'media-challenge', items: [{ id: 'media-operation', digest: 'a'.repeat(64) }],
    previews: [operation], expires_at: '2026-11-02T15:00:00.000Z',
    desk_url: 'https://untrusted.example/agent-controlled',
  },
});

export async function legacyMediaReview(size: number) {
  const binary = Buffer.alloc(size, 109).toString('base64');
  const body = mediaReview({
    ...mediaOperation, payload: { recipient: '15551230000@s.whatsapp.net', content: { document: { $binary: binary } } },
  });
  const client = new OperationsAuthorityClient({
    baseUrl: 'https://authority.example/',
    accountId: 'pilot-account',
    bearerToken: 'test-only-transport-token',
    fetch: async () => new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  });
  const result = await client.registerInbound(mediaInbound);
  assert.equal(result.kind, 'review');
  if (result.kind !== 'review') throw new Error('expected a review');
  const payload = result.review.previews[0]!.payload;
  const received = (payload.content as { document: { $binary: string } }).document.$binary;
  assert.ok(received === binary, 'authority response must retain the complete media payload');
  Object.defineProperty(payload, 'toJSON', {
    value: () => { throw new Error('raw media must never be serialized into a human review card'); },
  });
  return {
    kind: result.kind,
    card: renderTransportReviewCard(result.review),
    binaryPrefix: binary.slice(0, 20),
    mediaBytes: Buffer.byteLength(received, 'base64'),
  };
}

// The capacity case uses native Node so coverage does not instrument every byte
// of a 50 MiB payload. The small case executes this same path inside Vitest.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await legacyMediaReview(50 * 1024 * 1024)));
}
