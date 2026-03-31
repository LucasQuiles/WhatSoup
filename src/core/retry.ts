/** Full jitter: delay = base * 2^attempt * random(0.75, 1.25), capped at maxMs */
export function jitteredDelay(baseMs: number, attempt: number, maxMs = 30_000): number {
  const exp = baseMs * Math.pow(2, attempt);
  const capped = Math.min(exp, maxMs);
  return capped * (0.75 + Math.random() * 0.5);
}
