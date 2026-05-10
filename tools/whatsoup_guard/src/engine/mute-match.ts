import type { Mute } from '../types.ts';

const FORBIDDEN_DOMAINS = new Set(['alerting']);

export interface MuteMatchInput {
  host: string;
  domain: string;
  isRemediation: boolean;
  now: string;
}

export interface MuteMatchResult {
  matched: boolean;
  byMute?: Mute;
  reason?: string;
}

export interface MuteMatchOptions {
  additionalForbiddenDomains?: readonly string[];
}

interface Candidate {
  mute: Mute;
  score: number;
}

export function matchMute(input: MuteMatchInput, candidates: Mute[], options: MuteMatchOptions = {}): MuteMatchResult {
  if (forbiddenDomains(options).has(input.domain)) {
    return { matched: false, reason: 'domain is forbidden from being muted' };
  }

  const matches: Candidate[] = [];
  let sawExpired = false;
  let sawWildcardRemediationBlock = false;

  for (const mute of candidates) {
    if (!hostMatches(input.host, mute.host)) continue;
    if (!domainMatches(input.domain, mute.domain)) continue;

    if (isExpired(mute, input.now)) {
      sawExpired = true;
      continue;
    }

    if (input.isRemediation && mute.domain === '*' && !mute.allow_revert_suppression) {
      sawWildcardRemediationBlock = true;
      continue;
    }

    matches.push({ mute, score: specificityScore(input, mute) });
  }

  const best = matches.sort((a, b) => b.score - a.score || a.mute.id - b.mute.id)[0];
  if (best) {
    return { matched: true, byMute: best.mute, reason: 'mute matched' };
  }

  if (sawWildcardRemediationBlock) {
    return { matched: false, reason: 'wildcard mute does not suppress remediation' };
  }

  if (sawExpired) {
    return { matched: false, reason: 'candidate mute expired' };
  }

  return { matched: false };
}

function forbiddenDomains(options: MuteMatchOptions): Set<string> {
  return new Set([...FORBIDDEN_DOMAINS, ...(options.additionalForbiddenDomains ?? [])]);
}

function hostMatches(inputHost: string, muteHost: string): boolean {
  return muteHost === '*' || muteHost === inputHost;
}

function domainMatches(inputDomain: string, muteDomain: string): boolean {
  return muteDomain === '*' || muteDomain === inputDomain;
}

function isExpired(mute: Mute, now: string): boolean {
  return Date.parse(mute.expires_at) <= Date.parse(now);
}

function specificityScore(input: MuteMatchInput, mute: Mute): number {
  return (mute.host === input.host ? 2 : 0) + (mute.domain === input.domain ? 1 : 0);
}
