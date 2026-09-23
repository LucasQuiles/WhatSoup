// src/lib/clopper-pearson.ts
// One-sided Clopper–Pearson (exact binomial) upper confidence bound. Pure and
// dependency-free: the bound is found by bisection on the exact binomial CDF,
// whose terms are computed in log space through a Lanczos log-gamma.

// Lanczos coefficients (g = 7, n = 9); relative error below 1e-15 for x >= 1,
// the only range the binomial terms below need.
const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
] as const;
const HALF_LOG_TWO_PI = 0.5 * Math.log(2 * Math.PI);
const BISECTION_STEPS = 200;

function logGamma(x: number): number {
  const z = x - 1;
  let sum = LANCZOS_COEFFICIENTS[0];
  for (let i = 1; i < LANCZOS_COEFFICIENTS.length; i += 1) sum += LANCZOS_COEFFICIENTS[i]! / (z + i);
  const t = z + LANCZOS_G + 0.5;
  return HALF_LOG_TWO_PI + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** P(X <= x) for X ~ Binomial(n, p), with 0 < p < 1. */
function binomialCdf(x: number, n: number, p: number): number {
  const logP = Math.log(p);
  const logQ = Math.log1p(-p);
  const logNFactorial = logGamma(n + 1);
  const logTerms: number[] = [];
  let max = -Infinity;
  for (let k = 0; k <= x; k += 1) {
    const term = logNFactorial - logGamma(k + 1) - logGamma(n - k + 1) + k * logP + (n - k) * logQ;
    logTerms.push(term);
    if (term > max) max = term;
  }
  let sum = 0;
  for (const term of logTerms) sum += Math.exp(term - max);
  return Math.min(1, Math.exp(max + Math.log(sum)));
}

/**
 * One-sided upper `1 - alpha` Clopper–Pearson bound for `x` successes in `n`
 * trials: the largest p with P(X <= x; n, p) >= alpha. Returns null when
 * n = 0 (no evidence, so no bound).
 */
export function clopperPearsonUpper(x: number, n: number, alpha = 0.05): number | null {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('n must be a non-negative safe integer');
  if (!Number.isSafeInteger(x) || x < 0 || x > n) throw new RangeError('x must be an integer in [0, n]');
  if (!(alpha > 0 && alpha < 1)) throw new RangeError('alpha must be in (0, 1)');
  if (n === 0) return null;
  if (x === n) return 1;
  if (x === 0) return 1 - alpha ** (1 / n);
  // The CDF falls monotonically in p; the bound lies above the point estimate.
  // `hi` always satisfies CDF <= alpha, so returning it never understates the bound.
  let lo = x / n;
  let hi = 1;
  for (let i = 0; i < BISECTION_STEPS && hi - lo > 1e-15; i += 1) {
    const mid = (lo + hi) / 2;
    if (binomialCdf(x, n, mid) > alpha) lo = mid;
    else hi = mid;
  }
  return hi;
}
