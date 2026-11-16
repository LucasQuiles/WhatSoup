import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repository guards load the operator's private term file (WHATSOUP_PRIVATE_TERMS_FILE, else
 * ~/.config/whatsoup/private-terms.json) and fail under WHATSOUP_REQUIRE_PRIVATE_TERMS=1 when it
 * is absent. No test may depend on whether a real term file exists on the host:
 * tests/setup/private-terms-isolation.ts points every worker at a path that cannot exist, every
 * subprocess that runs a guard gets privateTermsTestEnv() explicitly, and term tests point the
 * variable at the synthetic fixture instead.
 */
export const ABSENT_PRIVATE_TERMS_FILE = join(
  tmpdir(),
  'whatsoup-vitest-no-private-terms',
  String(process.pid),
  'private-terms.json',
);

export const SYNTHETIC_PRIVATE_TERMS_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'private-terms.synthetic.json',
);

/** The two term-file variables, set explicitly for a guard subprocess. */
export function privateTermsTestEnv(
  termsFile: string = ABSENT_PRIVATE_TERMS_FILE,
): { WHATSOUP_PRIVATE_TERMS_FILE: string; WHATSOUP_REQUIRE_PRIVATE_TERMS: string } {
  return { WHATSOUP_PRIVATE_TERMS_FILE: termsFile, WHATSOUP_REQUIRE_PRIVATE_TERMS: '' };
}
