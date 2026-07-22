import type {
  ProviderBoundaryMode,
  ProviderDataPolicy,
  ProviderDataPolicyVersion,
} from './provider-data-policy.ts';

export interface ProviderBoundaryMcpTool {
  readonly name: string;
  readonly inputSchema: Record<string, unknown>;
}

export type ProviderBoundaryTurnPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; filePath?: string; base64?: string; caption?: string }
  | { kind: 'audio'; mimeType: string; filePath?: string; transcript?: string }
  | { kind: 'document'; mimeType: string; filePath: string; extractedText?: string; filename?: string };

export const PROVIDER_ALIAS_TYPES = [
  'path',
  'email',
  'whatsapp_id',
  'phone',
  'network_identity',
  'repository_ref',
  'technical_identifier',
] as const;

export type ProviderAliasType = (typeof PROVIDER_ALIAS_TYPES)[number];
export type ProviderBoundarySurface =
  | 'prompt'
  | 'history'
  | 'turn'
  | 'tool_result'
  | 'provider_output';

export type ProviderBoundaryRouteSource =
  | 'configured'
  | 'fallback'
  | 'checkpoint'
  | 'default';

export interface ProviderBoundaryBinding {
  readonly provider: string;
  readonly model: string | undefined;
  readonly dataPolicy: ProviderDataPolicy;
  readonly policyVersion: ProviderDataPolicyVersion;
  readonly providerSessionId: string;
}

export interface ProviderBoundaryEvent {
  readonly policyVersion: ProviderDataPolicyVersion;
  readonly mode: ProviderBoundaryMode;
  readonly providerClass: 'managed_api';
  readonly routeSource: ProviderBoundaryRouteSource;
  readonly eventType:
    | 'success'
    | 'missing_policy'
    | 'transform_failure'
    | 'secret_block'
    | 'unknown_alias'
    | 'rehydration_failure'
    | 'route_drift';
  readonly success: 0 | 1;
  readonly transformCount: number;
  readonly aliasCount: number;
  readonly secretCount: number;
  readonly latencyMs: number;
}

export type ProviderBoundaryEventSink = (event: ProviderBoundaryEvent) => void;

export type ProviderDataBoundaryErrorCode =
  | 'secret_detected'
  | 'invalid_alias'
  | 'residual_alias'
  | 'nested_alias'
  | 'alias_type_mismatch'
  | 'unknown_tool'
  | 'unauthorized_field'
  | 'invalid_tool_input'
  | 'retired_boundary'
  | 'route_drift'
  | 'limit_exceeded'
  | 'entropy_collision';

export class ProviderDataBoundaryError extends Error {
  readonly code: ProviderDataBoundaryErrorCode;

  constructor(code: ProviderDataBoundaryErrorCode) {
    super(`Provider data boundary rejected content (${code})`);
    this.name = 'ProviderDataBoundaryError';
    this.code = code;
  }
}

export interface ProviderDataBoundary {
  readonly binding: ProviderBoundaryBinding;
  readonly mode: ProviderBoundaryMode;
  assertModel(model: string | undefined): void;
  exposeText(text: string, context: { surface: ProviderBoundarySurface }): string;
  exposeTexts(texts: readonly string[], context: { surface: ProviderBoundarySurface }): string[];
  exposeToolResult(toolName: string, content: string): string;
  inspectToolJson(rawJson: string): boolean;
  rehydrateProviderText(text: string, context: { surface: ProviderBoundarySurface }): string;
  rehydrateToolInput(
    toolName: string,
    input: Record<string, unknown>,
    tools: readonly ProviderBoundaryMcpTool[],
  ): Record<string, unknown>;
  retire(): void;
}

export interface CreateProviderDataBoundaryOptions {
  readonly binding: ProviderBoundaryBinding;
  readonly mode: ProviderBoundaryMode;
  readonly routeSource: ProviderBoundaryRouteSource;
  readonly entropy?: (size: number) => Uint8Array;
  readonly eventSink?: ProviderBoundaryEventSink;
  readonly technicalIdentifiers?: readonly string[];
}
