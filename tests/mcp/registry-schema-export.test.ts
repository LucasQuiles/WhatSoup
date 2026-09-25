import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../helpers/resolved-tool-registry.ts';
import type { ToolDeclaration, SessionContext } from '../../src/mcp/types.ts';

// Regression guard for the tools/list export: the MCP contract requires every tool's
// inputSchema to be `{ type: 'object', ... }`. Strict MCP clients validate this and
// drop the ENTIRE tool list when a single tool violates it (observed on a fleet host
// 2026-08-23 with `list_trigger_runs`, whose schema is a `.refine()` wrapper).

const globalSession: SessionContext = { tier: 'global' };

function declare(name: string, schema: ToolDeclaration['schema']): ToolDeclaration {
  return {
    name,
    description: `schema export probe: ${name}`,
    schema,
    scope: 'global',
    targetMode: 'caller-supplied',
    handler: async () => ({ ok: true }),
  };
}

describe('ToolRegistry.listTools inputSchema export', () => {
  const cases: Array<[string, ToolDeclaration['schema']]> = [
    ['refine', z.object({ a: z.number().optional(), b: z.number().optional() })
      .refine((p) => p.a != null || p.b != null, { message: 'a or b' })],
    ['superRefine', z.object({ a: z.string() }).superRefine(() => undefined)],
    ['transform', z.object({ a: z.string() }).transform((p) => ({ ...p, seen: true }))],
    ['default', z.object({ a: z.string() }).default({ a: 'x' })],
    ['nullable', z.object({ a: z.string() }).nullable()],
    ['plain', z.object({ a: z.string(), b: z.number().optional() })],
  ];

  for (const [label, schema] of cases) {
    it(`exports type:"object" with properties for a ${label}-wrapped object schema`, () => {
      const registry = new ToolRegistry();
      registry.register(declare(`probe_${label}`, schema));
      const [listed] = registry.listTools(globalSession);
      expect(listed.name).toBe(`probe_${label}`);
      expect(listed.inputSchema.type).toBe('object');
      expect(listed.inputSchema.properties).toHaveProperty('a');
    });
  }

  it('keeps required/optional semantics through a refine wrapper', () => {
    const registry = new ToolRegistry();
    registry.register(declare('probe_required', z.object({ must: z.string(), may: z.string().optional() })
      .refine(() => true)));
    const [listed] = registry.listTools(globalSession);
    expect(listed.inputSchema.required).toEqual(['must']);
  });

  it('invariant: every listed tool has inputSchema.type === "object"', () => {
    const registry = new ToolRegistry();
    for (const [label, schema] of cases) registry.register(declare(`inv_${label}`, schema));
    const offenders = registry.listTools(globalSession)
      .filter((t) => t.inputSchema.type !== 'object')
      .map((t) => t.name);
    expect(offenders).toEqual([]);
  });
});
