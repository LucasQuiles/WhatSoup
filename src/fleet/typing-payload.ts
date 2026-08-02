import { z } from 'zod';

export interface TypingHealthEntry {
  jid: string;
  since: number;
}

/**
 * Shape schema for TypingHealthEntry.
 *
 * `.passthrough()` because the previous hand-rolled guard only checked the
 * listed keys — payloads carrying unknown extra keys stay accepted. `jid`
 * uses `.refine()` rather than `.trim()` — `.trim()` is a transform that
 * mutates the parsed output (` x ` → `x`), but callers of `isTypingHealthEntry`
 * do their own trimming downstream and expect the raw string back, so the
 * schema must only test trimmed length without changing the value. `since`
 * uses `.finite()` rather than plain `z.number()`, which accepts
 * Infinity/-Infinity — the previous `Number.isFinite` check rejected both.
 * `satisfies` pins the schema output to the exported wire type at compile
 * time.
 */
const TypingHealthEntrySchema = z.object({
  jid: z.string().refine((s) => s.trim().length > 0),
  since: z.number().finite(),
}).passthrough() satisfies z.ZodType<TypingHealthEntry>;

export function isTypingHealthEntry(entry: unknown): entry is TypingHealthEntry {
  return TypingHealthEntrySchema.safeParse(entry).success;
}
