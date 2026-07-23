import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PRIVATE_OPERATION_ERROR_KINDS,
  PRIVATE_OPERATION_RECORD_SCHEMA,
  validatePrivateOperationRecordFile,
  type PrivateOperationRecordError,
} from './lib/private-operation-record.ts';
import { takeValue } from './lib/cli-args.ts';

type ExitCode = 0 | 1 | 2;
type Writer = (text: string) => void;

const VALIDATE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['record', 'format'],
  properties: {
    record: { type: 'string', pattern: '^/' },
    format: { const: 'json' },
  },
} as const;

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'path', 'message', 'retryable', 'hint'],
  properties: {
    kind: { enum: PRIVATE_OPERATION_ERROR_KINDS },
    path: { type: 'string' },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
    hint: { type: 'string' },
  },
} as const;

const VALIDATE_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'command', 'schema_version', 'step_count'],
      properties: {
        ok: { const: true },
        command: { const: 'validate' },
        schema_version: { const: 1 },
        step_count: { type: 'integer', minimum: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'command', 'errors'],
      properties: {
        ok: { const: false },
        command: { const: 'validate' },
        errors: { type: 'array', minItems: 1, items: ERROR_SCHEMA },
      },
    },
  ],
} as const;

function inputError(): PrivateOperationRecordError {
  return {
    kind: 'input_invalid',
    path: '$',
    message: 'Command input is invalid.',
    retryable: false,
    hint: 'Use schema or validate --record <absolute-path> --format json.',
  };
}

function writeJson(writer: Writer, value: unknown): void {
  writer(`${JSON.stringify(value)}\n`);
}

function parseValidateArgs(argv: readonly string[]): { record: string } | null {
  let record: string | undefined;
  let format: string | undefined;
  try {
    for (let index = 1; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === '--record' && record === undefined) {
        const taken = takeValue(argv, index, '--record');
        record = taken.value;
        index = taken.index;
      } else if (arg === '--format' && format === undefined) {
        const taken = takeValue(argv, index, '--format');
        format = taken.value;
        index = taken.index;
      } else {
        return null;
      }
    }
  } catch {
    return null;
  }
  if (!record || !path.isAbsolute(record) || format !== 'json') return null;
  return { record };
}

export function run(
  argv: string[] = process.argv.slice(2),
  writer: Writer = (text) => process.stdout.write(text),
  options: { homeDir?: string } = {},
): ExitCode {
  if (argv.length === 1 && argv[0] === 'schema') {
    writeJson(writer, {
      ok: true,
      command: 'schema',
      effect: {
        read_only: true,
        network: false,
        credentials: false,
      },
      schemas: {
        validate_input: VALIDATE_INPUT_SCHEMA,
        validate_output: VALIDATE_OUTPUT_SCHEMA,
        record: PRIVATE_OPERATION_RECORD_SCHEMA,
      },
    });
    return 0;
  }

  const parsed = argv[0] === 'validate' ? parseValidateArgs(argv) : null;
  if (parsed === null) {
    writeJson(writer, {
      ok: false,
      command: 'validate',
      errors: [inputError()],
    });
    return 1;
  }

  const result = validatePrivateOperationRecordFile(parsed.record, options);
  if (result.ok) {
    writeJson(writer, {
      ok: true,
      command: 'validate',
      schema_version: result.schemaVersion,
      step_count: result.stepCount,
    });
    return 0;
  }

  writeJson(writer, {
    ok: false,
    command: 'validate',
    errors: result.errors,
  });
  return result.classification === 'infrastructure' ? 2 : 1;
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  process.exitCode = run();
}
