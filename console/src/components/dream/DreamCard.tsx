import type { CSSProperties, FC } from 'react';
import { Button } from '../primitives/Button';
import { dreamHueIndex, dreamInitials, type Dream } from './types';

export const DreamAvatar: FC<{ name: string; size?: 'sm' | 'lg' }> = ({ name, size = 'sm' }) => {
  const style: CSSProperties = { background: `var(--agent-hue-${dreamHueIndex(name)})` };
  return (
    <span className={`dream-av${size === 'lg' ? ' dream-av--lg' : ''}`} style={style} aria-hidden="true">
      {dreamInitials(name)}
    </span>
  );
};

interface DreamCardProps {
  dream: Dream;
  selected: boolean;
  onSelect: (id: string) => void;
  whenLabel: string;
}

/** Queue card (mockup .dcard): sm avatar + name + "kind — summary" + type tag
 *  + italic rationale + suggestion provenance line. */
export const DreamCard: FC<DreamCardProps> = ({ dream, selected, onSelect, whenLabel }) => (
  <Button
    variant="ghost"
    className={`dream-dcard${selected ? ' dream-dcard--sel' : ''}`}
    aria-pressed={selected}
    onClick={() => onSelect(dream.id)}
  >
    <span className="dream-dcard__top">
      <DreamAvatar name={dream.agentName} />
      <span className="dream-dcard__nameblock">
        <span className="dream-dcard__nm">{dream.agentName}</span>
        <span className="dream-dcard__what">
          {dream.kind} — {dream.summary}
        </span>
      </span>
      <span className={`dream-dtag dream-dtag--${dream.kind}`}>{dream.kind}</span>
    </span>
    <span className="dream-dcard__why">
      “{dream.rationale}”
    </span>
    <span className="dream-dcard__when">
      suggested {whenLabel} · instance <span className="dream-inst">{dream.instanceLabel}</span>
    </span>
  </Button>
);
