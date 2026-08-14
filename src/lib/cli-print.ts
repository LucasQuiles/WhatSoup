import { redactAuthCliText } from './cli-redaction.ts';

/**
 * Human-facing CLI channel (#2209). stderr is the human surface — stdout stays
 * reserved for protocol output (the convention src/transport/auth.ts already
 * follows) — and every line passes CLI redaction before it leaves the process.
 * This seam and the logger's own transport-failure fallbacks are the only
 * sanctioned raw writes outside the structured pipeline; the allowlist ratchet
 * at tests/scripts/console-usage-budget.test.ts enforces exactly that.
 */
export function printErr(text: unknown): void {
  process.stderr.write(`${redactAuthCliText(text)}\n`);
}
