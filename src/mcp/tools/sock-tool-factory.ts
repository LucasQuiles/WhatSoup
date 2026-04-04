// src/mcp/tools/sock-tool-factory.ts
// Generic factory for MCP tool handlers that call WhatsAppSocket methods.
// Eliminates per-tool boilerplate: schema parsing, getSock(), null check, call, return.

import { z } from 'zod';
import type { ToolDeclaration, ToolScope, TargetMode, ExtendedBaileysSocket } from '../types.ts';

export interface SockToolConfig<T extends z.ZodRawShape> {
  name: string;
  description: string;
  schema: z.ZodObject<T>;
  scope?: ToolScope;
  targetMode?: TargetMode;
  replayPolicy?: 'safe' | 'unsafe' | 'read_only';
  /** Given parsed params and a live socket, call the sock method and return the result. */
  call: (parsed: z.infer<z.ZodObject<T>>, sock: ExtendedBaileysSocket) => Promise<unknown>;
}

/**
 * Build a single ToolDeclaration from a config object and a socket accessor.
 * The returned handler parses the schema, obtains the socket, and delegates to `config.call`.
 */
export function makeSockTool<T extends z.ZodRawShape>(
  getSock: () => ExtendedBaileysSocket | null,
  config: SockToolConfig<T>,
): ToolDeclaration {
  return {
    name: config.name,
    description: config.description,
    schema: config.schema,
    scope: config.scope ?? 'global',
    targetMode: config.targetMode ?? 'caller-supplied',
    replayPolicy: config.replayPolicy,
    handler: async (params) => {
      const parsed = config.schema.parse(params);
      const sock = getSock();
      if (!sock) throw new Error('WhatsApp is not connected');
      return config.call(parsed, sock);
    },
  };
}

/**
 * Batch-register an array of sock tool configs.
 *
 * Accepts `SockToolConfig<any>` so callers can pass a heterogeneous array of
 * configs with different schema shapes without needing a union type.
 */
export function registerSockTools(
  getSock: () => ExtendedBaileysSocket | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous config array requires any for ZodRawShape variance; expires 2026-12-31
  configs: SockToolConfig<any>[],
  register: (tool: ToolDeclaration) => void,
): void {
  for (const config of configs) {
    register(makeSockTool(getSock, config));
  }
}
