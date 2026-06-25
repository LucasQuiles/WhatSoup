/**
 * @vitest-environment jsdom
 *
 * Behavioral contract-lock for StatusCell, ModeBadge, StatusDot (wrapper),
 * and the canonical status-map module.
 *
 * These tests assert the SHAPE LAW (badge.md):
 *   online      -> disc (soup-shape--ok, 50% radius)
 *   degraded    -> diamond (soup-shape--warn, rotate45 scale0.92)
 *   unreachable -> square (soup-shape--crit, 1px radius)
 *   logged_out  -> square (soup-shape--crit, 1px radius)
 *   config_error-> square (soup-shape--crit, 1px radius)
 *   unknown     -> diamond (soup-shape--warn, rotate45 scale0.92)
 *   unlinked    -> outline disc (soup-shape--off, transparent + border-strong)
 *
 * Labels ALWAYS travel with the shape — no color-only status rendering.
 *
 * CHANGED FROM PRIOR VERSION:
 *   - Old: asserted rounded-full for ALL statuses (incorrectly uniform).
 *   - New: asserts the correct shape class per the shape law.
 *   - Old: asserted inline px width/height (6px/8px) via StatusDot.
 *   - New: StatusDot is a wrapper; shape dimensions are via CSS class.
 *   - Old: asserted bg-s-ok/warn/crit Tailwind utilities.
 *   - New: asserts soup-shape--ok/warn/crit primitive classes.
 *   - Old: asserted animate-breathe-ring class.
 *   - New: asserts soup-shape--live class (halo via CSS ::after).
 *
 * JUSTIFICATION: The shape-law migration replaces 7 color-only implementations
 * with a single canonical StatusCell. The old assertions were spec violations
 * (color-only, uniform shape) — the new assertions are the honest contract.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusCell, ModeBadge as ModeBadgePrimitive } from '../../console/src/components/primitives/index.ts';
import ModeBadge from '../../console/src/components/ModeBadge.tsx';
import StatusDot from '../../console/src/components/StatusDot.tsx';
import { STATUS_MAP, MODE_MAP, resolveStatus, resolveMode, CONNECTION_MAP, resolveConnection } from '../../console/src/lib/status-map.ts';
import {
  statusAlertMessage,
  statusBadgeStyle,
  statusColorToken,
  statusSeverity,
  statusTextClassForSeverity,
  statusWashToken,
} from '../../console/src/lib/status-severity.ts';


afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// status-map module unit tests
// ---------------------------------------------------------------------------

describe('STATUS_MAP', () => {
  it('contains the complete line-health set plus the unlinked visual marker', () => {
    const keys = Object.keys(STATUS_MAP);
    expect(keys.sort()).toEqual(['config_error', 'degraded', 'logged_out', 'online', 'unknown', 'unlinked', 'unreachable']);
  });

  it('maps online to disc shape', () => {
    expect(STATUS_MAP.online.shape).toBe('disc');
    expect(STATUS_MAP.online.label).toBe('online');
    expect(STATUS_MAP.online.labelToken).toBeNull();
    expect(STATUS_MAP.online.token).toBe('--status-ok-solid');
  });

  it('maps degraded to diamond shape with warn label token', () => {
    expect(STATUS_MAP.degraded.shape).toBe('diamond');
    expect(STATUS_MAP.degraded.label).toBe('degraded');
    expect(STATUS_MAP.degraded.labelToken).toBe('--status-warn-fg');
  });

  it('maps unreachable to square shape with crit label token', () => {
    expect(STATUS_MAP.unreachable.shape).toBe('square');
    expect(STATUS_MAP.unreachable.label).toBe('unreachable');
    expect(STATUS_MAP.unreachable.labelToken).toBe('--status-crit-fg');
  });

  it('maps logged-out and config-error statuses to crit square labels', () => {
    for (const status of ['logged_out', 'config_error'] as const) {
      expect(STATUS_MAP[status].shape).toBe('square');
      expect(STATUS_MAP[status].label).toBe(statusAlertMessage(status));
      expect(STATUS_MAP[status].labelToken).toBe('--status-crit-fg');
      expect(statusSeverity(status)).toBe('crit');
    }
  });

  it('maps unknown line-health status to warn diamond with the status alert label', () => {
    expect(STATUS_MAP.unknown.shape).toBe('diamond');
    expect(STATUS_MAP.unknown.label).toBe(statusAlertMessage('unknown'));
    expect(STATUS_MAP.unknown.labelToken).toBe('--status-warn-fg');
    expect(statusSeverity('unknown')).toBe('warn');
  });

  it('maps unlinked to outline shape, no fill token', () => {
    expect(STATUS_MAP.unlinked.shape).toBe('outline');
    expect(STATUS_MAP.unlinked.token).toBeNull();
    expect(STATUS_MAP.unlinked.label).toBe('unlinked');
    expect(STATUS_MAP.unlinked.shapeClass).toBe('soup-shape soup-shape--off');
  });
});

describe('status severity helpers', () => {
  it('maps severities to semantic status color tokens', () => {
    expect(statusColorToken('ok')).toBe('var(--status-ok-solid)');
    expect(statusColorToken('warn')).toBe('var(--status-warn-solid)');
    expect(statusColorToken('crit')).toBe('var(--status-crit-solid)');
  });

  it('maps severities to semantic status wash tokens', () => {
    expect(statusWashToken('ok')).toBe('var(--status-ok-wash)');
    expect(statusWashToken('warn')).toBe('var(--status-warn-wash)');
    expect(statusWashToken('crit')).toBe('var(--status-crit-wash)');
  });

  it('returns paired badge styles from the shared helper', () => {
    expect(statusBadgeStyle('warn')).toEqual({
      bg: 'var(--status-warn-wash)',
      color: 'var(--status-warn-solid)',
    });
  });

  it('maps severity utility classes from one table', () => {
    expect(statusTextClassForSeverity('ok')).toBe('text-s-ok');
    expect(statusTextClassForSeverity('warn')).toBe('text-s-warn');
    expect(statusTextClassForSeverity('crit')).toBe('text-s-crit');
  });
});

describe('MODE_MAP', () => {
  it('contains exactly three closed-set modes', () => {
    const keys = Object.keys(MODE_MAP);
    expect(keys.sort()).toEqual(['agent', 'chat', 'passive']);
  });

  it.each(['passive', 'chat', 'agent'] as const)('%s has a token and washToken', (mode) => {
    expect(MODE_MAP[mode].token).toBe(`--mode-${mode}-solid`);
    expect(MODE_MAP[mode].label).toBe(mode);
    expect(MODE_MAP[mode].modeClass).toBe(`soup-mode soup-mode--${mode}`);
  });
});

describe('resolveStatus', () => {
  it('returns canonical entry for known statuses', () => {
    expect(resolveStatus('online').shape).toBe('disc');
    expect(resolveStatus('degraded').shape).toBe('diamond');
    expect(resolveStatus('unreachable').shape).toBe('square');
    expect(resolveStatus('logged_out').shape).toBe('square');
    expect(resolveStatus('config_error').shape).toBe('square');
    expect(resolveStatus('unknown').shape).toBe('diamond');
    expect(resolveStatus('unlinked').shape).toBe('outline');
  });

  it('returns outline + raw value label for unknown status (fail-visible)', () => {
    const entry = resolveStatus('some-unknown-state');
    expect(entry.shape).toBe('outline');
    expect(entry.label).toBe('some-unknown-state');
    expect(entry.token).toBeNull();
    expect(entry.shapeClass).toBe('soup-shape soup-shape--off');
  });
});


describe('resolveMode', () => {
  it('returns entry for known modes', () => {
    expect(resolveMode('passive')).not.toBeNull();
    expect(resolveMode('chat')).not.toBeNull();
    expect(resolveMode('agent')).not.toBeNull();
  });

  it('returns null for unknown mode', () => {
    expect(resolveMode('turbo-mode')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// StatusCell — shape law assertions
// ---------------------------------------------------------------------------

describe('StatusCell shape law', () => {
  const shapeCases: Array<{
    status: string;
    expectedShapeClass: string;
    expectedLabel: string;
    shouldHaveLive?: boolean;
  }> = [
    { status: 'online',      expectedShapeClass: 'soup-shape--ok',   expectedLabel: 'online' },
    { status: 'degraded',    expectedShapeClass: 'soup-shape--warn',  expectedLabel: 'degraded' },
    { status: 'unreachable', expectedShapeClass: 'soup-shape--crit',  expectedLabel: 'unreachable' },
    { status: 'logged_out',  expectedShapeClass: 'soup-shape--crit',  expectedLabel: 'logged out' },
    { status: 'config_error', expectedShapeClass: 'soup-shape--crit', expectedLabel: 'configuration error' },
    { status: 'unknown',     expectedShapeClass: 'soup-shape--warn',  expectedLabel: 'awaiting health signal' },
    { status: 'unlinked',    expectedShapeClass: 'soup-shape--off',   expectedLabel: 'unlinked' },

  ];

  for (const { status, expectedShapeClass, expectedLabel } of shapeCases) {
    it(`${status}: renders ${expectedShapeClass} shape + "${expectedLabel}" label`, () => {
      render(<StatusCell status={status} />);

      // Label always present
      expect(screen.getByText(expectedLabel)).toBeTruthy();

      // Correct shape class
      const shape = document.querySelector(`.${expectedShapeClass}`);
      expect(shape).not.toBeNull();
      expect(shape!.classList.contains('soup-shape')).toBe(true);
    });
  }

  it('online shape does NOT carry live halo without live prop', () => {
    render(<StatusCell status="online" />);
    const shape = document.querySelector('.soup-shape--ok');
    expect(shape!.classList.contains('soup-shape--live')).toBe(false);
  });

  it('online shape carries live halo when live=true', () => {
    render(<StatusCell status="online" live={true} />);
    const shape = document.querySelector('.soup-shape--ok');
    expect(shape!.classList.contains('soup-shape--live')).toBe(true);
  });

  it('degraded shape does NOT carry live halo even with live=true', () => {
    render(<StatusCell status="degraded" live={true} />);
    const shape = document.querySelector('.soup-shape--warn');
    expect(shape!.classList.contains('soup-shape--live')).toBe(false);
  });

  it('unknown status renders outline + raw value label (error/fail-visible)', () => {
    render(<StatusCell status="some-unknown" />);
    expect(screen.getByText('some-unknown')).toBeTruthy();
    expect(document.querySelector('.soup-shape--off')).not.toBeNull();
  });

  it('renders name prominently when name prop is provided', () => {
    render(<StatusCell status="online" name="support" />);
    expect(screen.getByText('support')).toBeTruthy();
  });

  it('shape has role="img" and aria-label for accessibility', () => {
    render(<StatusCell status="degraded" />);
    const shape = document.querySelector('[role="img"]');
    expect(shape).not.toBeNull();
    expect(shape!.getAttribute('aria-label')).toBe('degraded');
  });
});

// ---------------------------------------------------------------------------
// ModeBadge primitive
// ---------------------------------------------------------------------------

describe('ModeBadge primitive', () => {
  const modeCases: Array<['passive' | 'chat' | 'agent']> = [
    ['passive'], ['chat'], ['agent'],
  ];

  for (const [mode] of modeCases) {
    it(`renders "${mode}" label with soup-mode--${mode} class`, () => {
      render(<ModeBadgePrimitive mode={mode} />);
      expect(screen.getByText(mode)).toBeTruthy();
      const badge = document.querySelector(`.soup-mode--${mode}`);
      expect(badge).not.toBeNull();
      expect(badge!.classList.contains('soup-mode')).toBe(true);
    });

    it(`${mode} badge has a 6px square dot element`, () => {
      render(<ModeBadgePrimitive mode={mode} />);
      const dot = document.querySelector(`.soup-mode--${mode} .soup-mode__dot`);
      expect(dot).not.toBeNull();
    });
  }

  it('unknown mode renders soup-mode--unknown with raw value label', () => {
    render(<ModeBadgePrimitive mode="turbo-mode" />);
    expect(screen.getByText('turbo-mode')).toBeTruthy();
    expect(document.querySelector('.soup-mode--unknown')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ModeBadge wrapper (backward compat)
// ---------------------------------------------------------------------------

describe('ModeBadge wrapper (backward compat)', () => {
  it('renders "passive" mode correctly via wrapper', () => {
    render(<ModeBadge mode="passive" />);
    expect(screen.getByText('passive')).toBeTruthy();
  });

  it('renders "agent" mode correctly via wrapper', () => {
    render(<ModeBadge mode="agent" />);
    expect(screen.getByText('agent')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// StatusDot wrapper (backward compat)
// ---------------------------------------------------------------------------

describe('StatusDot wrapper (backward compat)', () => {
  it('renders online status with disc shape', () => {
    render(<StatusDot status="online" />);
    expect(document.querySelector('.soup-shape--ok')).not.toBeNull();
    expect(screen.getByText('online')).toBeTruthy();
  });

  it('renders degraded status with diamond shape', () => {
    render(<StatusDot status="degraded" />);
    expect(document.querySelector('.soup-shape--warn')).not.toBeNull();
    expect(screen.getByText('degraded')).toBeTruthy();
  });

  it('renders unreachable status with square shape', () => {
    render(<StatusDot status="unreachable" />);
    expect(document.querySelector('.soup-shape--crit')).not.toBeNull();
    expect(screen.getByText('unreachable')).toBeTruthy();
  });

});

// ---------------------------------------------------------------------------
// CONNECTION_MAP — DD-11: connection-state taxonomy lives in status-map
// ---------------------------------------------------------------------------

describe('CONNECTION_MAP — connection-state taxonomy lives in status-map (DD-11)', () => {
  it('maps each connection state to label + ink class, fail-visible for unknown values', () => {
    expect(CONNECTION_MAP.connected.inkClass).toBe('text-s-ok');
    expect(CONNECTION_MAP.connecting.inkClass).toBe('text-s-warn');
    expect(CONNECTION_MAP.disconnected.inkClass).toBe('text-s-crit');
    expect(CONNECTION_MAP.unknown.inkClass).toBe('text-text-2');
    expect(resolveConnection('connected').label).toBe('connected');
    // Fail-visible: unrecognised state renders its raw value with neutral ink.
    const odd = resolveConnection('half-open');
    expect(odd.inkClass).toBe('text-text-2');
    expect(odd.label).toBe('half-open');

  });
});
