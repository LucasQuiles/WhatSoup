import { z } from 'zod';
import { canonicalize } from '../canonical.ts';
import { ProbeDocSchema, type ProbeDoc } from '../types.ts';
import { CollectorProbeError, type Collector } from './types.ts';

const DEFAULT_CAPTURED_AT = '1970-01-01T00:00:00.000Z';
const IsoTimestampSchema = z.string().datetime({ offset: true });

const FixtureFieldsSchema = z.custom<Record<string, unknown>>(
  (value) => isPlainRecord(value),
  { message: 'fields must be a plain object' },
).superRefine((fields, ctx) => {
  try {
    canonicalize(fields);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'fields must be canonical JSON',
    });
  }
});

export const FixtureDocSchema = z.object({
  fields: FixtureFieldsSchema,
  captured_at: IsoTimestampSchema.optional(),
}).strict();
export type FixtureDoc = z.infer<typeof FixtureDocSchema>;

export const FixtureCollectorOptionsSchema = z.object({
  id: z.string().min(1),
  docs: z.record(FixtureDocSchema),
}).strict().superRefine((opts, ctx) => {
  for (const scopeId of Object.keys(opts.docs)) {
    if (scopeId.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['docs', scopeId],
        message: 'scope id must not be empty',
      });
    }
  }
});
export type FixtureCollectorOptions = z.input<typeof FixtureCollectorOptionsSchema>;

export class FixtureCollector implements Collector {
  readonly id: string;
  private readonly docs: Map<string, FixtureDoc>;

  constructor(opts: FixtureCollectorOptions) {
    const parsed = parseOptions(opts);
    this.id = parsed.id;
    this.docs = new Map(
      Object.entries(parsed.docs).map(([scopeId, fixture]) => [scopeId, cloneFixture(fixture)]),
    );
  }

  async run(scopeId: string): Promise<ProbeDoc> {
    const fixture = this.docs.get(scopeId);
    if (fixture === undefined) {
      throw new CollectorProbeError({
        collectorId: this.id,
        scopeId,
        message: 'no fixture for requested scope',
      });
    }

    return ProbeDocSchema.parse({
      probe_id: this.id,
      scope_id: scopeId,
      captured_at: fixture.captured_at ?? DEFAULT_CAPTURED_AT,
      fields: cloneFields(fixture.fields),
    });
  }
}

function parseOptions(opts: FixtureCollectorOptions): z.output<typeof FixtureCollectorOptionsSchema> {
  try {
    return FixtureCollectorOptionsSchema.parse(opts);
  } catch (error) {
    throw new Error('fixture collector options invalid', { cause: error });
  }
}

function cloneFixture(fixture: FixtureDoc): FixtureDoc {
  if (fixture.captured_at === undefined) {
    return { fields: cloneFields(fixture.fields) };
  }
  return { fields: cloneFields(fixture.fields), captured_at: fixture.captured_at };
}

function cloneFields(fields: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(canonicalize(fields)) as Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
