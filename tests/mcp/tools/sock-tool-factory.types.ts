import { z } from 'zod';
import { defineSockTool } from '../../../src/mcp/tools/sock-tool-factory.ts';

type IsAny<T> = 0 extends (1 & T) ? true : false;
type IsUnknown<T> = IsAny<T> extends true
  ? false
  : unknown extends T
    ? ([keyof T] extends [never] ? true : false)
    : false;
type Assert<T extends true> = T;

// This file is compiled directly by the Zod 4 qualification command. It must
// fail if defineSockTool contextually erases a concrete callback to any/unknown.
const typedBuilder = defineSockTool({
  name: 'compile_only',
  description: 'compile-only schema inference probe',
  schema: z.object({
    kind: z.enum(['audio', 'video']),
    label: z.string(),
    optionalLabel: z.string().optional(),
  }),
  call: async ({ kind, label, optionalLabel }, sock) => {
    type _KindNotAny = Assert<IsAny<typeof kind> extends false ? true : false>;
    type _KindNotUnknown = Assert<IsUnknown<typeof kind> extends false ? true : false>;
    type _LabelNotAny = Assert<IsAny<typeof label> extends false ? true : false>;
    type _LabelNotUnknown = Assert<IsUnknown<typeof label> extends false ? true : false>;
    type _OptionalNotAny = Assert<IsAny<typeof optionalLabel> extends false ? true : false>;
    type _OptionalNotUnknown = Assert<IsUnknown<typeof optionalLabel> extends false ? true : false>;

    const exactKind: 'audio' | 'video' = kind;
    const exactLabel: string = label;
    const exactOptionalLabel: string | undefined = optionalLabel;
    void sock;
    return { exactKind, exactLabel, exactOptionalLabel };
  },
});

void typedBuilder;
