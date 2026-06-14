/**
 * status-map.ts — ONE canonical status/mode map for the SOUP console.
 *
 * Every status/mode renderer imports from here.  Literal status hexes or
 * per-component color maps outside this module are lint errors
 * (badge.md "One canonical map", DUP-06/07).
 *
 * Taxonomy is closed (G2 state taxonomy lock):
 *   Line status: online | degraded | unreachable | logged_out | config_error | unknown
 *   Link marker:  unlinked
 *   Mode:   passive | chat | agent
 */
import type { Status as LineStatus } from '../types';

// ---------------------------------------------------------------------------
// Closed union types
// ---------------------------------------------------------------------------

/**
 * Recognised status entries rendered by Badge.
 * `LineStatus` is the health taxonomy from types.ts; `unlinked` is a visual
 * linkage marker used by the same shape law but is not a line health value.
 */
export type Status = LineStatus | 'unlinked';

/** The three operating modes. */
export type Mode = 'passive' | 'chat' | 'agent';

/** CSS shape class applied to the 8px shape element. */
export type StatusShape = 'disc' | 'diamond' | 'square' | 'outline';

// ---------------------------------------------------------------------------
// Status entry
// ---------------------------------------------------------------------------

export interface StatusEntry {
  /** The visual shape rendered by StatusCell. */
  readonly shape: StatusShape;
  /**
   * The CSS custom property name (without `var()`) carrying the fill colour.
   * `null` for outline/unlinked (transparent fill).
   */
  readonly token: string | null;
  /** Human-visible label that ALWAYS travels with the shape. */
  readonly label: string;
  /** Optional secondary token for the label ink (warn/crit use coloured ink). */
  readonly labelToken: string | null;
  /** Shape CSS class (primitives.css) — the class binds the `token` above; defined together so the
   *  map is the single driver of rendering. */
  readonly shapeClass: string;
  /** Label ink CSS class (primitives.css) — binds `labelToken`. */
  readonly labelClass: string;
}

/** Map: Status to rendering entry (semantic tokens only). */
export const STATUS_MAP: Readonly<Record<Status, StatusEntry>> = {
  online: {
    shape: 'disc',
    token: '--status-ok-solid',
    label: 'online',
    labelToken: null,
    shapeClass: 'soup-shape soup-shape--ok',
    labelClass: 'soup-status-cell__lbl',
  },
  degraded: {
    shape: 'diamond',
    token: '--status-warn-solid',
    label: 'degraded',
    labelToken: '--status-warn-fg',
    shapeClass: 'soup-shape soup-shape--warn',
    labelClass: 'soup-status-cell__lbl soup-status-cell__lbl--warn',
  },
  unreachable: {
    shape: 'square',
    token: '--status-crit-solid',
    label: 'unreachable',
    labelToken: '--status-crit-fg',
    shapeClass: 'soup-shape soup-shape--crit',
    labelClass: 'soup-status-cell__lbl soup-status-cell__lbl--crit',
  },
  logged_out: {
    shape: 'square',
    token: '--status-crit-solid',
    label: 'logged out',
    labelToken: '--status-crit-fg',
    shapeClass: 'soup-shape soup-shape--crit',
    labelClass: 'soup-status-cell__lbl soup-status-cell__lbl--crit',
  },
  config_error: {
    shape: 'square',
    token: '--status-crit-solid',
    label: 'configuration error',
    labelToken: '--status-crit-fg',
    shapeClass: 'soup-shape soup-shape--crit',
    labelClass: 'soup-status-cell__lbl soup-status-cell__lbl--crit',
  },
  unknown: {
    shape: 'diamond',
    token: '--status-warn-solid',
    label: 'awaiting health signal',
    labelToken: '--status-warn-fg',
    shapeClass: 'soup-shape soup-shape--warn',
    labelClass: 'soup-status-cell__lbl soup-status-cell__lbl--warn',
  },
  unlinked: {
    shape: 'outline',
    token: null,
    label: 'unlinked',
    labelToken: null,
    shapeClass: 'soup-shape soup-shape--off',
    labelClass: 'soup-status-cell__lbl',
  },
} as const;

// ---------------------------------------------------------------------------
// Mode entry
// ---------------------------------------------------------------------------

export interface ModeEntry {
  /** CSS custom property name for the solid channel colour. */
  readonly token: string;
  /** Human-visible label. */
  readonly label: string;
  /** Mode CSS class (primitives.css) — binds `token`; the map is the single rendering driver. */
  readonly modeClass: string;
}

/** Map: Mode to rendering entry (semantic tokens only). */
export const MODE_MAP: Readonly<Record<Mode, ModeEntry>> = {
  passive: {
    token: '--mode-passive-solid',
    label: 'passive',
    modeClass: 'soup-mode soup-mode--passive',
  },
  chat: {
    token: '--mode-chat-solid',
    label: 'chat',
    modeClass: 'soup-mode soup-mode--chat',
  },
  agent: {
    token: '--mode-agent-solid',
    label: 'agent',
    modeClass: 'soup-mode soup-mode--agent',
  },
} as const;

// ---------------------------------------------------------------------------
// Safe look-up helpers
// ---------------------------------------------------------------------------

/**
 * Return the StatusEntry for a known status, or the "unlinked" outline entry
 * with the raw value as label for any unknown value (error/fail-visible path,
 * badge.md §States "error").
 */
export function resolveStatus(value: string): StatusEntry {
  if (value in STATUS_MAP) return STATUS_MAP[value as Status];
  // Fail-visible: unknown values render as the unlinked outline with the raw value as label.
  return { ...STATUS_MAP.unlinked, label: value };
}

/**
 * Return the ModeEntry for a known mode key, or null for any unknown value.
 */
export function resolveMode(value: string): ModeEntry | null {
  if (value in MODE_MAP) return MODE_MAP[value as Mode];
  return null;
}

// ---------------------------------------------------------------------------
// Connection-state map (DD-11) — the WS/transport connection taxonomy is
// adjacent to line status but distinct; it lives here so status-map stays the
// single owner of status-ish rendering decisions.
// ---------------------------------------------------------------------------

export type ConnectionState = 'connected' | 'connecting' | 'disconnected' | 'unknown';

export interface ConnectionEntry {
  readonly label: string;
  /** Ink utility class for the KPI value (legacy text-s-ok/text-t4 tier — these
   *  surfaces migrate to semantic ink utilities with the legacy-token slice). */
  readonly inkClass: string;
}

export const CONNECTION_MAP: Readonly<Record<ConnectionState, ConnectionEntry>> = {
  connected:    { label: 'connected',    inkClass: 'text-s-ok' },
  connecting:   { label: 'connecting',   inkClass: 'text-s-warn' },
  disconnected: { label: 'disconnected', inkClass: 'text-s-crit' },
  unknown:      { label: 'unknown',      inkClass: 'text-t4' },
} as const;

/** Fail-visible: unrecognised states render their raw value with neutral ink. */
export function resolveConnection(value: string): ConnectionEntry {
  if (value in CONNECTION_MAP) return CONNECTION_MAP[value as ConnectionState];
  return { label: value, inkClass: 'text-t4' };
}
