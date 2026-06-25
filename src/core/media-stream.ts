import type { OutboundMedia } from './types.ts';

/** Tear down an OutboundMedia's stream after a failed send; no-op when no stream. */
export function destroyOutboundMediaStream(media: OutboundMedia): void {
  if (media.stream === undefined) return;
  media.stream.on('error', () => {});
  media.stream.destroy();
}
