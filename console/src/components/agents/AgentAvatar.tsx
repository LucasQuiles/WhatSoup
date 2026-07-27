import type { CSSProperties, FC } from 'react';
import { agentHueIndex, agentInitials, PRESENCE_LABEL, type AgentPresenceKind } from './agent-hue';

export type AgentPresence = AgentPresenceKind;

interface AgentAvatarProps {
  name: string;
  /** xl = 56px detail-head slot; default = 34px roster-card slot
   *  (12-agent-identity §2 size slots). */
  size?: 'md' | 'xl';
}

/** Agent avatar — locked 8-hue fill + white initials (12-agent-identity §1),
 *  hue from the deterministic name hash until hatch stores it (agent-hue.ts).
 *  State markers are separate elements (§1): callers place <AgentPresenceShape>
 *  where the mockup puts them — never baked into the fill. */
export const AgentAvatar: FC<AgentAvatarProps> = ({ name, size = 'md' }) => {
  const hue = agentHueIndex(name);
  const style: CSSProperties = { background: `var(--agent-hue-${hue})` };
  return (
    <span className={`agents-av${size === 'xl' ? ' agents-av--xl' : ''}`} style={style} aria-hidden="true">
      {agentInitials(name)}
    </span>
  );
};

/** The §4 presence shape — disc (live), diamond (paused), hollow square
 *  (draft), recessed outline (deactivated); shape-coded, never color-only. */
export const AgentPresenceShape: FC<{ presence: AgentPresence; labeled?: boolean }> = ({
  presence,
  labeled = true,
}) => (
  <span
    className={`agents-presence agents-presence--${presence}`}
    role={labeled ? 'img' : undefined}
    aria-label={labeled ? PRESENCE_LABEL[presence] : undefined}
    aria-hidden={labeled ? undefined : true}
  />
);
