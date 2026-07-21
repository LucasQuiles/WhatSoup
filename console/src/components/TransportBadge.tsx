/**
 * TransportBadge.tsx — transport-kind badge (PR 4b, S4).
 *
 * Renders a 6px square dot + word, mirroring the ModeBadge shape law
 * (badge.md). The dot colour and label come from the canonical transport map
 * (transport-meta.ts) — never pass raw hex or class names from outside.
 *
 * Placement per design doc §3:
 *   - Fleet table row: after the line name, before the status pill
 *   - LineDetail header: same position
 *   - ChatList (Inbox): NOT in v1 (per-message transport is out of scope)
 *
 * The badge is deliberately compact (matches the mode-dot scale) so it
 * doesn't compete with the StatusCell shape for visual priority.
 */
import { type FC } from 'react';
import { resolveTransport, type TransportKind } from '../lib/transport-meta';

export interface TransportBadgeProps {
  /** Transport kind from the line's config (`transport` field). */
  kind: TransportKind | string | null | undefined;
  /**
   * iMessage backend sub-kind (only meaningful when kind === 'imessage').
   * Renders as a suffix on the label (e.g. "iMessage·BB").
   */
  backend?: 'imsg' | 'bluebubbles' | null;
  /**
   * Optional tooltip text. Defaults to the full transport label.
   */
  title?: string;
}

const TransportBadge: FC<TransportBadgeProps> = ({ kind, backend, title }) => {
  const entry = resolveTransport(kind ?? null);
  const isUnknown = kind != null && kind !== '' && entry.subLabel === 'unknown';

  // iMessage backend suffix (BB = BlueBubbles; imsg = imsg daemon).
  const label = entry.subLabel
    ? `${entry.label}·${entry.subLabel}`
    : backend === 'bluebubbles'
      ? `${entry.label}·BB`
      : backend === 'imsg'
        ? `${entry.label}·imsg`
        : entry.label;

  const dotClass = isUnknown
    ? 'soup-transport__dot soup-transport__dot--unknown'
    : 'soup-transport__dot';

  return (
    <span className={entry.transportClass} title={title ?? `Transport: ${label}`}>
      <span className={dotClass} aria-hidden="true" />
      {label}
    </span>
  );
};

export default TransportBadge;
