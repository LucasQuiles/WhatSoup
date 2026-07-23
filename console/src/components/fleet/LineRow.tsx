/**
 * LineRow (T5 b-03) — the v3.5 single-line anatomy (mockup fleet.html tbody):
 * status shape | line identity | channel glyph+tag | agent | mode | state
 * pill | grant chips | 7d sparkbar | row menu. Rendered on the Table
 * primitives (soup/no-raw-table law); fleet.css owns the v3.5 register.
 *
 * Derivations (documented in the b-03 PR):
 *  - Agent cell: no Agent entity exists yet (b-04 track) — every line renders
 *    the mockup's honest "unassigned" state.
 *  - Grants: no Grant API yet — every line renders the R3-13 hidden-by-default
 *    chip until b-04 lands the real grant model.
 *  - The leading shape cell doubles as the bulk-select reveal on row
 *    hover/focus (progressive disclosure; the mockup has no checkbox column
 *    and bulk lifecycle ops are a carried feature).
 */
import type { FC, RefObject } from 'react';
import type { LineInstance } from '../../types';
import { displayInstanceName, formatPhone } from '../../lib/text-utils';
import { formatRelative } from '../../lib/format-time';
import { statusSeverity } from '../../lib/status-severity';
import { isLineConnected } from '../../lib/compute-kpis';
import { Checkbox, TableRow, TableCell, type RowSeverity } from '../primitives';
import FleetRowMenu from '../FleetRowMenu';
import { ChannelGlyph, type ChannelTag } from './ChannelGlyph';
import { channelKindOf, type ChannelKind } from './channel-kind';
import { LineSpark } from './LineSpark';

interface LineRowProps {
  line: LineInstance;
  current: boolean;
  selected: boolean;
  canManage: boolean;
  onActivate: (name: string) => void;
  onToggleSelected: (name: string, next: boolean) => void;
  rowRef?: RefObject<HTMLElement | null>;
}

const CHANNEL_LABEL: Record<ChannelKind, string> = {
  wa: 'WhatsApp',
  signal: 'Signal',
  imessage: 'iMessage',
  sms: 'SMS',
  discord: 'Discord',
  telegram: 'Telegram',
  x: 'X',
  linkedin: 'LinkedIn',
  reddit: 'Reddit',
  instagram: 'Instagram',
  facebook: 'Facebook',
  email: 'Email',
  slack: 'Slack',
  teams: 'Teams',
};

function channelTagOf(line: LineInstance): { tag: ChannelTag; label: string } {
  if (isLineConnected(line)) return { tag: 'ok', label: 'connected' };
  const sev = statusSeverity(line.status);
  if (sev === 'crit') return { tag: 'crit', label: 'error' };
  if (sev === 'warn') return { tag: 'warn', label: 'degraded' };
  return { tag: 'off', label: 'disconnected' };
}

/** Mockup .badge mapping — real Status values, never the spec-future
 *  "deactivated" (no such backend state exists yet; R2-11 lands with b-04). */
function statePillOf(line: LineInstance): { cls: string; label: string } {
  if (isLineConnected(line)) return { cls: 'fleet-state--live', label: 'live' };
  const sev = statusSeverity(line.status);
  if (sev === 'crit') return { cls: 'fleet-state--crit', label: line.status.replace('_', ' ') };
  if (sev === 'warn') return { cls: 'fleet-state--warn', label: 'degraded' };
  return { cls: 'fleet-state--off', label: line.status.replace('_', ' ') };
}

/** Status shape per the shape law (disc ok / diamond warn / square crit),
 *  with the #1762 rider: a stale ONLINE line renders the warn diamond, never
 *  the fresh disc — the carried-forward body must not read as proven-healthy.
 *  The outline slot stays reserved for the deactivated state (R2-11, b-04). */
function shapeClassOf(line: LineInstance): string {
  if (line.stale && line.status === 'online') return 'fleet-shape fleet-shape--diamond';
  const sev = statusSeverity(line.status);
  if (sev === 'crit') return 'fleet-shape fleet-shape--square';
  if (sev === 'warn') return 'fleet-shape fleet-shape--diamond';
  return 'fleet-shape fleet-shape--disc';
}

function severityOf(line: LineInstance): RowSeverity | undefined {
  const sev = statusSeverity(line.status);
  if (sev === 'crit') return 'crit';
  if (sev === 'warn') return 'warn';
  return undefined;
}

export const LineRow: FC<LineRowProps> = ({
  line,
  current,
  selected,
  canManage,
  onActivate,
  onToggleSelected,
  rowRef,
}) => {
  const kind = channelKindOf(line);
  const { tag, label: tagLabel } = channelTagOf(line);
  const pill = statePillOf(line);

  return (
    <TableRow
      interactive
      severity={severityOf(line)}
      current={current}
      className={selected ? 'fleet-row--selected' : undefined}
      ref={
        current
          ? (el) => {
              if (el && rowRef) rowRef.current = el;
            }
          : undefined
      }
      onActivate={() => onActivate(line.name)}
    >
      {/* Shape / bulk-select reveal */}
      <TableCell onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <span className="fleet-shapewrap">
          <span className={shapeClassOf(line)} aria-hidden="true" />
          {canManage && (
            <span className={`fleet-select${selected ? ' fleet-select--on' : ''}`}>
              <Checkbox
                checked={selected}
                onChange={(next) => onToggleSelected(line.name, next)}
                label={`Select ${displayInstanceName(line.name)}`}
              />
            </span>
          )}
        </span>
      </TableCell>
      {/* Line identity (+ #1877 observation-age marker) */}
      <TableCell>
        <span className="fleet-lcell">
          <span className="fleet-lname">{displayInstanceName(line.name)}</span>
          <span className="fleet-lid">{formatPhone(line.phone)}</span>
        </span>
        {(line.stale || line.healthObservedAt) && (
          <span
            className={`fleet-obs${line.stale ? ' warn' : ''}`}
            title={
              line.stale
                ? (line.healthObservedAt
                    ? `Health carried forward — last live poll ${formatRelative(line.healthObservedAt)}`
                    : 'Health data is stale — the poller is currently failing')
                : `Last live health poll ${formatRelative(line.healthObservedAt)}`
            }
          >
            {line.stale
              ? `stale · ${line.healthObservedAt ? formatRelative(line.healthObservedAt) : 'unknown'}`
              : `observed ${formatRelative(line.healthObservedAt)}`}
          </span>
        )}
      </TableCell>
      {/* Channel glyph + state tag */}
      <TableCell>
        <ChannelGlyph
          kind={kind}
          tag={tag}
          title={`${CHANNEL_LABEL[kind]} · ${tagLabel}`}
        />
      </TableCell>
      {/* Agent — no Agent entity until b-04; the mockup's honest state */}
      <TableCell>
        <span className="fleet-noagent">unassigned</span>
      </TableCell>
      {/* Mode */}
      <TableCell>
        <span className={`fleet-mode fleet-mode--${line.mode}`}>
          <i aria-hidden="true" />
          {line.mode}
        </span>
      </TableCell>
      {/* State pill */}
      <TableCell>
        <span className={`fleet-state ${pill.cls}`}>{pill.label}</span>
      </TableCell>
      {/* Grants — R3-13 hidden-by-default until the Grant API (b-04) */}
      <TableCell>
        <span className="fleet-grants" title="Grants: hidden by default (R3-13) — the Grant model lands with b-04">
          <span className="fleet-grant fleet-grant--hid">H</span>
        </span>
      </TableCell>
      {/* 7d sparkbar — lazy per-row series */}
      <TableCell>
        <LineSpark name={line.name} />
      </TableCell>
      {/* Row menu */}
      <TableCell onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <FleetRowMenu name={line.name} canAct={canManage} />
      </TableCell>
    </TableRow>
  );
};
