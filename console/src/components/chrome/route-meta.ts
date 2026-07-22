/**
 * v3.5 chrome route metadata (T5 b-02) — one source mapping pathname →
 * chrome title, nameplate context caps, and which rail item is active.
 * Surfaces per 02-mapping.md §2; routes that are stubs until their surface
 * bead lands are flagged so the shell can render the honest placeholder.
 */
import {
  FleetGlyph,
  AgentsGlyph,
  InboxGlyph,
  OpsGlyph,
  SkillsGlyph,
  DreamLabGlyph,
  DeploymentsGlyph,
  SettingsGlyph,
} from './glyphs';
import type { FC } from 'react';

export interface NavItemMeta {
  label: string;
  to: string;
  glyph: FC<{ className?: string }>;
  /** Active predicate — Fleet also owns /lines/*, Ops owns the legacy
   *  /operator + /metrics paths it consolidates (02-mapping §2, E4). */
  isActive: (pathname: string) => boolean;
}

export interface NavSectionMeta {
  label: string;
  items: NavItemMeta[];
}

export const NAV_SECTIONS: NavSectionMeta[] = [
  {
    label: 'Operate',
    items: [
      {
        label: 'Fleet',
        to: '/',
        glyph: FleetGlyph,
        isActive: (p) => p === '/' || p.startsWith('/lines/'),
      },
      { label: 'Agents', to: '/agents', glyph: AgentsGlyph, isActive: (p) => p.startsWith('/agents') },
      { label: 'Inbox', to: '/inbox', glyph: InboxGlyph, isActive: (p) => p.startsWith('/inbox') },
      {
        label: 'Ops',
        to: '/ops',
        glyph: OpsGlyph,
        isActive: (p) => p === '/ops' || p === '/operator' || p.startsWith('/metrics'),
      },
    ],
  },
  {
    label: 'Create',
    items: [
      { label: 'Skills', to: '/skills', glyph: SkillsGlyph, isActive: (p) => p.startsWith('/skills') },
      {
        label: 'Dream Lab',
        to: '/dream-lab',
        glyph: DreamLabGlyph,
        isActive: (p) => p.startsWith('/dream-lab'),
      },
    ],
  },
  {
    label: 'System',
    items: [
      {
        label: 'Deployments',
        to: '/deployments',
        glyph: DeploymentsGlyph,
        isActive: (p) => p.startsWith('/deployments'),
      },
      {
        label: 'Settings',
        to: '/settings',
        glyph: SettingsGlyph,
        isActive: (p) => p.startsWith('/settings'),
      },
    ],
  },
];

interface RouteMeta {
  /** Title text in the chrome header (line detail shows the line name instead). Surfaces own the h1. */
  title: string;
  /** Nameplate context caps (mockup .ctx). */
  ctx: string;
}

const ROUTE_META: Array<[match: (p: string) => boolean, meta: RouteMeta]> = [
  [(p) => p === '/' || p.startsWith('/lines/'), { title: 'Fleet', ctx: 'FLEET' }],
  [(p) => p.startsWith('/inbox'), { title: 'Inbox', ctx: 'INBOX' }],
  [
    (p) => p === '/ops' || p === '/operator' || p.startsWith('/metrics'),
    { title: 'Ops', ctx: 'OPS' },
  ],
  [(p) => p.startsWith('/agents'), { title: 'Agents', ctx: 'AGENTS' }],
  [(p) => p.startsWith('/skills'), { title: 'Skills', ctx: 'SKILLS' }],
  [(p) => p.startsWith('/dream-lab'), { title: 'Dream Lab', ctx: 'DREAM LAB' }],
  [(p) => p.startsWith('/deployments'), { title: 'Deployments', ctx: 'DEPLOYMENTS' }],
  [(p) => p.startsWith('/settings'), { title: 'Settings', ctx: 'SETTINGS' }],
];

const FALLBACK: RouteMeta = { title: 'Fleet', ctx: 'FLEET' };

export function routeMeta(pathname: string): RouteMeta {
  for (const [match, meta] of ROUTE_META) {
    if (match(pathname)) return meta;
  }
  return FALLBACK;
}
