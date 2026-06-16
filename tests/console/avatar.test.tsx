/**
 * @vitest-environment jsdom
 *
 * Avatar primitive (avatar.md; showcase §20; DD-43).
 *
 * Covers:
 *   - initials derivation (1-2 letters; empty name → "?")
 *   - hue determinism (same name → same --avatar-hue-N; index in 0..7)
 *   - neutral vs hue variant rendering
 *   - size token classes (sm/md)
 *   - presence ring: shape-coded class + presence announced as TEXT in the
 *     accessible name (never colour alone)
 *   - image-fallback: <img> onError swaps to initials
 *   - overflow stack: caps at `max` and renders a "+N" chip
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Avatar, AvatarStack } from '../../console/src/components/primitives/Avatar';
import { avatarHueIndex } from '../../console/src/lib/text-utils';

afterEach(() => { cleanup(); });

// ---------------------------------------------------------------------------
// Initials
// ---------------------------------------------------------------------------

describe('Avatar — initials', () => {
  it('derives two initials from a two-word name', () => {
    render(<Avatar name="Lucas Quiles" />);
    expect(screen.getByText('LQ')).toBeDefined();
  });

  it('derives a single initial from a one-word name', () => {
    render(<Avatar name="Nadia" />);
    expect(screen.getByText('N')).toBeDefined();
  });

  it('caps initials at two letters for long names', () => {
    render(<Avatar name="Alpha Bravo Charlie Delta" />);
    expect(screen.getByText('AB')).toBeDefined();
  });

  it('falls back to "?" for an empty name', () => {
    render(<Avatar name="   " />);
    expect(screen.getByText('?')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Hue determinism
// ---------------------------------------------------------------------------

describe('Avatar — hue determinism', () => {
  it('maps any name to a palette index in 0..7', () => {
    for (const n of ['Anna', 'Kofi', 'Naomi', 'Sven', 'x', 'a much longer identity string']) {
      const idx = avatarHueIndex(n);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(8);
      expect(Number.isInteger(idx)).toBe(true);
    }
  });

  it('returns the same index for the same name (deterministic)', () => {
    expect(avatarHueIndex('Group Alpha')).toBe(avatarHueIndex('Group Alpha'));
  });

  it('distinguishes at least some different names', () => {
    // Not a perfect hash, but the palette must spread — these two must differ.
    expect(avatarHueIndex('Anna')).not.toBe(avatarHueIndex('Kofi'));
  });

  it('binds the hue variant to the matching --avatar-hue token', () => {
    render(<Avatar name="Group Alpha" variant="hue" />);
    const el = document.querySelector('.soup-av')!;
    const expected = `var(--avatar-hue-${avatarHueIndex('Group Alpha')})`;
    expect((el as HTMLElement).style.background).toBe(expected);
  });

  it('does not apply a hue background in the neutral variant', () => {
    render(<Avatar name="Group Alpha" variant="neutral" />);
    const el = document.querySelector('.soup-av')!;
    expect((el as HTMLElement).style.background).toBe('');
    expect(el.classList.contains('soup-av--neutral')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

describe('Avatar — sizes', () => {
  it('applies soup-av--md by default', () => {
    render(<Avatar name="A" />);
    expect(document.querySelector('.soup-av--md')).not.toBeNull();
  });

  it('applies soup-av--sm when size="sm"', () => {
    render(<Avatar name="A" size="sm" />);
    expect(document.querySelector('.soup-av--sm')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Presence — shape law + announced as text
// ---------------------------------------------------------------------------

describe('Avatar — presence', () => {
  it('online: announces "online" in the accessible name AND uses the online shape class', () => {
    render(<Avatar name="Nora" presence="online" />);
    const el = screen.getByRole('img');
    expect(el.getAttribute('aria-label')).toBe('Nora, online');
    expect(document.querySelector('.soup-av__presence--online')).not.toBeNull();
  });

  it('away: announces "away" and uses the away (hollow-ring) shape class', () => {
    render(<Avatar name="Nora" presence="away" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Nora, away');
    expect(document.querySelector('.soup-av__presence--away')).not.toBeNull();
  });

  it('offline: announces "offline" and uses the offline (small-hollow) shape class', () => {
    render(<Avatar name="Nora" presence="offline" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Nora, offline');
    expect(document.querySelector('.soup-av__presence--offline')).not.toBeNull();
  });

  it('renders no presence dot when presence is unset', () => {
    render(<Avatar name="Nora" />);
    expect(document.querySelector('.soup-av__presence')).toBeNull();
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Nora');
  });

  it('honours an explicit aria-label override', () => {
    render(<Avatar name="Nora" presence="online" aria-label="Nora Smith (you)" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Nora Smith (you)');
  });
});

// ---------------------------------------------------------------------------
// Image + fallback
// ---------------------------------------------------------------------------

describe('Avatar — image fallback', () => {
  it('renders an <img> when src is provided and not yet failed', () => {
    render(<Avatar name="Lucas Quiles" src="https://example.test/a.png" />);
    const img = document.querySelector('img.soup-av__img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://example.test/a.png');
    // While the image is showing, the initials are not rendered.
    expect(screen.queryByText('LQ')).toBeNull();
  });

  it('falls back to initials after the image errors', () => {
    render(<Avatar name="Lucas Quiles" src="https://example.test/broken.png" />);
    const img = document.querySelector('img.soup-av__img')!;
    fireEvent.error(img);
    expect(document.querySelector('img.soup-av__img')).toBeNull();
    expect(screen.getByText('LQ')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Overflow stack
// ---------------------------------------------------------------------------

describe('AvatarStack — overflow', () => {
  it('renders all members and no chip when under the cap', () => {
    render(<AvatarStack names={['Ana', 'Ben']} max={3} />);
    expect(document.querySelectorAll('.soup-av').length).toBe(2);
    expect(document.querySelector('.soup-av--more')).toBeNull();
  });

  it('caps the row and renders a "+N" overflow chip', () => {
    render(<AvatarStack names={['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fin']} max={3} />);
    // 3 shown + 1 overflow chip = 4 .soup-av nodes
    expect(document.querySelectorAll('.soup-av').length).toBe(4);
    const chip = document.querySelector('.soup-av--more')!;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toBe('+3');
    expect(chip.getAttribute('aria-label')).toBe('3 more');
  });

  it('labels the group with a member count by default', () => {
    render(<AvatarStack names={['Ana', 'Ben', 'Cy']} />);
    const group = screen.getByRole('group');
    expect(group.getAttribute('aria-label')).toBe('3 members');
  });
});
