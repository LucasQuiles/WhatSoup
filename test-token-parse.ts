// test-token-parse.ts
// Tests that parseEvent extracts accurate token counts from Claude Code result events.
// "Accurate" means including cache_creation_input_tokens and cache_read_input_tokens.

import { parseEvent } from './src/runtimes/agent/stream-parser.ts';
import { extractTokenCounts } from './src/runtimes/agent/providers/parser-utils.ts';

// Real result event from Claude Code (turn 1 — mostly cache creation)
const turn1 = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '1',
  usage: {
    input_tokens: 3,
    cache_creation_input_tokens: 33243,
    cache_read_input_tokens: 0,
    output_tokens: 32,
  },
});

// Real result event from Claude Code (turn 2 — mostly cache read)
const turn2 = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '2',
  usage: {
    input_tokens: 3,
    cache_creation_input_tokens: 20084,
    cache_read_input_tokens: 13262,
    output_tokens: 5,
  },
});

// Real result event from Claude Code (turn 3 — almost all cache read)
const turn3 = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '3',
  usage: {
    input_tokens: 3,
    cache_creation_input_tokens: 14,
    cache_read_input_tokens: 33346,
    output_tokens: 5,
  },
});

// Edge case: no usage field at all
const noUsage = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
});

// Edge case: usage with only input_tokens (no cache fields)
const noCacheFields = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  usage: {
    input_tokens: 500,
    output_tokens: 100,
  },
});

let pass = true;

function check(label: string, event: ReturnType<typeof parseEvent>, expectInput: number, expectOutput: number) {
  if (!event || event.type !== 'result') {
    console.log(`FAIL: ${label} — not a result event`);
    pass = false;
    return;
  }
  const { inputTokens, outputTokens } = event;
  const inOk = inputTokens === expectInput;
  const outOk = outputTokens === expectOutput;
  if (inOk && outOk) {
    console.log(`OK:   ${label} — in=${inputTokens} out=${outputTokens}`);
  } else {
    console.log(`FAIL: ${label} — got in=${inputTokens} out=${outputTokens}, expected in=${expectInput} out=${expectOutput}`);
    pass = false;
  }
}

// Turn 1: 3 + 33243 + 0 = 33246 input, 32 output
check('turn1 (cache creation)', parseEvent(turn1), 33246, 32);

// Turn 2: 3 + 20084 + 13262 = 33349 input, 5 output
check('turn2 (mixed cache)', parseEvent(turn2), 33349, 5);

// Turn 3: 3 + 14 + 33346 = 33363 input, 5 output
check('turn3 (cache read)', parseEvent(turn3), 33363, 5);

// No usage: both should be undefined
const noUsageEvent = parseEvent(noUsage);
if (noUsageEvent?.type === 'result' && noUsageEvent.inputTokens === undefined && noUsageEvent.outputTokens === undefined) {
  console.log('OK:   no-usage — both undefined');
} else {
  console.log(`FAIL: no-usage — expected undefined/undefined, got ${(noUsageEvent as any)?.inputTokens}/${(noUsageEvent as any)?.outputTokens}`);
  pass = false;
}

// No cache fields: should just use input_tokens as-is (500)
check('no-cache-fields', parseEvent(noCacheFields)!, 500, 100);

// ── extractTokenCounts (parser-utils) — used by Codex/Gemini ──────────────

function checkExtract(label: string, result: { inputTokens?: number; outputTokens?: number }, expectInput: number, expectOutput: number) {
  const inOk = result.inputTokens === expectInput;
  const outOk = result.outputTokens === expectOutput;
  if (inOk && outOk) {
    console.log(`OK:   ${label} — in=${result.inputTokens} out=${result.outputTokens}`);
  } else {
    console.log(`FAIL: ${label} — got in=${result.inputTokens} out=${result.outputTokens}, expected in=${expectInput} out=${expectOutput}`);
    pass = false;
  }
}

// Codex-style usage with cache fields at top level
checkExtract('extractTokenCounts: top-level cache',
  extractTokenCounts({ input_tokens: 5, output_tokens: 20, cache_creation_input_tokens: 10000, cache_read_input_tokens: 5000 }),
  15005, 20);

// Nested under usage (Anthropic API style)
checkExtract('extractTokenCounts: nested usage cache',
  extractTokenCounts({ usage: { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 8000, cache_read_input_tokens: 2000 } }),
  10010, 50);

// No cache fields — unchanged behavior
checkExtract('extractTokenCounts: no cache',
  extractTokenCounts({ input_tokens: 100, output_tokens: 200 }),
  100, 200);

console.log('');
if (pass) {
  console.log('METRIC: PASS');
  console.log('TOKEN_ACCURACY: 1');
} else {
  console.log('METRIC: FAIL');
  console.log('TOKEN_ACCURACY: 0');
}

process.exit(pass ? 0 : 1);
