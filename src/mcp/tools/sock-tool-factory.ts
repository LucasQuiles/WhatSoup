// src/mcp/tools/sock-tool-factory.ts
// Generic factory for MCP tool handlers that call WhatsAppSocket methods.
// Eliminates per-tool boilerplate: schema parsing, getSock(), null check, call, return.

import { z } from 'zod';
import type { ExternalEffectDeclaration } from '../external-effect.ts';
import type { ToolDeclaration, ToolScope, TargetMode, ExtendedBaileysSocket } from '../types.ts';

/**
 * Config for one factory-built tool.
 *
 * AUTHORING RULE: every member of this interface is forwarded onto the built
 * `ToolDeclaration` by rest-spread in `makeSockTool`, so a new declaration field
 * needs no factory change. The trade is deliberate and asymmetric — the previous
 * hand-maintained whitelist silently DROPPED unknown fields (which is how the R1
 * `sensitive` gate came to be structurally unreachable), whereas the spread
 * silently FORWARDS them. Dropping a security flag is far worse than carrying
 * extra metadata, so forwarding is the safer default.
 *
 * The consequence: if you add a member that is config-only and must NOT appear on
 * the declaration, you MUST destructure it out in `makeSockTool` alongside `call`.
 * `call` is the only such member today.
 */
export interface SockToolConfig<T extends z.ZodRawShape> {
  name: string;
  description: string;
  schema: z.ZodObject<T>;
  scope?: ToolScope;
  targetMode?: TargetMode;
  replayPolicy?: 'safe' | 'unsafe' | 'read_only';
  /** D2 external-effect declaration, copied verbatim onto the built ToolDeclaration. */
  externalEffect?: ExternalEffectDeclaration;
  /**
   * R1 sensitive-tool flag, copied verbatim onto the built ToolDeclaration.
   *
   * Until 2026-08-17 this field did not exist here and `makeSockTool` did not
   * copy it, which made every tool built through this factory structurally
   * incapable of being gated — setting `sensitive: true` on a config was
   * silently discarded rather than rejected, because the old heterogeneous
   * config array erased its member type before excess-property checking. The
   * `logout` gate (S5) is the first consumer; see tests/mcp/logout-gate.test.ts.
   */
  sensitive?: boolean;
  /** S1 device-removal marker, forwarded verbatim. See ToolDeclaration.bondEffect. */
  bondEffect?: ToolDeclaration['bondEffect'];
  /** Given parsed params and a live socket, call the sock method and return the result. */
  call: (
    parsed: z.infer<z.ZodObject<T>>,
    sock: ExtendedBaileysSocket,
    recordBondEffectDispatch?: () => void,
  ) => Promise<unknown>;
}

/**
 * A schema-aware builder keeps each config's inferred callback type until the
 * concrete tool declaration is built. The config array can then be
 * heterogeneous without contextualising every callback to an erased schema.
 */
export type SockToolBuilder = (
  getSock: () => ExtendedBaileysSocket | null,
) => ToolDeclaration;

/**
 * Build a single ToolDeclaration from a config object and a socket accessor.
 * The returned handler parses the schema, obtains the socket, and delegates to `config.call`.
 */
export function makeSockTool<T extends z.ZodRawShape>(
  getSock: () => ExtendedBaileysSocket | null,
  config: SockToolConfig<T>,
): ToolDeclaration {
  // Forward every declaration-shaped config field STRUCTURALLY rather than by a
  // hand-maintained whitelist. The whitelist is what caused the R1 defect fixed
  // on 2026-08-17: `sensitive` was absent from it, so no tool built here could be
  // gated, and because the old heterogeneous config array erased its member
  // type TypeScript silently discarded the flag instead of rejecting it. Every
  // field added to the config from now on reaches the declaration by
  // construction, so that class of
  // silent drop cannot recur.
  //
  // `call` is the only config-only member, so it is the only one destructured
  // away; `scope` and `targetMode` are pulled out solely to apply their defaults.
  const { call, scope, targetMode, ...declarationFields } = config;
  return {
    ...declarationFields,
    scope: scope ?? 'global',
    targetMode: targetMode ?? 'caller-supplied',
    handler: async (params, _session, recordBondEffectDispatch) => {
      const parsed = config.schema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      return call(parsed, sock, recordBondEffectDispatch);
    },
  };
}

/** Capture one concrete schema/config before heterogeneous registration erases its type. */
export function defineSockTool<T extends z.ZodRawShape>(
  config: SockToolConfig<T>,
): SockToolBuilder {
  return (getSock) => makeSockTool(getSock, config);
}

/**
 * Batch-register an array of schema-aware sock tool builders.
 *
 * Builders preserve each config's schema inference until makeSockTool captures
 * it; only the completed ToolDeclaration is heterogeneous at this boundary.
 */
export function registerSockTools(
  getSock: () => ExtendedBaileysSocket | null,
  configs: readonly SockToolBuilder[],
  register: (tool: ToolDeclaration) => void,
): void {
  for (const build of configs) {
    register(build(getSock));
  }
}
