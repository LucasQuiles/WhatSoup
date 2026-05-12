/**
 * Behavioral contract-lock for console/src/components/AlertBanner.tsx.
 *
 * AlertBanner (54 LOC) renders a per-line alert chip strip used by the
 * Nav and Dashboard surfaces. Critical invariants:
 *   - Returns null when alerts=[] (no empty-banner chrome)
 *   - Badge text pluralizes correctly ("1 alert" vs "N alerts")
 *   - One <button> per alert with the alert text inline
 *   - Click forwards the alert object to onAlertClick; tolerates undefined
 *     (optional chaining)
 *
 * No prior test mirror. ReactElement tree inspection only (no DOM/jsdom).
 *
 * Toast (62 LOC) is deferred to a future PR because it calls useEffect at
 * mount, which requires a React renderer with an active dispatcher (jsdom
 * + @testing-library/react). A separate PR will cover Toast via the RTL
 * pattern used by tests/console/message-bubble.test.tsx.
 */
import { describe, expect, it, vi } from 'vitest';
import { type ReactElement, type ReactNode } from 'react';
import AlertBanner from '../../console/src/components/AlertBanner.tsx';

interface Alert { line: string; message: string }

function renderBanner(props: { alerts: Alert[]; onAlertClick?: (a: Alert) => void }): ReactElement | null {
  return (AlertBanner as (p: typeof props) => ReactElement | null)(props);
}

function flatten(node: ReactNode): ReactElement[] {
  if (typeof node !== 'object' || node === null) return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  if ('type' in node) {
    const el = node as ReactElement;
    return [el, ...flatten(el.props.children)];
  }
  return [];
}

function plainText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plainText).join('');
  if (typeof node === 'object' && node !== null && 'props' in node) {
    return plainText((node as ReactElement).props.children);
  }
  return '';
}

describe('AlertBanner — empty state', () => {
  it('returns null when alerts is empty (no chrome rendered)', () => {
    expect(renderBanner({ alerts: [] })).toBeNull();
  });
});

describe('AlertBanner — badge pluralization', () => {
  it('renders "1 alert" (singular) for one alert', () => {
    const tree = renderBanner({ alerts: [{ line: 'L1', message: 'm' }] })!;
    const text = plainText(tree);
    expect(text).toContain('1 alert');
    // Singular form: "1 alert" present but NOT followed by 's'
    expect(text).not.toMatch(/1 alerts/);
  });

  it('renders "N alerts" (plural) for multiple alerts', () => {
    const tree = renderBanner({
      alerts: [
        { line: 'L1', message: 'm1' },
        { line: 'L2', message: 'm2' },
        { line: 'L3', message: 'm3' },
      ],
    })!;
    expect(plainText(tree)).toContain('3 alerts');
  });
});

describe('AlertBanner — per-alert chip rendering', () => {
  it('renders one <button> per alert', () => {
    const alerts: Alert[] = [
      { line: 'L1', message: 'msg-1' },
      { line: 'L2', message: 'msg-2' },
    ];
    const tree = renderBanner({ alerts })!;
    const buttons = flatten(tree).filter((el) => el.type === 'button');
    expect(buttons).toHaveLength(2);
  });

  it('each chip carries the line + message text', () => {
    const alerts: Alert[] = [{ line: 'whatsoup@a', message: 'connection-lost' }];
    const tree = renderBanner({ alerts })!;
    const text = plainText(tree);
    expect(text).toContain('whatsoup@a');
    expect(text).toContain('connection-lost');
  });

  it('button onClick forwards the alert to onAlertClick', () => {
    const onAlertClick = vi.fn();
    const alert = { line: 'L1', message: 'm1' };
    const tree = renderBanner({ alerts: [alert], onAlertClick })!;
    const button = flatten(tree).find((el) => el.type === 'button')!;
    (button.props.onClick as () => void)();
    expect(onAlertClick).toHaveBeenCalledTimes(1);
    expect(onAlertClick).toHaveBeenCalledWith(alert);
  });

  it('does NOT throw when clicked with onAlertClick undefined (optional chaining)', () => {
    const tree = renderBanner({ alerts: [{ line: 'L1', message: 'm1' }] })!;
    const button = flatten(tree).find((el) => el.type === 'button')!;
    expect(() => (button.props.onClick as () => void)()).not.toThrow();
  });

  it('chip has type="button" to avoid accidental form submit', () => {
    const tree = renderBanner({ alerts: [{ line: 'L1', message: 'm' }] })!;
    const button = flatten(tree).find((el) => el.type === 'button')!;
    expect(button.props.type).toBe('button');
  });
});
