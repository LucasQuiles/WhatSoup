import { z } from 'zod';

export const CONTROL_PREFIXES = [
  '[LOOPS_HEAL]',
  '[HEAL_COMPLETE]',
  '[HEAL_ESCALATE]',
] as const;

export type ControlProtocol = 'LOOPS_HEAL' | 'HEAL_COMPLETE' | 'HEAL_ESCALATE';

export function isControlPrefix(text: string): boolean {
  return CONTROL_PREFIXES.some(p => text.startsWith(p));
}

export function extractProtocol(content: string): ControlProtocol | null {
  if (content.startsWith('[LOOPS_HEAL]')) return 'LOOPS_HEAL';
  if (content.startsWith('[HEAL_COMPLETE]')) return 'HEAL_COMPLETE';
  if (content.startsWith('[HEAL_ESCALATE]')) return 'HEAL_ESCALATE';
  return null;
}

export function extractPayload(content: string): unknown {
  const jsonMatch = content.match(/^\[[A-Z_]+\]\s*(\{[\s\S]*\})$/);
  if (!jsonMatch) return null;

  try {
    return JSON.parse(jsonMatch[1]);
  } catch {
    return null;
  }
}

export const LoopsHealPayloadSchema = z.object({
  reportId: z.string(),
  type: z.enum(['crash', 'degraded', 'service_crash']),
  errorClass: z.string(),
  attempt: z.number(),
  maxAttempts: z.number(),
  timestamp: z.string(),
  chatJid: z.string().optional(),
  exitCode: z.number().optional(),
  signal: z.string().nullable().optional(),
  stderr: z.string().optional(),
  recentLogs: z.string().optional(),
});
export type LoopsHealPayload = z.infer<typeof LoopsHealPayloadSchema>;

export const HealCompletePayloadSchema = z.object({
  reportId: z.string(),
  errorClass: z.string(),
  result: z.enum(['fixed', 'escalate']),
  commitSha: z.string().optional(),
  diagnosis: z.string(),
});
export type HealCompletePayload = z.infer<typeof HealCompletePayloadSchema>;

export const EmitHealResultSchema = z.object({
  reportId: z.string(),
  errorClass: z.string(),
  result: z.enum(['fixed', 'escalate']),
  commitSha: z.string().optional(),
  diagnosis: z.string(),
});
export type EmitHealResult = z.infer<typeof EmitHealResultSchema>;

export function normalizeErrorClass(type: string, errorHint: string): string {
  const normalized = errorHint
    .replace(/:\d+/g, '')
    .replace(/pid[=:]\d+/g, '')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, '')
    .replace(/0x[0-9a-f]+/gi, '')
    .trim()
    .slice(0, 200);
  const firstLine = (normalized.split('\n')[0] ?? 'unknown')
    .replace(/\W+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);

  return `${type}__${firstLine || 'unknown'}`;
}
