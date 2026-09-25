import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Round 8. The guard's reader call used an UNQUALIFIED `catch (err)`, so ANY
// throw became a `reader-rejected` finding. A genuine reader BUG (TypeError,
// RangeError) was therefore indistinguishable from a contract-data defect: the
// guard would report "the governed data is bad" while the real fault was in our
// own code, and a CI reader regression would surface as a data problem.
//
// This lives in its own file because the assertion requires mocking the reader
// module, which must not affect the other guard tests.
//
// Round 7's guard-path test could not express this: it passed before AND after
// that fix, precisely because the TypeError was being absorbed. Here the
// absorbed-vs-propagated distinction IS the assertion, so the test fails
// against the old unqualified catch.
// Hoisted so the ONE injected instance is addressable from the assertion below.
// `toThrow(new RangeError(msg))` compares name and message only — it would pass
// against any same-message RangeError, including one the guard manufactured
// itself. Object identity is the assertion that actually proves the original
// error object travelled through untouched.
const injectedReaderBug = vi.hoisted(
  () => new RangeError('simulated reader bug — NOT a contract-data defect'),
);

vi.mock('../../scripts/lib/observation-contract.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../scripts/lib/observation-contract.ts')>();
  return {
    ...actual,
    buildObservationContract: () => {
      throw injectedReaderBug;
    },
  };
});

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('observation contract guard — error taxonomy', () => {
  it('propagates a non-contract reader error instead of recording reader-rejected', async () => {
    const { checkObservationContract } = await import(
      '../../scripts/observation-contract-guard.ts'
    );

    // The committed contract data is valid, so the ONLY error in play is the
    // injected reader bug. It must escape as a harness failure — the very same
    // object, not merely "something with that message".
    //
    // Under the old unqualified catch this call RETURNED a result whose
    // findings contained `reader-rejected` and nothing was thrown, so `caught`
    // stays undefined and every assertion below fails: the
    // absorbed-vs-propagated distinction is what this asserts.
    let caught: unknown = undefined;
    try {
      checkObservationContract(repoRoot);
    } catch (err) {
      caught = err;
    }

    expect(
      caught,
      'a non-contract reader error must propagate as a harness failure, not become a contract finding',
    ).toBe(injectedReaderBug);
    expect(caught, 'the propagated error must keep its own class').toBeInstanceOf(RangeError);
  });
});
