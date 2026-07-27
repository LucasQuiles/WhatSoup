import type { FC } from 'react';
import { Button } from '../primitives/Button';
import { AgentAvatar, AgentPresenceShape, type AgentPresence } from './AgentAvatar';

interface RosterCardProps {
  name: string;
  displayName: string;
  presence: AgentPresence;
  /** Honest meta fragments, e.g. ["agent", "2 instances", "active 2m ago"] —
   *  the caller passes only real data; missing data is omitted upstream,
   *  never faked. meta[0] renders as the kind caps line. */
  meta: string[];
  selected: boolean;
  onSelect: (name: string) => void;
}

/** Roster card (mockup .acard): avatar + name + kind caps + trailing presence
 *  shape + meta row. */
export const RosterCard: FC<RosterCardProps> = ({
  name,
  displayName,
  presence,
  meta,
  selected,
  onSelect,
}) => (
  <Button
    variant="ghost"
    className={`agents-acard${selected ? ' agents-acard--sel' : ''}`}
    aria-pressed={selected}
    onClick={() => onSelect(name)}
  >
    <span className="agents-acard__top">
      <AgentAvatar name={displayName} />
      <span className="agents-acard__nameblock">
        <span className="agents-acard__nm">{displayName}</span>
        <span className="agents-acard__kind">
          {meta[0] ?? 'agent'}
        </span>
      </span>
      <span className="agents-acard__stat">
        <AgentPresenceShape presence={presence} labeled={false} />
      </span>
    </span>
    <span className="agents-acard__meta">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1a7 7 0 0 0-6 10.5L1 15l3.6-1A7 7 0 1 0 8 1z" />
      </svg>
      {meta.slice(1).join(' · ')}
    </span>
  </Button>
);
