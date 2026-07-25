/**
 * dream/types (T5 b-06) — the Dream entity per the product model
 * (06-product-model.md §1: a self-suggested persona edit, state machine
 * suggested → queued → approved/rejected → archived).
 *
 * NO dream backend exists today: the page renders an honest empty queue and
 * the anatomy is proven against synthetic fixtures in the test suite. When
 * the Dream API lands, this interface is its console-side shape.
 */

export type DreamKind = 'persona' | 'skills' | 'routine';
export type DreamState = 'queued' | 'approved' | 'rejected';

export interface DreamDiffSection {
  title: string;
  lines: Array<{ kind: 'del' | 'add' | 'keep'; text: string }>;
}

export interface Dream {
  id: string;
  agentName: string;
  kind: DreamKind;
  /** one-line summary, e.g. "tone" → card shows "persona — tone" */
  summary: string;
  /** the agent's own italic rationale quote */
  rationale: string;
  suggestedAt: string; // ISO
  instanceLabel: string; // pre-masked provenance label
  state: DreamState;
  diffTarget: string; // e.g. "SOUL.md — persona section"
  diff: DreamDiffSection[];
  impact: { appliesTo: string; reversible: string; risk: string };
}

/** Deterministic hue slot 0..7 for an agent name — same FNV-1a recipe the
 *  Agents surface uses (merge seam: b-04's components/agents/agent-hue.ts is
 *  the canonical home once both beads land). */
export function dreamHueIndex(name: string): number {
  let hash = 0x811c9dc5;
  const text = name.trim().toLowerCase();
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 8;
}

export function dreamInitials(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
