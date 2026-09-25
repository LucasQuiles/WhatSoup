import { createPublicKey } from 'node:crypto';
import { asRecord, isNonEmptyString } from '../lib/type-guards.ts';
import { conversationKeyToJid, toConversationKey } from './conversation-key.ts';
import { DEFAULT_TRANSPORT_ID } from './transport-refs.ts';
import {
  CLIENT_OUTPUT_POLICY_ACTIONS,
  countUnicodeCodePoints,
  normalizeClientOutputTermForComparison,
  type ClientOutputBlockedTerm,
  type ClientOutputPolicyAction,
  type ClientOutputPolicyAuthorization,
  type ConfiguredClientOutputPolicy,
} from './client-output-policy-contract.ts';

const POLICY_KEYS = new Set([
  'conversationKey',
  'maxCodePoints',
  'maxQuestionMarks',
  'blockedTerms',
  'rejectInternalArtifacts',
  'rejectWhatsAppJids',
  'authorization',
]);
const TERM_KEYS = new Set(['value', 'match', 'caseSensitive']);
const AUTHORIZATION_KEYS = new Set(['keyId', 'publicKey', 'requiredActions']);
const ACTIONS = new Set<string>(CLIENT_OUTPUT_POLICY_ACTIONS);
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;

export const CLIENT_OUTPUT_POLICY_REDACTION = '[redacted]';

export type ClientOutputPolicyConfigIssue = Readonly<{
  field: string;
  reason: string;
}>;

export interface ClientOutputPolicyRegistry extends ReadonlyMap<string, ConfiguredClientOutputPolicy> {}

export type ClientOutputPolicyParseResult =
  | Readonly<{
      ok: true;
      policies: readonly ConfiguredClientOutputPolicy[];
      registry: ClientOutputPolicyRegistry;
    }>
  | Readonly<{
      ok: false;
      error: ClientOutputPolicyConfigIssue;
    }>;

export type ClientOutputPolicyIdentityResolution =
  | Readonly<{ status: 'resolved'; canonicalConversationKey: string }>
  | Readonly<{ status: 'identity_unresolved' }>;

export type ClientOutputPolicySelection =
  | Readonly<{ status: 'configured'; policy: ConfiguredClientOutputPolicy }>
  | Readonly<{ status: 'unconfigured' }>
  | Readonly<{ status: 'identity_unresolved' }>;

class ReadOnlyClientOutputPolicyRegistry implements ClientOutputPolicyRegistry {
  readonly #policies: Map<string, ConfiguredClientOutputPolicy>;

  constructor(policies: ReadonlyArray<ConfiguredClientOutputPolicy>) {
    this.#policies = new Map(policies.map((policy) => [policy.conversationKey, policy]));
    Object.freeze(this);
  }

  get size(): number {
    return this.#policies.size;
  }

  get(key: string): ConfiguredClientOutputPolicy | undefined {
    return this.#policies.get(key);
  }

  has(key: string): boolean {
    return this.#policies.has(key);
  }

  entries(): MapIterator<[string, ConfiguredClientOutputPolicy]> {
    return this.#policies.entries();
  }

  keys(): MapIterator<string> {
    return this.#policies.keys();
  }

  values(): MapIterator<ConfiguredClientOutputPolicy> {
    return this.#policies.values();
  }

  forEach(
    callbackfn: (
      value: ConfiguredClientOutputPolicy,
      key: string,
      map: ReadonlyMap<string, ConfiguredClientOutputPolicy>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#policies) {
      callbackfn.call(thisArg, value, key, this);
    }
  }

  [Symbol.iterator](): MapIterator<[string, ConfiguredClientOutputPolicy]> {
    return this.entries();
  }
}

function issue(field: string, reason: string): ClientOutputPolicyParseResult {
  return Object.freeze({ ok: false, error: Object.freeze({ field, reason }) });
}

function hasUnknownKey(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function validInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= min
    && value <= max;
}

function hasReachableGroupConversationKey(value: string): boolean {
  if (!value.endsWith('_at_g.us')) return true;
  try {
    return toConversationKey(conversationKeyToJid(value)) === value;
  } catch {
    return false;
  }
}

function validConversationKey(value: unknown): value is string {
  return isNonEmptyString(value)
    && value === value.trim()
    && countUnicodeCodePoints(value) <= 512
    && !CONTROL_RE.test(value)
    && !value.includes('@')
    && value !== '__global__'
    && hasReachableGroupConversationKey(value);
}

function validEd25519PublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  try {
    const der = Buffer.from(value, 'base64url');
    if (der.toString('base64url') !== value) return false;
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const canonical = key.export({ format: 'der', type: 'spki' });
    return Buffer.isBuffer(canonical)
      && canonical.equals(der)
      && canonical.toString('base64url') === value;
  } catch {
    return false;
  }
}

function parseTerm(
  value: unknown,
  field: string,
  identities: Set<string>,
): ClientOutputBlockedTerm | ClientOutputPolicyParseResult {
  const term = asRecord(value);
  if (!term) return issue(field, 'must be an object');
  if (hasUnknownKey(term, TERM_KEYS)) return issue(field, 'contains an unsupported field');

  const rawValue = term['value'];
  if (
    typeof rawValue !== 'string'
    || rawValue.length === 0
    || rawValue !== rawValue.trim()
    || rawValue !== rawValue.normalize('NFC')
    || countUnicodeCodePoints(rawValue) > 128
  ) {
    return issue(`${field}.value`, 'must be NFC-normalized, have no surrounding whitespace, and contain 1 to 128 Unicode code points');
  }
  const match = term['match'];
  if (match !== 'whole_word' && match !== 'substring') {
    return issue(`${field}.match`, 'must be whole_word or substring');
  }
  const caseSensitive = term['caseSensitive'];
  if (typeof caseSensitive !== 'boolean') {
    return issue(`${field}.caseSensitive`, 'must be a boolean');
  }

  const identity = `${match}\u0000${String(caseSensitive)}\u0000${normalizeClientOutputTermForComparison(rawValue, caseSensitive)}`;
  if (identities.has(identity)) return issue(`${field}.value`, 'duplicates an earlier blocked term');
  identities.add(identity);

  return Object.freeze({ value: rawValue, match, caseSensitive });
}

function parseAuthorization(
  value: unknown,
  field: string,
): ClientOutputPolicyAuthorization | ClientOutputPolicyParseResult {
  const authorization = asRecord(value);
  if (!authorization) return issue(field, 'must be an object');
  if (hasUnknownKey(authorization, AUTHORIZATION_KEYS)) {
    return issue(field, 'contains an unsupported field');
  }

  const keyId = authorization['keyId'];
  if (typeof keyId !== 'string' || keyId.length > 64 || !KEY_ID_RE.test(keyId)) {
    return issue(`${field}.keyId`, 'must be a 1 to 64 character ASCII token using letters, numbers, dot, underscore, or hyphen');
  }
  const publicKey = authorization['publicKey'];
  if (!validEd25519PublicKey(publicKey)) {
    return issue(`${field}.publicKey`, 'must be the canonical unpadded base64url encoding of an Ed25519 DER-SPKI public key');
  }
  const requiredActions = authorization['requiredActions'];
  if (!Array.isArray(requiredActions)) {
    return issue(`${field}.requiredActions`, 'must be an array');
  }
  const seen = new Set<string>();
  const actions: ClientOutputPolicyAction[] = [];
  for (let index = 0; index < requiredActions.length; index += 1) {
    const action = requiredActions[index];
    if (typeof action !== 'string' || !ACTIONS.has(action)) {
      return issue(`${field}.requiredActions[${index}]`, 'must be a supported client-output action');
    }
    if (seen.has(action)) {
      return issue(`${field}.requiredActions[${index}]`, 'duplicates an earlier required action');
    }
    seen.add(action);
    actions.push(action as ClientOutputPolicyAction);
  }

  return Object.freeze({
    keyId,
    publicKey,
    requiredActions: Object.freeze(actions),
  });
}

export function parseClientOutputPolicies(value: unknown): ClientOutputPolicyParseResult {
  if (value === undefined) {
    const policies = Object.freeze([]) as readonly ConfiguredClientOutputPolicy[];
    return Object.freeze({
      ok: true,
      policies,
      registry: new ReadOnlyClientOutputPolicyRegistry(policies),
    });
  }
  if (!Array.isArray(value)) return issue('clientOutputPolicies', 'must be an array when present');
  if (value.length > 32) return issue('clientOutputPolicies', 'must contain at most 32 policies');

  const policies: ConfiguredClientOutputPolicy[] = [];
  const conversationKeys = new Set<string>();
  for (let policyIndex = 0; policyIndex < value.length; policyIndex += 1) {
    const field = `clientOutputPolicies[${policyIndex}]`;
    const rawPolicy = asRecord(value[policyIndex]);
    if (!rawPolicy) return issue(field, 'must be an object');
    if (hasUnknownKey(rawPolicy, POLICY_KEYS)) return issue(field, 'contains an unsupported field');

    const conversationKey = rawPolicy['conversationKey'];
    if (!validConversationKey(conversationKey)) {
      return issue(`${field}.conversationKey`, 'must be an exact trimmed nonempty canonical key of at most 512 Unicode code points without control characters or the reserved global key');
    }
    if (conversationKeys.has(conversationKey)) {
      return issue(`${field}.conversationKey`, 'duplicates an earlier conversation key');
    }
    conversationKeys.add(conversationKey);

    const maxCodePoints = rawPolicy['maxCodePoints'];
    if (!validInteger(maxCodePoints, 1, 4000)) {
      return issue(`${field}.maxCodePoints`, 'must be an integer between 1 and 4000');
    }
    const maxQuestionMarks = rawPolicy['maxQuestionMarks'];
    if (!validInteger(maxQuestionMarks, 0, 20)) {
      return issue(`${field}.maxQuestionMarks`, 'must be an integer between 0 and 20');
    }

    const rawTerms = rawPolicy['blockedTerms'];
    if (!Array.isArray(rawTerms)) return issue(`${field}.blockedTerms`, 'must be an array');
    if (rawTerms.length > 64) return issue(`${field}.blockedTerms`, 'must contain at most 64 terms');
    const identities = new Set<string>();
    const blockedTerms: ClientOutputBlockedTerm[] = [];
    for (let termIndex = 0; termIndex < rawTerms.length; termIndex += 1) {
      const parsedTerm = parseTerm(
        rawTerms[termIndex],
        `${field}.blockedTerms[${termIndex}]`,
        identities,
      );
      if ('ok' in parsedTerm) return parsedTerm;
      blockedTerms.push(parsedTerm);
    }

    const rejectInternalArtifacts = rawPolicy['rejectInternalArtifacts'];
    if (typeof rejectInternalArtifacts !== 'boolean') {
      return issue(`${field}.rejectInternalArtifacts`, 'must be a boolean');
    }
    const rejectWhatsAppJids = rawPolicy['rejectWhatsAppJids'];
    if (typeof rejectWhatsAppJids !== 'boolean') {
      return issue(`${field}.rejectWhatsAppJids`, 'must be a boolean');
    }

    let authorization: ClientOutputPolicyAuthorization | undefined;
    if (rawPolicy['authorization'] !== undefined) {
      const parsedAuthorization = parseAuthorization(
        rawPolicy['authorization'],
        `${field}.authorization`,
      );
      if ('ok' in parsedAuthorization) return parsedAuthorization;
      authorization = parsedAuthorization;
    }

    policies.push(Object.freeze({
      conversationKey,
      maxCodePoints,
      maxQuestionMarks,
      blockedTerms: Object.freeze(blockedTerms),
      rejectInternalArtifacts,
      rejectWhatsAppJids,
      ...(authorization ? { authorization } : {}),
    }));
  }

  const frozenPolicies = Object.freeze(policies);
  return Object.freeze({
    ok: true,
    policies: frozenPolicies,
    registry: new ReadOnlyClientOutputPolicyRegistry(frozenPolicies),
  });
}

export function parseClientOutputPoliciesForInstance(
  raw: Record<string, unknown>,
): ClientOutputPolicyParseResult {
  if (!Object.prototype.hasOwnProperty.call(raw, 'clientOutputPolicies')) {
    return parseClientOutputPolicies(undefined);
  }
  if (
    raw['type'] !== 'agent'
    || (raw['transport'] ?? DEFAULT_TRANSPORT_ID) !== 'baileys'
  ) {
    return issue(
      'clientOutputPolicies',
      'is only valid for agent instances using the Baileys transport',
    );
  }
  return parseClientOutputPolicies(raw['clientOutputPolicies']);
}

export function resolveClientOutputPolicy(
  registry: ClientOutputPolicyRegistry,
  canonicalConversationKey: string,
): ConfiguredClientOutputPolicy | undefined {
  return registry.get(canonicalConversationKey);
}

export function selectClientOutputPolicy(
  registry: ClientOutputPolicyRegistry,
  resolution: ClientOutputPolicyIdentityResolution,
): ClientOutputPolicySelection {
  if (resolution.status === 'identity_unresolved') {
    return Object.freeze({ status: 'identity_unresolved' });
  }
  const policy = resolveClientOutputPolicy(registry, resolution.canonicalConversationKey);
  return policy
    ? Object.freeze({ status: 'configured', policy })
    : Object.freeze({ status: 'unconfigured' });
}

/**
 * Projects authenticated configuration-authority responses only. The selector
 * conversationKey remains visible while blocked terms and public keys are
 * redacted. Do not reuse this projector for telemetry or discovery output.
 */
export function projectClientOutputPolicyConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(config, 'clientOutputPolicies')) return { ...config };
  const parsed = parseClientOutputPolicies(config['clientOutputPolicies']);
  if (!parsed.ok) {
    return { ...config, clientOutputPolicies: CLIENT_OUTPUT_POLICY_REDACTION };
  }
  return {
    ...config,
    clientOutputPolicies: parsed.policies.map((policy) => ({
      ...policy,
      blockedTerms: policy.blockedTerms.map((term) => ({
        ...term,
        value: CLIENT_OUTPUT_POLICY_REDACTION,
      })),
      ...(policy.authorization
        ? {
            authorization: {
              ...policy.authorization,
              publicKey: CLIENT_OUTPUT_POLICY_REDACTION,
            },
          }
        : {}),
    })),
  };
}
