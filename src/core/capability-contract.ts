/**
 * D1 — instance-declared, versioned capability contract (capability-obligation replay).
 *
 * Deterministic inbound classification producing the typed capability requirement a
 * managed-loop turn could not satisfy. Exactly three rule kinds are permitted:
 *
 *  - `leading_token`: the trimmed input's first whitespace-delimited token equals the
 *    declared token exactly;
 *  - `url_host`: some whitespace-delimited token parses as an HTTP/HTTPS WHATWG URL
 *    whose lower-cased `hostname` exactly equals an allowlist member. No suffix
 *    matching. URLs carrying userinfo, non-HTTP(S) schemes, and unparseable tokens are
 *    ignored (they can never match);
 *  - `media_class`: the prepared-media class equals a declared class. `audio` is
 *    excluded BY CONSTRUCTION — WhatSoup transcribes audio in-process
 *    (media-prep.ts), so audio never implies a missing child-process capability.
 *
 * Evaluation is fail-closed: zero matching rules → `no_match`; two or more matching
 * rules → `conflict` (no dispatchable requirement; the caller records a typed audit
 * decision). A single match yields the persisted decision fields required by D1:
 * contract version, rule id/kind, normalized match value, capability, input digest.
 *
 * This module is pure (no I/O, no clock): the same contract and input always produce
 * the same decision, which is what makes the persisted decision auditable and the
 * attestation binding (D5) meaningful.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Lower-case DNS hostname: labels of [a-z0-9-], dot-separated, no scheme/port/path. */
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

const capabilityNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, 'capability must be a lower_snake identifier');
const ruleIdSchema = z.string().min(1).max(64);

const leadingTokenRuleSchema = z.object({
  id: ruleIdSchema,
  kind: z.literal('leading_token'),
  token: z.string().regex(/^\/[a-z0-9][a-z0-9_-]*$/, 'token must be a /command form'),
  capability: capabilityNameSchema,
});

const urlHostRuleSchema = z.object({
  id: ruleIdSchema,
  kind: z.literal('url_host'),
  hosts: z.array(z.string().regex(HOST_RE, 'hosts must be bare lower-case hostnames')).nonempty(),
  capability: capabilityNameSchema,
});

/** `audio` is deliberately unrepresentable — see module doc. */
const mediaClassRuleSchema = z.object({
  id: ruleIdSchema,
  kind: z.literal('media_class'),
  mediaClass: z.enum(['document', 'video']),
  capability: capabilityNameSchema,
});

const contractSchema = z
  .object({
    version: z.string().min(1).max(128),
    rules: z.array(z.discriminatedUnion('kind', [leadingTokenRuleSchema, urlHostRuleSchema, mediaClassRuleSchema])),
  })
  .superRefine((contract, ctx) => {
    const seen = new Set<string>();
    for (const rule of contract.rules) {
      if (seen.has(rule.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate rule id: ${rule.id}` });
      }
      seen.add(rule.id);
    }
  });

export type CapabilityContract = z.infer<typeof contractSchema>;
export type CapabilityContractRule = CapabilityContract['rules'][number];

export interface CapabilityContractInput {
  /** The prepared turn text (post media-prep conversion), as persisted. */
  text: string;
  /** Prepared-media class of the inbound, when any ('audio' can never match). */
  preparedMediaClass?: string | null;
}

export type CapabilityRequirementDecision =
  | {
      outcome: 'match';
      contractVersion: string;
      ruleId: string;
      ruleKind: CapabilityContractRule['kind'];
      capability: string;
      /** Privacy-safe: the token, the matched hostname, or the media class — never the full input. */
      normalizedMatchValue: string;
      /** Canonical execution source (matched URL token / post-token remainder); null for media rules. */
      sourceToken: string | null;
      inputDigest: string;
    }
  | { outcome: 'no_match'; contractVersion: string; inputDigest: string }
  | {
      outcome: 'conflict';
      contractVersion: string;
      ruleIds: string[];
      capabilities: string[];
      inputDigest: string;
    };

/** Parse and validate a raw contract. Throws ZodError on any shape violation. */
export function parseCapabilityContract(raw: unknown): CapabilityContract {
  return contractSchema.parse(raw);
}

/** sha256 hex binding a decision to its exact evaluated input. */
export function capabilityInputDigest(input: CapabilityContractInput): string {
  return createHash('sha256')
    .update(`${input.text}\n${input.preparedMediaClass ?? ''}`)
    .digest('hex');
}

interface RuleMatch {
  rule: CapabilityContractRule;
  normalizedMatchValue: string;
  /**
   * The canonical SOURCE the capability must execute against: the exact
   * matched URL token for url_host rules; the post-token remainder for
   * leading_token rules; null for media_class rules (the retained media digest
   * is the source identity there). D6 receipts must reproduce a digest of this
   * from the execution result's structured evidence.
   */
  sourceToken: string | null;
}

function matchLeadingToken(rule: Extract<CapabilityContractRule, { kind: 'leading_token' }>, text: string): RuleMatch | undefined {
  const trimmed = text.trim();
  const first = trimmed.split(/\s+/, 1)[0] ?? '';
  if (first !== rule.token) return undefined;
  const remainder = trimmed.slice(first.length).trim();
  return { rule, normalizedMatchValue: rule.token, sourceToken: remainder };
}

function matchUrlHost(rule: Extract<CapabilityContractRule, { kind: 'url_host' }>, text: string): RuleMatch | undefined {
  const allow = new Set(rule.hosts);
  for (const token of text.split(/\s+/)) {
    if (!/^https?:\/\//i.test(token)) continue;
    let url: URL;
    try {
      url = new URL(token);
    } catch {
      continue; // invalid URL tokens can never match
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (url.username !== '' || url.password !== '') continue; // userinfo is never accepted
    const hostname = url.hostname.toLowerCase();
    if (allow.has(hostname)) return { rule, normalizedMatchValue: hostname, sourceToken: token };
  }
  return undefined;
}

function matchMediaClass(rule: Extract<CapabilityContractRule, { kind: 'media_class' }>, mediaClass: string | null | undefined): RuleMatch | undefined {
  return mediaClass === rule.mediaClass
    ? { rule, normalizedMatchValue: rule.mediaClass, sourceToken: null }
    : undefined;
}

/**
 * Evaluate the contract against one prepared inbound. Pure and total: never throws on
 * input content. Multi-match is a `conflict` (fail-closed — the operator adjudicates),
 * including matches that agree on the capability.
 */
export function evaluateCapabilityContract(
  contract: CapabilityContract,
  input: CapabilityContractInput,
): CapabilityRequirementDecision {
  const inputDigest = capabilityInputDigest(input);
  const matches: RuleMatch[] = [];
  for (const rule of contract.rules) {
    let match: RuleMatch | undefined;
    switch (rule.kind) {
      case 'leading_token':
        match = matchLeadingToken(rule, input.text);
        break;
      case 'url_host':
        match = matchUrlHost(rule, input.text);
        break;
      case 'media_class':
        match = matchMediaClass(rule, input.preparedMediaClass);
        break;
    }
    if (match) matches.push(match);
  }

  if (matches.length === 0) {
    return { outcome: 'no_match', contractVersion: contract.version, inputDigest };
  }
  if (matches.length > 1) {
    return {
      outcome: 'conflict',
      contractVersion: contract.version,
      ruleIds: matches.map((m) => m.rule.id),
      capabilities: [...new Set(matches.map((m) => m.rule.capability))],
      inputDigest,
    };
  }
  const only = matches[0]!;
  return {
    outcome: 'match',
    contractVersion: contract.version,
    ruleId: only.rule.id,
    ruleKind: only.rule.kind,
    capability: only.rule.capability,
    normalizedMatchValue: only.normalizedMatchValue,
    sourceToken: only.sourceToken,
    inputDigest,
  };
}

/**
 * The digest a D6 receipt must reproduce from execution evidence: the retained
 * media sha256 for media obligations, else sha256 of the canonical source
 * token. Computed independently on both sides — from the persisted inbound at
 * creation, and from the resolver's structured evidence at receipt time.
 */
export function capabilitySourceDigest(
  sourceToken: string | null,
  mediaSha256: string | null,
): string {
  if (mediaSha256 !== null) return mediaSha256;
  return createHash('sha256').update(sourceToken ?? '').digest('hex');
}

// ── Instance activation options (`agentOptions.capabilityObligations`) ───────
//
// The whole obligation feature is ALL-OR-INERT: absent config, or anything not
// explicitly `enabled: true`, yields null and no runtime surface activates.
// `enabled: true` with a malformed body throws at config load — a partially
// valid activation must never run.

const attestationExpectationSchema = z.object({
  /** Expected installed-skill identity the D5 attestation must match exactly. */
  skillName: z.string().min(1),
  skillVersion: z.string().min(1).nullable().default(null),
  skillDigest: z.string().min(1),
  resolverDigest: z.string().min(1).nullable().default(null),
  dependencyVersions: z.record(z.string(), z.string()).default({}),
  probeVersion: z.string().min(1),
  canaryId: z.string().min(1),
});

/**
 * What counts as capability EXECUTION for D6 receipts. Loading a skill is not
 * execution: the receipt records only an invocation of the declared execution
 * tool whose input carries the declared marker, and an 'ok' result additionally
 * requires the declared minimum of output evidence.
 */
const receiptRuleSchema = z.object({
  /** Provider tool whose invocation IS capability execution (e.g. 'Bash'). */
  toolName: z.string().min(1),
  /** Substring that must appear in a string field of the invocation input. */
  commandMarker: z.string().min(1),
  /** Minimum non-error output bytes for an 'ok' receipt. */
  minOutputBytes: z.number().int().positive(),
  /**
   * Structured-evidence marker the resolver EMITS in its result (e.g.
   * 'WATCH_EVIDENCE:'). The remainder of that line must be JSON carrying the
   * observed `source` (and `mediaSha256` for media work); the receipt's source
   * digest is DERIVED from it — never inferred from shell text.
   */
  evidenceMarker: z.string().min(1),
});

const capabilityObligationsOptionsSchema = z.object({
  enabled: z.literal(true),
  contract: contractSchema,
  /** Obligation-owned retained-media root (D3); also a D5 binding field. */
  mediaRoot: z.string().min(1),
  retentionPolicyVersion: z.string().min(1),
  /**
   * Finite retained-media horizon (A-08): media-carrying obligations older
   * than this are no longer claimable and their retained bytes become
   * GC-eligible. Bounded by construction — indefinite retention is
   * unrepresentable.
   */
  retentionHorizonDays: z.number().int().positive().max(365),
  receipt: receiptRuleSchema,
  attestation: attestationExpectationSchema,
});

export type CapabilityObligationsOptions = z.infer<typeof capabilityObligationsOptionsSchema>;

export function parseCapabilityObligationsOptions(raw: unknown): CapabilityObligationsOptions | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || (raw as { enabled?: unknown }).enabled !== true) return null;
  return capabilityObligationsOptionsSchema.parse(raw);
}
