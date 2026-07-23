/**
 * Evidence reuse: which receipts survive a given drift, decided mechanically (rider P1).
 *
 * `drift-classifier.ts` answers "what changed, and which SENSITIVITY TAGS does that
 * invalidate". This module answers the question an agent actually asks: **"I have these
 * receipts from an earlier run — which of them can I still stand on?"**
 *
 * REUSE, NOT A SECOND MODEL. This repo already has a receipt type —
 * `BoundaryReceipt` in `scripts/lib/semantic-quality/receipt.ts` — carrying `invocation`
 * (what was run) and `base.{baseOid, mergeBaseOid}` (what it was run against). That is
 * everything needed, so nothing here defines a competing receipt shape or mutates that one.
 * This is a pure classification layer over a structure that already exists and is owned
 * elsewhere.
 *
 * THE CENTRAL SAFETY PROPERTY is the default for an unrecognised invocation. The tempting
 * default — treat it as `candidate-only` — is the worst possible one, because
 * `candidate-only` survives every drift class by construction. An unknown receipt would
 * therefore always be reused, which is a false green that grows silently as new invocations
 * are added. The default here is the opposite: maximally sensitive, so an unrecognised
 * receipt is never reused until someone classifies it deliberately.
 */
import {
  DRIFT_MATRIX,
  SENSITIVITY_TAGS,
  receiptSurvives,
  type DriftClass,
  type SensitivityTag,
} from './drift-classifier.ts';

/**
 * Invocation → sensitivity tags, from the rider's worked examples plus this repo's actual
 * gate steps.
 *
 * Matched by prefix on the receipt's `invocation`, longest match first, so
 * `guard:repo:commit-authors` can differ from `guard:repo` without ordering hazards.
 */
/**
 * Shared because two entries below need it verbatim: this repo names lint steps both
 * `lint:*` and `guard:lint:*`, the same dual-convention split that PATH_RULES has for
 * guard scripts. One literal, so the two entries cannot drift apart if one is edited.
 */
const LINT_WHY = 'candidate sources judged by rules that can themselves change';

const INVOCATION_TAGS: ReadonlyArray<{ prefix: string; tags: readonly SensitivityTag[]; why: string }> = [
  // Pure formatters and type checks read only the candidate tree.
  { prefix: 'format', tags: ['candidate-only'], why: 'reads only the candidate tree' },
  {
    prefix: 'typecheck',
    tags: ['candidate-only', 'toolchain-sensitive'],
    why: 'candidate sources, but the compiler version decides the answer',
  },
  {
    prefix: 'lint',
    tags: ['candidate-only', 'policy-sensitive'],
    why: LINT_WHY,
  },
  {
    prefix: 'guard:lint',
    tags: ['candidate-only', 'policy-sensitive'],
    why: LINT_WHY,
  },
  // Anything comparing against the repo's own tree depends on the base.
  {
    prefix: 'guard:doc',
    tags: ['base-sensitive'],
    why: 'resolves cross-document references against the tree',
  },
  {
    prefix: 'guard:public-surface',
    tags: ['base-sensitive', 'policy-sensitive'],
    why: 'compares the live surface against a registry that is itself policy',
  },
  {
    prefix: 'guard:repo',
    tags: ['base-sensitive', 'policy-sensitive'],
    why: 'scans tree content against hygiene rules',
  },
  {
    prefix: 'guard:branch-protection',
    tags: ['policy-sensitive'],
    why: 'reads server-side policy only',
  },
  { prefix: 'guard:', tags: ['base-sensitive', 'policy-sensitive'], why: 'a gate check over the tree' },
  {
    prefix: 'install',
    tags: ['base-sensitive', 'toolchain-sensitive'],
    why: 'resolves the dependency graph at a base',
  },
  {
    prefix: 'build',
    tags: ['base-sensitive', 'toolchain-sensitive', 'artifact-sensitive'],
    why: 'produces an artifact from base sources with a pinned toolchain',
  },
  {
    prefix: 'test:unit',
    tags: ['candidate-only', 'toolchain-sensitive'],
    why: 'isolated package unit test',
  },
  {
    prefix: 'integration',
    tags: ['merge-sensitive'],
    why: 'exercises the integrated result, so it dies with any change to the merge',
  },
  {
    prefix: 'coverage:check',
    tags: ['merge-sensitive', 'toolchain-sensitive'],
    why: 'full suite over the integrated tree',
  },
  {
    prefix: 'release',
    tags: ['merge-sensitive', 'policy-sensitive', 'toolchain-sensitive', 'artifact-sensitive'],
    why: 'release artifact — depends on the merge, the policy that authorised it, and the toolchain',
  },
];

/** Everything except `candidate-only`: the fail-closed default for an unknown invocation. */
export const MAXIMALLY_SENSITIVE: readonly SensitivityTag[] = SENSITIVITY_TAGS.filter(
  (t) => t !== 'candidate-only',
);

export interface TagResolution {
  tags: readonly SensitivityTag[];
  /** False when no rule matched and the fail-closed default was applied. */
  recognised: boolean;
  why: string;
}

/**
 * Sensitivity tags for an invocation.
 *
 * An unrecognised invocation resolves to `MAXIMALLY_SENSITIVE`, never to `candidate-only`.
 * The asymmetry is deliberate: over-tagging costs one unnecessary re-run, while under-tagging
 * reuses evidence that no longer holds — and the `candidate-only` default would under-tag
 * every single time, since that tag survives all drift by construction.
 */
export function tagsForInvocation(invocation: string): TagResolution {
  const matches = INVOCATION_TAGS.filter((r) => invocation.startsWith(r.prefix)).sort(
    (a, b) => b.prefix.length - a.prefix.length,
  );
  const best = matches[0];
  if (!best) {
    return {
      tags: MAXIMALLY_SENSITIVE,
      recognised: false,
      why: `unrecognised invocation "${invocation}" — treated as maximally sensitive rather than reusable`,
    };
  }
  return { tags: best.tags, recognised: true, why: best.why };
}

/** The subset of `BoundaryReceipt` this module needs. Structural, so it does not couple to that module. */
export interface ReusableReceiptLike {
  invocation: string;
  base?: { baseOid?: string | null; mergeBaseOid?: string | null } | null;
}

export interface ReuseDecision {
  invocation: string;
  reusable: boolean;
  tags: readonly SensitivityTag[];
  /** True when the invocation matched no rule and the fail-closed default applied. */
  recognised: boolean;
  reason: string;
}

/**
 * Can this receipt still be stood on, given that the base drifted by `drift`?
 *
 * A receipt with no recorded base is NEVER reusable, regardless of tags: without knowing
 * what it was earned against, "has the base drifted since" is unanswerable, and an
 * unanswerable question must not resolve to yes.
 */
export function reuseDecision(receipt: ReusableReceiptLike, drift: DriftClass): ReuseDecision {
  const { tags, recognised, why } = tagsForInvocation(receipt.invocation);
  const hasBase = Boolean(receipt.base?.baseOid ?? receipt.base?.mergeBaseOid);

  if (!hasBase) {
    return {
      invocation: receipt.invocation,
      reusable: false,
      tags,
      recognised,
      reason: 'receipt records no base OID, so drift relative to it cannot be evaluated',
    };
  }

  const survives = receiptSurvives(tags, drift);
  return {
    invocation: receipt.invocation,
    reusable: survives,
    tags,
    recognised,
    reason: survives
      ? `${drift} invalidates [${DRIFT_MATRIX[drift].invalidates.join(', ') || 'nothing'}]; this receipt is tagged [${tags.join(', ')}] — ${why}`
      : `${drift} invalidates [${DRIFT_MATRIX[drift].invalidates.join(', ')}], which overlaps this receipt's tags [${tags.join(', ')}] — ${why}`,
  };
}

export interface ReusePartition {
  reusable: ReuseDecision[];
  mustReEarn: ReuseDecision[];
  /** Decisions that fell back to the maximally-sensitive default — worth surfacing, not hiding. */
  unrecognised: ReuseDecision[];
}

/**
 * Split a receipt set into what survives and what must be re-earned.
 *
 * `unrecognised` is reported separately rather than folded into `mustReEarn`. Both are
 * conservative outcomes, but they need different fixes: `mustReEarn` means the work genuinely
 * has to run again, while `unrecognised` means nobody has classified that invocation yet and
 * the pessimism is avoidable.
 */
export function partitionReceipts(
  receipts: readonly ReusableReceiptLike[],
  drift: DriftClass,
): ReusePartition {
  const decisions = receipts.map((r) => reuseDecision(r, drift));
  return {
    reusable: decisions.filter((d) => d.reusable),
    mustReEarn: decisions.filter((d) => !d.reusable),
    unrecognised: decisions.filter((d) => !d.recognised),
  };
}
