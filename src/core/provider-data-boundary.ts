import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { containsProviderSecretValue } from '../lib/provider-preview-sanitizer.ts';
import {
  ProviderDataBoundaryError,
  type CreateProviderDataBoundaryOptions,
  type ProviderAliasType,
  type ProviderBoundaryEvent,
  type ProviderBoundarySurface,
  type ProviderDataBoundary,
  type ProviderResponseFailureCode,
} from './provider-data-boundary-contract.ts';
import {
  collectProviderAliasCandidates,
  containsProviderAliasSyntax,
  MAX_ALIASES_PER_TRANSFORM,
  MAX_BOUNDARY_TEXT_LENGTH,
  MAX_TRANSFORM_FIELDS,
  scanProviderTextSequence,
  type ProviderAliasCandidate,
} from './provider-data-boundary-detection.ts';
import {
  assertProviderToolJsonSafe,
  preflightProviderToolValue,
  rehydrateAuthorizedProviderToolInput,
} from './provider-data-boundary-tool.ts';

export * from './provider-data-boundary-contract.ts';
export { assertProviderToolJsonSafe } from './provider-data-boundary-tool.ts';

interface AliasRecord {
  readonly alias: string;
  readonly localValue: string;
  readonly type: ProviderAliasType;
  readonly provenance?: AliasProvenance;
}

interface AliasProvenance {
  readonly toolName: string;
  readonly fieldPath: string;
}

const ALIAS_RE = /⟦WSA1:(path|email|whatsapp_id|phone|network_identity|repository_ref|technical_identifier):([0-9a-f]{32}):([0-9a-f]{32})⟧/gu;
const EXACT_ALIAS_RE = /^⟦WSA1:(path|email|whatsapp_id|phone|network_identity|repository_ref|technical_identifier):([0-9a-f]{32}):([0-9a-f]{32})⟧$/u;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

interface ScopedAliasCandidate extends ProviderAliasCandidate {
  readonly provenance?: AliasProvenance;
}

function valueKey(candidate: Pick<ScopedAliasCandidate, 'type' | 'value' | 'provenance'>): string {
  return `${candidate.type}\u0000${candidate.value}\u0000${candidate.provenance?.toolName ?? ''}\u0000${candidate.provenance?.fieldPath ?? ''}`;
}

export function createProviderDataBoundary(
  options: CreateProviderDataBoundaryOptions,
): ProviderDataBoundary {
  const binding = Object.freeze({ ...options.binding });
  const mode = options.mode;
  const routeSource = options.routeSource;
  if (
    !(['configured', 'fallback', 'checkpoint', 'default'] as readonly unknown[]).includes(routeSource)
    || !(['shadow', 'enforce'] as readonly unknown[]).includes(mode)
    || binding.policyVersion !== 'provider-data-policy-v1'
    || !(['trusted', 'restricted'] as readonly unknown[]).includes(binding.dataPolicy)
  ) {
    throw new Error('Provider boundary metadata is outside the closed telemetry vocabulary');
  }
  const eventSink = options.eventSink;
  const entropy = options.entropy ?? ((size: number) => randomBytes(size));
  const hmacKey = entropy(32);
  if (hmacKey.byteLength !== 32) throw new Error('Provider boundary entropy must return the requested byte count');
  const byAlias = new Map<string, AliasRecord>();
  const byValue = new Map<string, AliasRecord>();
  const technicalIdentifiers = Object.freeze([...(options.technicalIdentifiers ?? [])]);
  let retired = false;

  const emit = (
    eventType: ProviderBoundaryEvent['eventType'],
    success: 0 | 1,
    startedAt: number,
    transformCount: number,
    aliasCount: number,
    secretCount: number,
  ): void => {
    try {
      eventSink?.(Object.freeze({
        policyVersion: binding.policyVersion,
        mode,
        providerClass: 'managed_api',
        routeSource,
        eventType,
        success,
        transformCount,
        aliasCount,
        secretCount,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      }));
    } catch {
      // Observability is advisory until a reconciled persistence schema exists.
    }
  };

  const assertActive = (): void => {
    if (retired) throw new ProviderDataBoundaryError('retired_boundary');
  };

  const failureEvent = (
    error: unknown,
    operation: 'transform' | 'rehydrate',
  ): { eventType: ProviderBoundaryEvent['eventType']; success: 0 | 1 } => {
    const code = error instanceof ProviderDataBoundaryError ? error.code : undefined;
    if (code === 'secret_detected') return { eventType: 'secret_block', success: 1 };
    if (
      code === 'invalid_alias'
      || code === 'residual_alias'
      || code === 'nested_alias'
      || code === 'alias_type_mismatch'
    ) {
      return { eventType: 'unknown_alias', success: 0 };
    }
    return {
      eventType: operation === 'transform' ? 'transform_failure' : 'rehydration_failure',
      success: 0,
    };
  };

  const macFor = (
    type: ProviderAliasType,
    token: string,
    provenance?: AliasProvenance,
  ): string => createHmac('sha256', hmacKey)
    .update(JSON.stringify([
      binding.policyVersion,
      binding.providerSessionId,
      type,
      provenance?.toolName ?? null,
      provenance?.fieldPath ?? null,
      token,
    ]))
    .digest('hex')
    .slice(0, 32);

  const authenticate = (
    alias: string,
    expectedType?: ProviderAliasType,
    destination?: AliasProvenance,
  ): AliasRecord => {
    assertActive();
    const parsed = EXACT_ALIAS_RE.exec(alias);
    if (!parsed) {
      throw new ProviderDataBoundaryError(expectedType === undefined ? 'invalid_alias' : 'nested_alias');
    }
    const type = parsed[1] as ProviderAliasType;
    const mac = parsed[3]!;
    const record = byAlias.get(alias);
    if (!constantTimeEqual(mac, macFor(type, parsed[2]!, record?.provenance)) || record === undefined) {
      throw new ProviderDataBoundaryError('invalid_alias');
    }
    if (expectedType !== undefined && type !== expectedType) {
      throw new ProviderDataBoundaryError('alias_type_mismatch');
    }
    if (record.provenance && destination && (
      record.provenance.toolName !== destination.toolName
      || record.provenance.fieldPath !== destination.fieldPath
    )) {
      throw new ProviderDataBoundaryError('invalid_alias');
    }
    return record;
  };

  const stageAliases = (candidates: readonly ScopedAliasCandidate[]): Map<string, AliasRecord> => {
    const stagedByValue = new Map<string, AliasRecord>();
    const stagedByAlias = new Map<string, AliasRecord>();
    for (const candidate of candidates) {
      const key = valueKey(candidate);
      if (byValue.has(key) || stagedByValue.has(key)) continue;
      let record: AliasRecord | null = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const tokenBytes = entropy(16);
        if (tokenBytes.byteLength !== 16) {
          throw new Error('Provider boundary entropy must return the requested byte count');
        }
        const token = hex(tokenBytes);
        const alias = `⟦WSA1:${candidate.type}:${token}:${macFor(candidate.type, token, candidate.provenance)}⟧`;
        if (!byAlias.has(alias) && !stagedByAlias.has(alias)) {
          record = Object.freeze({
            alias,
            localValue: candidate.value,
            type: candidate.type,
            ...(candidate.provenance ? {
              provenance: Object.freeze({ ...candidate.provenance }),
            } : {}),
          });
          break;
        }
      }
      if (record === null) throw new ProviderDataBoundaryError('entropy_collision');
      stagedByValue.set(key, record);
      stagedByAlias.set(record.alias, record);
    }
    for (const [key, record] of stagedByValue) byValue.set(key, record);
    for (const [alias, record] of stagedByAlias) byAlias.set(alias, record);
    return stagedByValue;
  };

  const render = (
    text: string,
    candidates: readonly ScopedAliasCandidate[],
    staged: ReadonlyMap<string, AliasRecord>,
  ): string => {
    let cursor = 0;
    let output = '';
    for (const candidate of candidates) {
      const record = byValue.get(valueKey(candidate)) ?? staged.get(valueKey(candidate));
      if (!record) throw new ProviderDataBoundaryError('invalid_alias');
      output += text.slice(cursor, candidate.start) + record.alias;
      cursor = candidate.end;
    }
    return output + text.slice(cursor);
  };

  const exposeTextsWithProvenance = (
    texts: readonly string[],
    _context: { surface: ProviderBoundarySurface },
    provenances: readonly (AliasProvenance | undefined)[] = [],
  ): string[] => {
    assertActive();
    const startedAt = performance.now();
    if (binding.dataPolicy === 'trusted') {
      emit('success', 1, startedAt, texts.length, 0, 0);
      return [...texts];
    }
    if (texts.length > MAX_TRANSFORM_FIELDS) {
      emit('transform_failure', 0, startedAt, texts.length, 0, 0);
      if (mode === 'shadow') return [...texts];
      throw new ProviderDataBoundaryError('limit_exceeded');
    }
    const overLimit = texts.some((text) => text.length > MAX_BOUNDARY_TEXT_LENGTH);
    const scan = scanProviderTextSequence(texts);
    const secretCount = scan.directSecretCount + (scan.fragmentedSecret ? 1 : 0);
    const hasReservedSyntax = scan.directAlias || scan.fragmentedAlias;
    if (overLimit || secretCount > 0 || hasReservedSyntax) {
      const error = new ProviderDataBoundaryError(
        overLimit ? 'limit_exceeded' : secretCount > 0 ? 'secret_detected' : 'residual_alias',
      );
      const failure = failureEvent(error, 'transform');
      emit(failure.eventType, failure.success, startedAt, texts.length, 0, secretCount);
      if (mode === 'shadow') return [...texts];
      throw error;
    }
    const candidatesByText = texts.map((text, index) => (
      collectProviderAliasCandidates(text, technicalIdentifiers).map((candidate) => ({
        ...candidate,
        ...(provenances[index] ? { provenance: provenances[index] } : {}),
      }))
    ));
    const allCandidates = candidatesByText.flat();
    if (allCandidates.length > MAX_ALIASES_PER_TRANSFORM) {
      emit('transform_failure', 0, startedAt, texts.length, 0, 0);
      if (mode === 'shadow') return [...texts];
      throw new ProviderDataBoundaryError('limit_exceeded');
    }
    if (mode === 'shadow') {
      emit('success', 1, startedAt, texts.length, allCandidates.length, 0);
      return [...texts];
    }
    try {
      const staged = stageAliases(allCandidates);
      const output = texts.map((text, index) => render(text, candidatesByText[index]!, staged));
      emit('success', 1, startedAt, texts.length, allCandidates.length, 0);
      return output;
    } catch (error) {
      const failure = failureEvent(error, 'transform');
      emit(failure.eventType, failure.success, startedAt, texts.length, 0, 0);
      throw error;
    }
  };

  const exposeTexts = (
    texts: readonly string[],
    context: { surface: ProviderBoundarySurface },
  ): string[] => exposeTextsWithProvenance(texts, context);

  const exposeText = (text: string, context: { surface: ProviderBoundarySurface }): string => (
    exposeTexts([text], context)[0]!
  );

  const rehydrateProviderText = (
    text: string,
    _context: { surface: ProviderBoundarySurface },
  ): string => {
    assertActive();
    const startedAt = performance.now();
    if (binding.dataPolicy === 'trusted') {
      emit('success', 1, startedAt, 1, 0, 0);
      return text;
    }
    let aliasCount = 0;
    let secretCount = 0;
    try {
      if (text.length > MAX_BOUNDARY_TEXT_LENGTH) throw new ProviderDataBoundaryError('limit_exceeded');
      secretCount = containsProviderSecretValue(text) ? 1 : 0;
      if (secretCount > 0) throw new ProviderDataBoundaryError('secret_detected');
      ALIAS_RE.lastIndex = 0;
      const result = text.replace(ALIAS_RE, (alias) => {
        aliasCount += 1;
        return authenticate(alias).localValue;
      });
      if (containsProviderAliasSyntax(result)) throw new ProviderDataBoundaryError('invalid_alias');
      emit('success', 1, startedAt, 1, aliasCount, 0);
      return mode === 'shadow' ? text : result;
    } catch (error) {
      const failure = failureEvent(error, 'rehydrate');
      emit(failure.eventType, failure.success, startedAt, 1, aliasCount, secretCount);
      if (mode === 'shadow') return text;
      throw error;
    }
  };

  const rehydrateToolInput: ProviderDataBoundary['rehydrateToolInput'] = (toolName, input, tools) => {
    assertActive();
    const startedAt = performance.now();
    if (binding.dataPolicy === 'trusted') {
      emit('success', 1, startedAt, 1, 0, 0);
      return input;
    }
    let secretCount: number;
    try {
      secretCount = preflightProviderToolValue(input);
    } catch (error) {
      const failure = failureEvent(error, 'rehydrate');
      emit(failure.eventType, failure.success, startedAt, 1, 0, 0);
      if (mode === 'shadow') return input;
      throw error;
    }
    if (secretCount > 0) {
      emit('secret_block', 1, startedAt, 1, 0, secretCount);
      if (mode === 'shadow') return input;
      throw new ProviderDataBoundaryError('secret_detected');
    }
    try {
      const result = rehydrateAuthorizedProviderToolInput({
        toolName,
        value: input,
        tools,
        authenticate: (alias, expectedType, destinationPointer) => authenticate(
          alias,
          expectedType,
          { toolName, fieldPath: destinationPointer },
        ).localValue,
      });
      emit('success', 1, startedAt, 1, result.aliasCount, 0);
      return mode === 'shadow' ? input : result.output;
    } catch (error) {
      const failure = failureEvent(error, 'rehydrate');
      emit(failure.eventType, failure.success, startedAt, 1, 0, 0);
      if (mode === 'shadow') return input;
      throw error;
    }
  };

  return Object.freeze({
    binding,
    mode,
    assertModel(model: string | undefined): void {
      assertActive();
      if (model === binding.model) return;
      const startedAt = performance.now();
      emit('route_drift', 0, startedAt, 1, 0, 0);
      throw new ProviderDataBoundaryError('route_drift');
    },
    exposeText,
    exposeTexts,
    exposeToolResult(toolName: string, content: string): string {
      let parsed: unknown;
      try {
        assertProviderToolJsonSafe(content);
        parsed = JSON.parse(content) as unknown;
      } catch {
        return exposeTextsWithProvenance(
          [content],
          { surface: 'tool_result' },
          [{ toolName, fieldPath: '' }],
        )[0]!;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return exposeTextsWithProvenance(
          [content],
          { surface: 'tool_result' },
          [{ toolName, fieldPath: '' }],
        )[0]!;
      }
      const startedAt = performance.now();
      try {
        const secretCount = preflightProviderToolValue(parsed);
        if (secretCount > 0) throw new ProviderDataBoundaryError('secret_detected');
      } catch (error) {
        const failure = failureEvent(error, 'transform');
        emit(
          failure.eventType,
          failure.success,
          startedAt,
          1,
          0,
          error instanceof ProviderDataBoundaryError && error.code === 'secret_detected' ? 1 : 0,
        );
        if (mode === 'shadow') return content;
        throw error;
      }
      const entries: Array<{ value: string; provenance: AliasProvenance }> = [];
      const collect = (value: unknown, pointer: string): void => {
        if (typeof value === 'string') {
          entries.push({ value, provenance: { toolName, fieldPath: pointer } });
          return;
        }
        if (Array.isArray(value)) {
          for (const child of value) collect(child, `${pointer}/*`);
          return;
        }
        if (typeof value === 'object' && value !== null) {
          for (const [key, child] of Object.entries(value)) {
            collect(child, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
          }
        }
      };
      collect(parsed, '');
      const transformed = exposeTextsWithProvenance(
        entries.map((entry) => entry.value),
        { surface: 'tool_result' },
        entries.map((entry) => entry.provenance),
      );
      if (mode === 'shadow') return content;
      let index = 0;
      const clone = (value: unknown): unknown => {
        if (typeof value === 'string') return transformed[index++]!;
        if (Array.isArray(value)) return value.map(clone);
        if (typeof value === 'object' && value !== null) {
          const output = Object.create(null) as Record<string, unknown>;
          for (const [key, child] of Object.entries(value)) output[key] = clone(child);
          return output;
        }
        return value;
      };
      return JSON.stringify(clone(parsed));
    },
    inspectToolJson(rawJson: string): boolean {
      assertActive();
      if (binding.dataPolicy === 'trusted') return true;
      const startedAt = performance.now();
      try {
        assertProviderToolJsonSafe(rawJson);
        return true;
      } catch (error) {
        const failure = failureEvent(error, 'rehydrate');
        emit(failure.eventType, failure.success, startedAt, 1, 0, 0);
        if (mode === 'shadow') return false;
        throw error;
      }
    },
    observeProviderResponseFailure(_code: ProviderResponseFailureCode): void {
      assertActive();
      emit('rehydration_failure', 0, performance.now(), 1, 0, 0);
    },
    rehydrateProviderText,
    rehydrateToolInput,
    retire(): void {
      if (retired) return;
      const startedAt = performance.now();
      retired = true;
      byAlias.clear();
      byValue.clear();
      hmacKey.fill(0);
      emit('success', 1, startedAt, 1, 0, 0);
    },
  });
}

/** Capture an immutable provider-local facade so caller mutation cannot swap boundary behavior. */
export function snapshotProviderDataBoundary(boundary: ProviderDataBoundary): ProviderDataBoundary {
  const binding = Object.freeze({ ...boundary.binding });
  const assertModel = boundary.assertModel.bind(boundary);
  const exposeText = boundary.exposeText.bind(boundary);
  const exposeTexts = boundary.exposeTexts.bind(boundary);
  const exposeToolResult = boundary.exposeToolResult.bind(boundary);
  const inspectToolJson = boundary.inspectToolJson.bind(boundary);
  const observeProviderResponseFailure = boundary.observeProviderResponseFailure.bind(boundary);
  const rehydrateProviderText = boundary.rehydrateProviderText.bind(boundary);
  const rehydrateToolInput = boundary.rehydrateToolInput.bind(boundary);
  const retire = boundary.retire.bind(boundary);
  return Object.freeze({
    binding,
    mode: boundary.mode,
    assertModel,
    exposeText,
    exposeTexts,
    exposeToolResult,
    inspectToolJson,
    observeProviderResponseFailure,
    rehydrateProviderText,
    rehydrateToolInput,
    retire,
  });
}
