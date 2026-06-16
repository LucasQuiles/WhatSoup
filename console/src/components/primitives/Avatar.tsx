/**
 * Avatar.tsx — the identity primitive (avatar.md; showcase §20; DD-43).
 *
 * One component, every variant on the two shipped size tokens (--avatar-sm 32 /
 * --avatar-md 36) and the 8-hue identity palette (--avatar-hue-0..7):
 *   - Neutral initials — the chat-list shape (1-2 letters from a name, no hue).
 *   - Hue identity     — a deterministic hue from the name, for groups/contacts.
 *   - Presence ring    — online | away | offline, encoded by SHAPE + ring-style
 *                        (filled / hollow-ring / small-hollow), never colour alone
 *                        (§12 shape law). The state is announced as text via the
 *                        accessible name, not colour.
 *   - Overflow stack   — AvatarStack overlaps avatars and caps the row with "+N".
 *   - Image + fallback — renders an <img>; onError falls back to the initials.
 *
 * a11y: the disc carries role="img" + an aria-label conveying identity (and, when
 * a presence is set, the presence word) so screen readers announce who this is and
 * whether they are online — never relying on the ring colour.
 */
import { useState, type FC } from 'react';
import { getInitials, avatarHueIndex } from '../../lib/text-utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AvatarSize = 'sm' | 'md';
export type AvatarPresence = 'online' | 'away' | 'offline';

export interface AvatarProps {
  /** Identity name. Drives the initials, the deterministic hue, and the aria-label. */
  name: string;
  /** sm (32px) | md (36px). Default 'md'. */
  size?: AvatarSize;
  /**
   * Colour treatment:
   *   - 'hue'     — a deterministic identity hue from `name` (groups/contacts).
   *   - 'neutral' — the muted chat-list shape, no identity hue (default).
   */
  variant?: 'hue' | 'neutral';
  /** Optional image source. Falls back to initials if it fails to load. */
  src?: string;
  /** Presence state — rendered as a shape-coded ring AND announced in the label. */
  presence?: AvatarPresence;
  /** Override the accessible name. Defaults to the (presence-augmented) `name`. */
  'aria-label'?: string;
  className?: string;
}

// Human-readable presence words for the accessible name (announced as text, not colour).
const PRESENCE_LABEL: Record<AvatarPresence, string> = {
  online: 'online',
  away: 'away',
  offline: 'offline',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const Avatar: FC<AvatarProps> = ({
  name,
  size = 'md',
  variant = 'neutral',
  src,
  presence,
  className,
  'aria-label': ariaLabel,
}) => {
  // Image-fallback: once the <img> errors we render initials instead. Reset is
  // intentionally not wired (a failed src does not recover within a mounted row).
  const [imgFailed, setImgFailed] = useState(false);

  const initials = getInitials(name) || '?';
  const showImage = Boolean(src) && !imgFailed;
  const useHue = variant === 'hue' && !showImage;

  const label =
    ariaLabel ?? (presence ? `${name}, ${PRESENCE_LABEL[presence]}` : name);

  const composedClass = [
    'soup-av',
    `soup-av--${size}`,
    !showImage && !useHue && 'soup-av--neutral',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  // Hue is the one inline style: the palette is a per-identity token chosen at
  // runtime, so it cannot be a static class. Token-only — never a raw colour.
  const hueStyle = useHue
    ? { background: `var(--avatar-hue-${avatarHueIndex(name)})` }
    : undefined;

  return (
    <span
      className={composedClass}
      style={hueStyle}
      role="img"
      aria-label={label}
      data-presence={presence}
    >
      {showImage ? (
        <img
          className="soup-av__img"
          src={src}
          alt=""
          aria-hidden="true"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{initials}</span>
      )}
      {presence && (
        <span
          className={`soup-av__presence soup-av__presence--${presence}`}
          aria-hidden="true"
        />
      )}
    </span>
  );
};

// ---------------------------------------------------------------------------
// AvatarStack — overlapping group of avatars, capped with an overflow chip.
// ---------------------------------------------------------------------------

export interface AvatarStackProps {
  /** Identity names, in stacking order. */
  names: string[];
  /** Max avatars to render before collapsing the rest into a "+N" chip. */
  max?: number;
  size?: AvatarSize;
  /** Colour treatment passed to each avatar. Default 'hue' (group identity). */
  variant?: 'hue' | 'neutral';
  /** Accessible label for the whole group. Defaults to a member count. */
  'aria-label'?: string;
  className?: string;
}

export const AvatarStack: FC<AvatarStackProps> = ({
  names,
  max = 3,
  size = 'md',
  variant = 'hue',
  'aria-label': ariaLabel,
  className,
}) => {
  const capped = max > 0 ? max : 0;
  const shown = names.slice(0, capped);
  const overflow = names.length - shown.length;

  const label = ariaLabel ?? `${names.length} members`;
  const composedClass = ['soup-av-stack', className].filter(Boolean).join(' ');

  return (
    <span className={composedClass} role="group" aria-label={label}>
      {shown.map((memberName, i) => (
        <Avatar
          // Names can repeat within a group; pair with index for a stable key.
          key={`${memberName}-${i}`}
          name={memberName}
          size={size}
          variant={variant}
        />
      ))}
      {overflow > 0 && (
        <span
          className={`soup-av soup-av--${size} soup-av--more`}
          role="img"
          aria-label={`${overflow} more`}
        >
          <span aria-hidden="true">{`+${overflow}`}</span>
        </span>
      )}
    </span>
  );
};
