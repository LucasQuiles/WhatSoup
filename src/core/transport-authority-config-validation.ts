import { isAbsolute } from 'node:path';

import { parseTransportAuthorityUrl, TRANSPORT_AUTHORITY_URL_REQUIREMENT } from '../lib/authority-url.ts';
import { isNonEmptyString, isRecord } from '../lib/type-guards.ts';
import type { ValidationError } from './agent-config-validator.ts';

function err(field: string, message: string): ValidationError {
  return { field, message, status: 400 };
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const MANAGED_PROVIDER_IDS = new Set(['openai-api', 'anthropic-api']);

export function validateProviderProcessIsolationConfig(
  value: unknown,
): ValidationError | null {
  const field = 'agentOptions.providerProcessIsolation';
  if (!isRecord(value)) return err(field, `${field} must be an object`);
  for (const name of ['controllerUid', 'controllerGid', 'workerUid', 'workerGid'] as const) {
    const id = value[name];
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      return err(`${field}.${name}`, `${field}.${name} must be a positive non-root integer`);
    }
  }
  if (value['controllerUid'] === value['workerUid']) {
    return err(`${field}.workerUid`, `${field}.controllerUid and ${field}.workerUid must be distinct`);
  }
  if (value['controllerGid'] === value['workerGid']) {
    return err(`${field}.workerGid`, `${field}.controllerGid and ${field}.workerGid must be distinct`);
  }
  for (const name of ['launcherPath', 'policyPath', 'homeDir', 'configHome', 'dataHome'] as const) {
    if (!isNonEmptyString(value[name]) || !isAbsolute(value[name])) {
      return err(`${field}.${name}`, `${field}.${name} must be an absolute path`);
    }
  }
  for (const name of ['launcherSha256', 'policySha256'] as const) {
    if (typeof value[name] !== 'string' || !SHA256_HEX_RE.test(value[name])) {
      return err(`${field}.${name}`, `${field}.${name} must be a lowercase SHA-256 digest`);
    }
  }
  if (!Array.isArray(value['protectedPaths']) || value['protectedPaths'].length === 0) {
    return err(`${field}.protectedPaths`, `${field}.protectedPaths must be a non-empty array of absolute paths`);
  }
  const paths = value['protectedPaths'];
  if (paths.some((path) => !isNonEmptyString(path) || !isAbsolute(path))) {
    return err(`${field}.protectedPaths`, `${field}.protectedPaths must be a non-empty array of absolute paths`);
  }
  if (new Set(paths).size !== paths.length) {
    return err(`${field}.protectedPaths`, `${field}.protectedPaths must not repeat a protected path`);
  }
  if (value['readinessMode'] !== 'disabled') {
    return err(
      `${field}.readinessMode`,
      `${field}.readinessMode must be "disabled" until readiness probes use the isolated launch boundary`,
    );
  }
  return null;
}

function validateAuthorityProviderQualification(
  raw: Record<string, unknown>,
  authority: Record<string, unknown>,
): ValidationError | null {
  if (raw['type'] !== 'agent' || !isRecord(raw['agentOptions'])) {
    return err(
      'agentOptions.providerProcessIsolation',
      'transportAuthority.enabled requires an agent runtime with providerProcessIsolation',
    );
  }
  const options = raw['agentOptions'];
  const isolationErr = validateProviderProcessIsolationConfig(options['providerProcessIsolation']);
  if (isolationErr) return isolationErr;
  const isolation = options['providerProcessIsolation'] as Record<string, unknown>;
  if (isolation['controllerUid'] !== authority['serviceUid']) {
    return err(
      'agentOptions.providerProcessIsolation.controllerUid',
      'agentOptions.providerProcessIsolation.controllerUid must match transportAuthority.serviceUid',
    );
  }
  if (isolation['workerUid'] !== authority['workerUid']) {
    return err(
      'agentOptions.providerProcessIsolation.workerUid',
      'agentOptions.providerProcessIsolation.workerUid must match transportAuthority.workerUid',
    );
  }
  const primary = options['provider'] ?? 'claude-cli';
  if (MANAGED_PROVIDER_IDS.has(primary as string)) {
    return err(
      'agentOptions.provider',
      'transportAuthority.enabled cannot use a managed API provider until it has an isolated execution boundary',
    );
  }
  const legacyFallback = options['fallbackProvider'];
  if (MANAGED_PROVIDER_IDS.has(legacyFallback as string)) {
    return err(
      'agentOptions.fallbackProvider',
      'transportAuthority.enabled cannot use a managed API fallback until it has an isolated execution boundary',
    );
  }
  if (Array.isArray(options['fallbacks'])) {
    for (let index = 0; index < options['fallbacks'].length; index += 1) {
      const fallback = options['fallbacks'][index];
      if (isRecord(fallback) && MANAGED_PROVIDER_IDS.has(fallback['provider'] as string)) {
        return err(
          `agentOptions.fallbacks[${index}].provider`,
          'transportAuthority.enabled cannot use a managed API fallback until it has an isolated execution boundary',
        );
      }
    }
  }
  if (options['fallbackDiscovery'] !== undefined) {
    return err(
      'agentOptions.fallbackDiscovery',
      'transportAuthority.enabled cannot use dynamic fallback discovery until every discovered provider has an isolated execution boundary',
    );
  }
  return err(
    'agentOptions.providerProcessIsolation',
    'transportAuthority.enabled is not qualified: the launcher does not yet have a kernel-enforced egress boundary',
  );
}

export function validateTransportAuthorityConfig(
  raw: Record<string, unknown>,
  effectiveTransport: string,
): ValidationError | null {
  const authority = raw['transportAuthority'];
  if (authority === undefined || authority === null) return null;
  if (!isRecord(authority)) return err('transportAuthority', 'transportAuthority must be an object');
  const enabled = authority['enabled'];
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return err('transportAuthority.enabled', 'transportAuthority.enabled must be a boolean');
  }
  if (enabled !== true) return null;
  if (effectiveTransport !== 'baileys') {
    return err('transportAuthority', 'transportAuthority requires transport "baileys"');
  }
  for (const field of ['baseUrl', 'accountId', 'credentialFile'] as const) {
    if (!isNonEmptyString(authority[field])) {
      return err(
        `transportAuthority.${field}`,
        `transportAuthority.${field} is required when transportAuthority.enabled is true`,
      );
    }
  }
  const baseUrl = authority['baseUrl'];
  const credentialFile = authority['credentialFile'];
  if (typeof baseUrl !== 'string' || typeof credentialFile !== 'string') {
    return err('transportAuthority', 'transportAuthority required fields are malformed');
  }
  if (parseTransportAuthorityUrl(baseUrl) === null) {
    return err('transportAuthority.baseUrl', `transportAuthority.baseUrl ${TRANSPORT_AUTHORITY_URL_REQUIREMENT}`);
  }
  if (!isAbsolute(credentialFile)) {
    return err('transportAuthority.credentialFile', 'transportAuthority.credentialFile must be an absolute path');
  }
  for (const field of ['serviceUid', 'workerUid'] as const) {
    const value = authority[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      return err(
        `transportAuthority.${field}`,
        `transportAuthority.${field} must be a positive non-root integer when transportAuthority.enabled is true`,
      );
    }
  }
  if (authority['serviceUid'] === authority['workerUid']) {
    return err(
      'transportAuthority.workerUid',
      'transportAuthority.serviceUid and transportAuthority.workerUid must be distinct',
    );
  }
  return validateAuthorityProviderQualification(raw, authority);
}
