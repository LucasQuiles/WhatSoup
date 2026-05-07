export interface TypingHealthEntry {
  jid: string;
  since: number;
}

export function isTypingHealthEntry(entry: unknown): entry is TypingHealthEntry {
  if (!entry || typeof entry !== 'object') return false;

  const candidate = entry as { jid?: unknown; since?: unknown };
  return (
    typeof candidate.jid === 'string'
    && candidate.jid.trim().length > 0
    && typeof candidate.since === 'number'
    && Number.isFinite(candidate.since)
  );
}
