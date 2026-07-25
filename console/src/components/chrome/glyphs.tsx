/**
 * v3.5 chrome nav glyphs — 16px monochrome set (11-channel-glyphography §1
 * floor). Path data copied byte-exact from the mockup inline SVGs
 * (docs/design-system/v35/mockups/*.html) — the mockups are the visual SSOT.
 * Glyphs inherit color via currentColor; sizing lives in chrome.css
 * (.chrome-nav-item svg → --chrome-icon).
 */
import type { FC } from 'react';

interface GlyphProps {
  /** Extra class hook (e.g. state modifiers). Sizing is owned by chrome.css. */
  className?: string;
}

function glyphProps(className?: string) {
  return {
    viewBox: '0 0 16 16',
    fill: 'currentColor',
    'aria-hidden': true as const,
    className,
  };
}

export const FleetGlyph: FC<GlyphProps> = ({ className }) => (
  <svg {...glyphProps(className)}>
    <path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" />
  </svg>
);

export const AgentsGlyph: FC<GlyphProps> = ({ className }) => (
  <svg {...glyphProps(className)}>
    <path d="M8 1.5 14 5v6l-6 3.5L2 11V5z" />
  </svg>
);

export const InboxGlyph: FC<GlyphProps> = ({ className }) => (
  <svg {...glyphProps(className)}>
    <path d="M2 3h12v9H6l-4 3z" />
  </svg>
);

/** Ops is the one stroke-mode glyph in the mockup set (bar chart). */
export const OpsGlyph: FC<GlyphProps> = ({ className }) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    aria-hidden={true}
    className={className}
  >
    <path d="M3 13V8m5 5V3m5 10v-7" />
  </svg>
);

export const SkillsGlyph: FC<GlyphProps> = ({ className }) => (
  <svg {...glyphProps(className)}>
    <path d="M8 2a6 6 0 1 0 6 6h-2a4 4 0 1 1-4-4z" />
    <path d="M8 6l5-3-3 5z" />
  </svg>
);

export const DreamLabGlyph: FC<GlyphProps> = ({ className }) => (
  <svg {...glyphProps(className)}>
    <path d="M8 2c2 2 2 4 0 6s-2 4 0 6c-3-1-5-3-5-6s2-5 5-6z" />
  </svg>
);

export const DeploymentsGlyph: FC<GlyphProps> = ({ className }) => (
  <svg {...glyphProps(className)}>
    <path d="M2 3h12v4H2zM2 9h12v4H2z" />
  </svg>
);

export const SettingsGlyph: FC<GlyphProps> = ({ className }) => (
  <svg {...glyphProps(className)}>
    <path d="M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm6 3h2M1 8h2m5-7v2m0 10v2m5-12 1.5-1.5M2.5 13.5 4 12m9 1.5L11.5 12M2.5 2.5 4 4" />
  </svg>
);

/** Theme toggle sun (mockup .theme-toggle): stroke ring + rays. */
export const SunGlyph: FC<GlyphProps> = ({ className }) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    aria-hidden={true}
    className={className}
  >
    <circle cx="8" cy="8" r="3.2" />
    <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M13 3l-1.4 1.4M4.4 11.6 3 13" />
  </svg>
);
