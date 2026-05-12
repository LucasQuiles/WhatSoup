/**
 * Design contract-lock for console/src/components/FeedIcon.tsx.
 *
 * This intentionally pins exact lucide component identity and semantic
 * Tailwind color token per routing path. FeedIcon has no text contract of
 * its own, and icon/color reshuffles are the regression this test catches.
 *
 * No prior test mirror. ReactElement tree inspection only (no DOM/jsdom).
 */
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
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

type IconProps = {
  className?: string;
  size?: number;
  strokeWidth?: number;
};

type IconElement = ReactElement<IconProps>;
type IconComponent = IconElement['type'];

function render(event: FeedEvent): IconElement {
  return (FeedIcon as (props: { event: FeedEvent }) => IconElement)({ event });
}

function feed(detail?: FeedEvent['detail']): FeedEvent {
  const event: FeedEvent = { time: '2026-05-12T00:00:00Z', mode: 'agent', text: 't' };
  if (detail) event.detail = detail;
  return event;
}

const routes: Array<{
  name: string;
  detail?: FeedEvent['detail'];
  icon: IconComponent;
  colorClass: string;
}> = [
  { name: 'missing detail fallback', icon: CircleDot, colorClass: 'text-t5' },
  { name: 'generic detail fallback', detail: { type: 'generic' }, icon: CircleDot, colorClass: 'text-t5' },
  { name: 'connection state="connected"', detail: { type: 'connection', state: 'connected' }, icon: Wifi, colorClass: 'text-s-ok' },
  { name: 'connection state="disconnected"', detail: { type: 'connection', state: 'disconnected' }, icon: WifiOff, colorClass: 'text-s-crit' },
  { name: 'connection statusCode without reconnecting', detail: { type: 'connection', statusCode: 401 }, icon: WifiOff, colorClass: 'text-s-crit' },
  { name: 'connection reconnecting precedence over connecting state', detail: { type: 'connection', reconnecting: true, state: 'connecting' }, icon: Plug, colorClass: 'text-s-warn' },
  { name: 'connection state="connecting"', detail: { type: 'connection', state: 'connecting' }, icon: Plug, colorClass: 'text-t4' },
  { name: 'connection default with no fields', detail: { type: 'connection' }, icon: Plug, colorClass: 'text-t4' },
  { name: 'message direction="inbound"', detail: { type: 'message', direction: 'inbound' }, icon: ArrowDownLeft, colorClass: 'text-m-cht' },
  { name: 'message direction="outbound"', detail: { type: 'message', direction: 'outbound' }, icon: ArrowUpRight, colorClass: 'text-m-agt' },
  { name: 'tool_error', detail: { type: 'tool_error', toolName: 'x', error: 'e' }, icon: AlertTriangle, colorClass: 'text-s-crit' },
  { name: 'tool_use', detail: { type: 'tool_use', toolName: 'x' }, icon: Terminal, colorClass: 'text-m-agt' },
  { name: 'session', detail: { type: 'session', action: 'start' }, icon: Terminal, colorClass: 'text-m-agt' },
  { name: 'health status="online"', detail: { type: 'health', status: 'online' }, icon: HeartPulse, colorClass: 'text-s-ok' },
  { name: 'health status="unreachable"', detail: { type: 'health', status: 'unreachable' }, icon: HeartPulse, colorClass: 'text-s-crit' },
  { name: 'health non-online/non-unreachable status', detail: { type: 'health', status: 'degraded' }, icon: HeartPulse, colorClass: 'text-s-warn' },
  { name: 'import', detail: { type: 'import' }, icon: Database, colorClass: 'text-t4' },
];

describe('FeedIcon — exact icon and color token design contract', () => {
  it.each(routes)('$name routes to $colorClass with shared lucide sizing', ({ detail, icon, colorClass }) => {
    const tree = render(feed(detail));
    expect(tree.type).toBe(icon);
    expect(tree.props.className).toContain(colorClass);
    expect(tree.props.size).toBe(14);
    expect(tree.props.strokeWidth).toBe(1.75);
  });
});
