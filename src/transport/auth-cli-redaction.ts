// Implementation moved to src/lib/cli-redaction.ts so the lib-layer CLI print
// seam (src/lib/cli-print.ts) can reuse it without a lib->transport boundary
// violation (#2209). This shim keeps existing transport-side importers stable.
export { redactAuthCliText } from '../lib/cli-redaction.ts';
