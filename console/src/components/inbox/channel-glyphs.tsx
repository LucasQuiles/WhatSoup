/**
 * channel-glyphs — shape-glyph per channel (11-channel-glyphography §1:
 * 16px legibility floor, no hue coding; the avatar badge runs 12px per the
 * inbox mockup). Path data traces 1:1 to mockups/inbox.html.
 * Local to the inbox surface — the fleet surface owns its own transport
 * identity map (b-03 channel-kind.ts); no cross-surface imports.
 */
import type { InboxChannel } from '../../lib/inbox-unified'

const GLYPH_PATHS: Record<Exclude<InboxChannel, 'unknown'>, string> = {
  wa: 'M8 1a7 7 0 0 0-6 10.5L1 15l3.6-1A7 7 0 1 0 8 1z',
  signal: 'M8 2a5 5 0 0 1 5 5c0 3 1 4 1 4H2s1-1 1-4a5 5 0 0 1 5-5z',
  imessage:
    'M2 2h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H7l-4 3v-3H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z',
  sms: 'M12 3H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1l1 2 1.2-2H12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z',
  email: 'M1 3h14v10H1z',
  discord: 'M12 3H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1l1 2 1.2-2H12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z',
  x: 'M2 2l4.7 6L2.3 14h2l3.7-4.8L11.4 14H14L9.2 7.6 13.7 2h-2L8.2 6.4 5 2z',
}

export function ChannelGlyph({
  channel,
  className,
  title,
}: {
  channel: InboxChannel
  className?: string
  title?: string
}) {
  if (channel === 'unknown') {
    // Honest unknown: a hollow square, never a borrowed channel shape.
    return (
      <svg viewBox="0 0 16 16" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
        {title ? <title>{title}</title> : null}
        <rect x="3" y="3" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path d={GLYPH_PATHS[channel]} />
    </svg>
  )
}
