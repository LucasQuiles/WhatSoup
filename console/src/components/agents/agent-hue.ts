/**
 * agent-hue (T5 b-04) — deterministic avatar hue + initials for agent
 * identity, extracted from AgentAvatar so the component file exports only
 * components (react-refresh/only-export-components).
 *
 * 12-agent-identity.md §1: hue assigned at hatch from the locked 8-hue set,
 * following the agent forever. Hatch-time assignment is not persisted by the
 * runtime yet, so b-04 derives the hue deterministically from the agent name
 * (FNV-1a over the lowercased name) — stable across renders and surfaces,
 * documented deviation until the hatch flow stores it (journey bead b-10).
 */

export const AGENT_HUE_COUNT = 8;

/** FNV-1a 32-bit — tiny, stable, good enough for hue bucketing. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic hue slot 0..7 for an agent name (deviation: see header). */
export function agentHueIndex(name: string): number {
  return fnv1a(name.trim().toLowerCase()) % AGENT_HUE_COUNT;
}

/** 1–2 initials, §1 anatomy: first letters of the first two words, uppercase. */
export function agentInitials(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export type AgentPresenceKind = 'live' | 'paused' | 'draft' | 'deactivated';

export const PRESENCE_LABEL: Record<AgentPresenceKind, string> = {
  live: 'live',
  paused: 'paused',
  draft: 'draft',
  deactivated: 'deactivated',
};
