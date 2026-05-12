/**
 * Behavioral contract-lock for console/src/components/FeedIcon.tsx.
 *
 * FeedIcon switches on `event.detail.type` (8 distinct branches) plus the
 * special "no-detail" fallback. The same `lucide-react` icon may appear
 * in multiple branches with different colorClasses, so the test pins
 * (iconComponent, colorClass) per branch — that's the regression that
 * matters when icons or colors get reshuffled during design updates.
 *
 * No prior test mirror. ReactElement tree inspection only (no DOM/jsdom).
 */
import { describe, expect, it } from 'vitest';
import { createElement, type ReactElement } from 'react';
import {
  Plug, WifiOff, Wifi,
  ArrowDownLeft, ArrowUpRight,
  AlertTriangle,
  Terminal,
  HeartPulse,
  Database,
  CircleDot,
} from 'lucide-react';
import FeedIcon from '../../console/src/components/FeedIcon.tsx';
import type { FeedEvent } from '../../console/src/types.ts';

function render(event: FeedEvent): ReactElement {
  return (FeedIcon as (props: { event: FeedEvent }) => ReactElement)({ event });
}

function feed(detail: FeedEvent['detail']): FeedEvent {
  return { time: '2026-05-12T00:00:00Z', mode: 'agent', text: 't', detail };
}

describe('FeedIcon — fallback when detail is missing', () => {
  it('renders <CircleDot className=text-t5> when no detail is set', () => {
    const tree = render({ time: '2026-05-12T00:00:00Z', mode: 'agent', text: 't' });
    expect(tree.type).toBe(CircleDot);
    expect(String(tree.props.className)).toContain('text-t5');
  });

  it('renders <CircleDot className=text-t5> for type="generic"', () => {
    const tree = render(feed({ type: 'generic' }));
    expect(tree.type).toBe(CircleDot);
    expect(String(tree.props.className)).toContain('text-t5');
  });
});

describe('FeedIcon — connection branch', () => {
  it('state="connected" → Wifi + text-s-ok', () => {
    const tree = render(feed({ type: 'connection', state: 'connected' }));
    expect(tree.type).toBe(Wifi);
    expect(String(tree.props.className)).toContain('text-s-ok');
  });

  it('state="disconnected" → WifiOff + text-s-crit', () => {
    const tree = render(feed({ type: 'connection', state: 'disconnected' }));
    expect(tree.type).toBe(WifiOff);
    expect(String(tree.props.className)).toContain('text-s-crit');
  });

  it('statusCode without reconnecting → WifiOff + text-s-crit', () => {
    const tree = render(feed({ type: 'connection', statusCode: 401 }));
    expect(tree.type).toBe(WifiOff);
    expect(String(tree.props.className)).toContain('text-s-crit');
  });

  it('reconnecting=true → Plug + text-s-warn (precedence over connecting state)', () => {
    const tree = render(feed({ type: 'connection', reconnecting: true, state: 'connecting' }));
    expect(tree.type).toBe(Plug);
    expect(String(tree.props.className)).toContain('text-s-warn');
  });

  it('state="connecting" (no reconnect) → Plug + text-t4', () => {
    const tree = render(feed({ type: 'connection', state: 'connecting' }));
    expect(tree.type).toBe(Plug);
    expect(String(tree.props.className)).toContain('text-t4');
  });

  it('bare connection (no fields) falls through to default Plug + text-t4', () => {
    const tree = render(feed({ type: 'connection' }));
    expect(tree.type).toBe(Plug);
    expect(String(tree.props.className)).toContain('text-t4');
  });
});

describe('FeedIcon — message branch', () => {
  it('direction="inbound" → ArrowDownLeft + text-m-cht', () => {
    const tree = render(feed({ type: 'message', direction: 'inbound' }));
    expect(tree.type).toBe(ArrowDownLeft);
    expect(String(tree.props.className)).toContain('text-m-cht');
  });

  it('direction="outbound" → ArrowUpRight + text-m-agt', () => {
    const tree = render(feed({ type: 'message', direction: 'outbound' }));
    expect(tree.type).toBe(ArrowUpRight);
    expect(String(tree.props.className)).toContain('text-m-agt');
  });
});

describe('FeedIcon — tool/session/health/import branches', () => {
  it('tool_error → AlertTriangle + text-s-crit', () => {
    const tree = render(feed({ type: 'tool_error', toolName: 'x', error: 'e' }));
    expect(tree.type).toBe(AlertTriangle);
    expect(String(tree.props.className)).toContain('text-s-crit');
  });

  it('tool_use → Terminal + text-m-agt', () => {
    const tree = render(feed({ type: 'tool_use', toolName: 'x' }));
    expect(tree.type).toBe(Terminal);
    expect(String(tree.props.className)).toContain('text-m-agt');
  });

  it('session → Terminal + text-m-agt (same icon as tool_use)', () => {
    const tree = render(feed({ type: 'session', action: 'start' }));
    expect(tree.type).toBe(Terminal);
    expect(String(tree.props.className)).toContain('text-m-agt');
  });

  it('health status="online" → HeartPulse + text-s-ok', () => {
    const tree = render(feed({ type: 'health', status: 'online' }));
    expect(tree.type).toBe(HeartPulse);
    expect(String(tree.props.className)).toContain('text-s-ok');
  });

  it('health status="unreachable" → HeartPulse + text-s-crit', () => {
    const tree = render(feed({ type: 'health', status: 'unreachable' }));
    expect(tree.type).toBe(HeartPulse);
    expect(String(tree.props.className)).toContain('text-s-crit');
  });

  it('health status="degraded" (anything else) → HeartPulse + text-s-warn', () => {
    const tree = render(feed({ type: 'health', status: 'degraded' }));
    expect(tree.type).toBe(HeartPulse);
    expect(String(tree.props.className)).toContain('text-s-warn');
  });

  it('import → Database + text-t4', () => {
    const tree = render(feed({ type: 'import' }));
    expect(tree.type).toBe(Database);
    expect(String(tree.props.className)).toContain('text-t4');
  });
});

describe('FeedIcon — icon sizing contract', () => {
  it('every branch passes size=14 strokeWidth=1.75 to the lucide icon', () => {
    const samples: Array<FeedEvent['detail']> = [
      { type: 'connection', state: 'connected' },
      { type: 'message', direction: 'inbound' },
      { type: 'tool_error', toolName: 'x', error: 'e' },
      { type: 'tool_use', toolName: 'x' },
      { type: 'session', action: 'start' },
      { type: 'health', status: 'online' },
      { type: 'import' },
      { type: 'generic' },
    ];
    for (const detail of samples) {
      const tree = render(feed(detail));
      expect(tree.props.size).toBe(14);
      expect(tree.props.strokeWidth).toBe(1.75);
    }
  });
});
