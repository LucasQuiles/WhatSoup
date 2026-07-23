/**
 * ChannelGlyph (T5 b-03) — the 14-channel silhouette set per
 * 11-channel-glyphography.md: filled monochrome silhouettes (currentColor,
 * never a brand hue), 16px canvas inside the 22px .fleet-chan container,
 * state tag reusing the status shapes (ok disc / warn diamond / crit square /
 * off outline) with the 2px surface keyline.
 *
 * Path provenance: wa/signal/imessage/sms/discord/telegram/x/reddit/email/slack
 * are canonical from the v3.5 mockups (fleet.html/inbox.html). Telegram carries
 * the §2 +12% optical wrapper. linkedin/instagram/facebook/teams are authored
 * to the §2 silhouette descriptions (no mockup instance exists) and are
 * flagged for the b-13/G3 optical review.
 */
import type { FC } from 'react';
import type { ChannelKind } from './channel-kind';

export type { ChannelKind } from './channel-kind';

export type ChannelTag = 'ok' | 'warn' | 'crit' | 'off';

const PATHS: Record<ChannelKind, React.ReactNode> = {
  wa: (
    <path d="M8 1a7 7 0 0 0-6 10.5L1 15l3.6-1A7 7 0 1 0 8 1zm3.5 9.5c-.7.7-1.6 1-2.5.8-1.5-.3-3-1.3-4-2.7S4.6 5.9 5 5c.3-.6 1-.7 1.3-.2l.8 1.2c.2.3.1.7-.1.9l-.5.5c.4.9 1.3 1.9 2.3 2.4l.5-.5c.2-.2.6-.3.9-.1l1.2.8c.3.2.4.6.1.5z" />
  ),
  signal: (
    <path d="M8 2a5 5 0 0 1 5 5c0 3 1 4 1 4H2s1-1 1-4a5 5 0 0 1 5-5zm-2 10a2 2 0 0 0 4 0z" />
  ),
  imessage: (
    <path d="M2 2h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H7l-4 3v-3H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
  ),
  sms: <path d="M2 3h12v2H2zm0 4h12v2H2zm0 4h8v2H2z" />,
  discord: (
    <path d="M12 3H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1l1 2 1.2-2H12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM6 9.5A1.2 1.2 0 1 1 6 7a1.2 1.2 0 0 1 0 2.5zm4 0A1.2 1.2 0 1 1 10 7a1.2 1.2 0 0 1 0 2.5z" />
  ),
  telegram: (
    <g transform="translate(-.8 0) scale(1.12)">
      <path d="M1.5 7.5 14 2l-3.5 12-3.7-4.5L4 11l1-3.5z" />
    </g>
  ),
  x: <path d="M2 2l4.7 6L2.3 14h2l3.7-4.8L11.4 14H14L9.2 7.6 13.7 2h-2L8.2 6.4 5 2z" />,
  linkedin: (
    <path d="M2.5 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM1.8 6h2.4v8H1.8zM6 6h2.3v1.1c.5-.8 1.4-1.3 2.5-1.3 2 0 3.2 1.2 3.2 3.4V14h-2.4V9.6c0-1-.4-1.7-1.3-1.7-.9 0-1.5.6-1.5 1.7V14H6z" />
  ),
  reddit: (
    <>
      <circle cx="8" cy="9" r="5" />
      <path d="M8 4V1.5L12 3" />
      <circle cx="6.2" cy="8.2" r=".9" fill="var(--surface-raised-v35)" />
      <circle cx="9.8" cy="8.2" r=".9" fill="var(--surface-raised-v35)" />
    </>
  ),
  instagram: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="3.5" />
      <circle cx="8" cy="8" r="2.6" fill="var(--surface-raised-v35)" />
      <circle cx="11.6" cy="4.4" r=".9" fill="var(--surface-raised-v35)" />
    </>
  ),
  facebook: (
    <path d="M9.5 14V8.8h2l.4-2.4H9.5V4.9c0-.7.3-1.1 1.2-1.1H12V1.6C11.6 1.5 10.8 1.5 10.2 1.5 8.4 1.5 7 2.6 7 4.6v1.8H5v2.4h2V14z" />
  ),
  email: (
    <>
      <path d="M1 3h14v10H1z" />
      <path d="M1 3l7 6 7-6" fillRule="evenodd" />
    </>
  ),
  slack: (
    <path
      fillRule="evenodd"
      d="M6 2a2 2 0 1 1 2 2v2h2a2 2 0 1 1 2 2v2a2 2 0 1 1-2 2H8v-2a2 2 0 1 1-2-2H4a2 2 0 1 1-2-2V4a2 2 0 0 1 2-2z"
    />
  ),
  teams: <path d="M2 2h12v3H2zM2 6.5h5v5.5H2zM8.5 6.5H14v5.5H8.5z" />,
};

const TAG_CLASS: Record<ChannelTag, string | null> = {
  ok: null, // base tag is the ok disc
  warn: 'fleet-chan__tag--warn',
  crit: 'fleet-chan__tag--crit',
  off: 'fleet-chan__tag--off',
};

interface ChannelGlyphProps {
  kind: ChannelKind;
  /** Connection state tag; always rendered — §5 gate: state tags present and
   *  shape-coded on every live glyph instance. */
  tag: ChannelTag;
  /** dim variant (deactivated lines): recessed ink, never invisible (§4.3). */
  dim?: boolean;
  /** Accessible label, e.g. "WhatsApp · connected". */
  title: string;
}

export const ChannelGlyph: FC<ChannelGlyphProps> = ({ kind, tag, dim, title }) => (
  <span
    className={`fleet-chan${dim ? ' fleet-chan--dim' : ''}`}
    role="img"
    aria-label={title}
    title={title}
  >
    <svg viewBox="0 0 16 16" aria-hidden="true">
      {PATHS[kind]}
    </svg>
    <span className={`fleet-chan__tag${TAG_CLASS[tag] ? ` ${TAG_CLASS[tag]}` : ''}`} aria-hidden="true" />
  </span>
);
