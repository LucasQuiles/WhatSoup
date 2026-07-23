type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: JsonObject, allowed: readonly string[]): boolean {
  const allow = new Set(allowed);
  return Object.keys(value).every((key) => allow.has(key));
}

function validOptionalTokenCount(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function validUsage(value: unknown, keys: readonly string[]): boolean {
  if (!isObject(value)) return false;
  return hasOnlyKeys(value, keys) && keys.every((key) => validOptionalTokenCount(value[key]));
}

function validOpenAIUsage(value: unknown): boolean {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'prompt_tokens_details',
    'completion_tokens_details',
  ])) return false;
  if (!['prompt_tokens', 'completion_tokens', 'total_tokens']
    .every((key) => validOptionalTokenCount(value[key]))) return false;
  if (value['prompt_tokens_details'] !== undefined
    && !validUsage(value['prompt_tokens_details'], ['cached_tokens', 'audio_tokens'])) return false;
  return value['completion_tokens_details'] === undefined
    || validUsage(value['completion_tokens_details'], [
      'accepted_prediction_tokens',
      'audio_tokens',
      'reasoning_tokens',
      'rejected_prediction_tokens',
    ]);
}

function validAnthropicUsage(value: unknown): boolean {
  if (!isObject(value) || !hasOnlyKeys(value, [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'cache_creation',
    'server_tool_use',
  ])) return false;
  if (![
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ].every((key) => validOptionalTokenCount(value[key]))) return false;
  if (value['cache_creation'] !== undefined && !validUsage(value['cache_creation'], [
    'ephemeral_5m_input_tokens',
    'ephemeral_1h_input_tokens',
  ])) return false;
  return value['server_tool_use'] === undefined || validUsage(value['server_tool_use'], [
    'web_search_requests',
    'web_fetch_requests',
  ]);
}

interface OpenAIToolState {
  sawArguments: boolean;
}

const OPENAI_FINISH_REASONS = new Set([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'function_call',
]);
const OPENAI_SERVICE_TIERS = new Set(['auto', 'default', 'flex', 'scale', 'priority']);

function validOpenAIEnvelopeMetadata(chunk: JsonObject): boolean {
  if (hasOwn(chunk, 'id')
    && (typeof chunk['id'] !== 'string' || chunk['id'].length === 0)) return false;
  if (hasOwn(chunk, 'object') && chunk['object'] !== 'chat.completion.chunk') return false;
  if (hasOwn(chunk, 'created') && !isNonNegativeInteger(chunk['created'])) return false;
  if (hasOwn(chunk, 'model')
    && (typeof chunk['model'] !== 'string' || chunk['model'].length === 0)) return false;
  if (hasOwn(chunk, 'service_tier')
    && chunk['service_tier'] !== null
    && (typeof chunk['service_tier'] !== 'string'
      || !OPENAI_SERVICE_TIERS.has(chunk['service_tier']))) return false;
  return !hasOwn(chunk, 'system_fingerprint')
    || chunk['system_fingerprint'] === null
    || typeof chunk['system_fingerprint'] === 'string';
}

export interface RestrictedStreamGrammar {
  observe(value: JsonObject, eventName?: string): boolean;
  finish(): boolean;
}

/** Stateful closed grammar for restricted OpenAI-compatible chat-completion SSE data. */
export function createOpenAIRestrictedStreamGrammar(): RestrictedStreamGrammar {
  const tools = new Map<number, OpenAIToolState>();
  let sawChoice = false;
  let sawRole = false;
  let finished = false;

  return {
    observe(chunk, eventName) {
      if (eventName !== undefined) return false;
      if (!hasOnlyKeys(chunk, [
        'id',
        'object',
        'created',
        'model',
        'service_tier',
        'system_fingerprint',
        'choices',
        'usage',
      ])) return false;
      if (!validOpenAIEnvelopeMetadata(chunk)) return false;
      const hasChoices = hasOwn(chunk, 'choices');
      const hasUsage = hasOwn(chunk, 'usage') && chunk['usage'] !== null;
      if (!hasChoices && !hasUsage) return false;
      if (hasOwn(chunk, 'usage') && chunk['usage'] !== null
        && !validOpenAIUsage(chunk['usage'])) {
        return false;
      }
      if (!hasChoices) return hasUsage;

      const choices = chunk['choices'];
      if (!Array.isArray(choices)) return false;
      if (choices.length === 0) return hasUsage;
      if (choices.length !== 1 || finished) return false;

      const choice = choices[0];
      if (!isObject(choice) || choice['index'] !== 0 || !isObject(choice['delta'])) {
        return false;
      }
      if (!hasOnlyKeys(choice, ['index', 'delta', 'finish_reason'])) return false;
      const finishReason = choice['finish_reason'];
      if (finishReason !== undefined && finishReason !== null
        && (typeof finishReason !== 'string' || !OPENAI_FINISH_REASONS.has(finishReason))) {
        return false;
      }
      const delta = choice['delta'];
      if (!hasOnlyKeys(delta, ['role', 'content', 'tool_calls'])) return false;
      const isFinished = typeof finishReason === 'string';
      if (isFinished) {
        if (Object.keys(delta).length !== 0) return false;
        if ((tools.size > 0) !== (finishReason === 'tool_calls')) return false;
        finished = true;
        sawChoice = true;
        return true;
      }

      let recognized = false;
      if (hasOwn(delta, 'role')) {
        if (delta['role'] !== 'assistant' || sawRole || sawChoice) return false;
        sawRole = true;
        recognized = true;
      }
      if (hasOwn(delta, 'content')) {
        if (delta['content'] !== null && typeof delta['content'] !== 'string') return false;
        recognized = true;
      }
      if (hasOwn(delta, 'tool_calls')) {
        const toolCalls = delta['tool_calls'];
        if (!Array.isArray(toolCalls) || toolCalls.length === 0) return false;
        recognized = true;
        for (const toolCall of toolCalls) {
          if (!isObject(toolCall) || !isNonNegativeInteger(toolCall['index'])) return false;
          if (!hasOnlyKeys(toolCall, ['index', 'id', 'type', 'function'])) return false;
          const index = toolCall['index'];
          const existing = tools.get(index);
          if (!existing) {
            if (index !== tools.size
              || typeof toolCall['id'] !== 'string' || toolCall['id'].length === 0
              || toolCall['type'] !== 'function'
              || !isObject(toolCall['function'])
              || typeof toolCall['function']['name'] !== 'string'
              || toolCall['function']['name'].length === 0) {
              return false;
            }
            const args = toolCall['function']['arguments'];
            if (!hasOnlyKeys(toolCall['function'], ['name', 'arguments'])) return false;
            if (args !== undefined && typeof args !== 'string') return false;
            tools.set(index, { sawArguments: typeof args === 'string' });
          } else {
            if (hasOwn(toolCall, 'id') || hasOwn(toolCall, 'type') || !isObject(toolCall['function'])) {
              return false;
            }
            const fn = toolCall['function'];
            if (!hasOnlyKeys(fn, ['arguments'])) return false;
            if (hasOwn(fn, 'name') || typeof fn['arguments'] !== 'string') return false;
            existing.sawArguments = true;
          }
        }
      }
      if (!recognized) return false;
      sawChoice = true;
      return true;
    },
    finish() {
      return sawChoice && finished
        && Array.from(tools.values()).every((tool) => tool.sawArguments);
    },
  };
}

type AnthropicBlockState =
  | { type: 'text' }
  | { type: 'tool_use'; sawInput: boolean };

const ANTHROPIC_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
  'model_context_window_exceeded',
]);

/** Stateful closed grammar for restricted Anthropic Messages SSE data. */
export function createAnthropicRestrictedStreamGrammar(): RestrictedStreamGrammar {
  const blocks = new Map<number, AnthropicBlockState>();
  const stopped = new Set<number>();
  let sawMessageStart = false;
  let sawMessageDelta = false;
  let sawMessageStop = false;
  let sawToolUse = false;
  let nextBlockIndex = 0;

  return {
    observe(event, eventName) {
      if (typeof event['type'] !== 'string') return false;
      if (eventName !== undefined && eventName !== event['type']) return false;
      if (sawMessageStop) return false;
      switch (event['type']) {
        case 'message_start': {
          if (sawMessageStart || sawMessageDelta || blocks.size > 0
            || !hasOnlyKeys(event, ['type', 'message']) || !isObject(event['message'])) return false;
          if (!hasOnlyKeys(event['message'], [
            'id',
            'type',
            'role',
            'content',
            'model',
            'stop_reason',
            'stop_sequence',
            'usage',
          ])) return false;
          if (hasOwn(event['message'], 'content')
            && (!Array.isArray(event['message']['content'])
              || event['message']['content'].length !== 0)) return false;
          if (hasOwn(event['message'], 'id')
            && (typeof event['message']['id'] !== 'string'
              || event['message']['id'].length === 0)) return false;
          if (hasOwn(event['message'], 'type') && event['message']['type'] !== 'message') return false;
          if (hasOwn(event['message'], 'role') && event['message']['role'] !== 'assistant') return false;
          if (hasOwn(event['message'], 'model')
            && (typeof event['message']['model'] !== 'string'
              || event['message']['model'].length === 0)) return false;
          if (hasOwn(event['message'], 'stop_reason') && event['message']['stop_reason'] !== null) return false;
          if (hasOwn(event['message'], 'stop_sequence') && event['message']['stop_sequence'] !== null) return false;
          const usage = event['message']['usage'];
          if (usage !== undefined && !validAnthropicUsage(usage)) return false;
          sawMessageStart = true;
          return true;
        }
        case 'ping':
          return sawMessageStart && hasOnlyKeys(event, ['type']);
        case 'content_block_start': {
          if (!sawMessageStart || sawMessageDelta
            || !hasOnlyKeys(event, ['type', 'index', 'content_block'])
            || !isNonNegativeInteger(event['index']) || event['index'] !== nextBlockIndex
            || blocks.has(event['index'])
            || stopped.has(event['index']) || !isObject(event['content_block'])) return false;
          const block = event['content_block'];
          if (block['type'] === 'text') {
            if (!hasOnlyKeys(block, ['type', 'text']) || block['text'] !== '') return false;
            blocks.set(event['index'], { type: 'text' });
            return true;
          }
          if (block['type'] === 'tool_use') {
            if (!hasOnlyKeys(block, ['type', 'id', 'name', 'input'])
              || typeof block['id'] !== 'string' || block['id'].length === 0
              || typeof block['name'] !== 'string' || block['name'].length === 0
              || (hasOwn(block, 'input')
                && (!isObject(block['input']) || !hasOnlyKeys(block['input'], [])))) return false;
            blocks.set(event['index'], { type: 'tool_use', sawInput: false });
            sawToolUse = true;
            return true;
          }
          return false;
        }
        case 'content_block_delta': {
          if (!hasOnlyKeys(event, ['type', 'index', 'delta'])
            || !isNonNegativeInteger(event['index']) || !isObject(event['delta'])) return false;
          const block = blocks.get(event['index']);
          if (!block) return false;
          const delta = event['delta'];
          if (block.type === 'text') {
            return hasOnlyKeys(delta, ['type', 'text'])
              && delta['type'] === 'text_delta' && typeof delta['text'] === 'string';
          }
          if (!hasOnlyKeys(delta, ['type', 'partial_json'])
            || delta['type'] !== 'input_json_delta' || typeof delta['partial_json'] !== 'string') {
            return false;
          }
          block.sawInput = true;
          return true;
        }
        case 'content_block_stop': {
          if (!hasOnlyKeys(event, ['type', 'index']) || !isNonNegativeInteger(event['index'])) return false;
          const block = blocks.get(event['index']);
          if (!block || (block.type === 'tool_use' && !block.sawInput)) return false;
          blocks.delete(event['index']);
          stopped.add(event['index']);
          nextBlockIndex += 1;
          return true;
        }
        case 'message_delta': {
          if (!sawMessageStart || sawMessageDelta || !hasOnlyKeys(event, ['type', 'delta', 'usage'])
            || !isObject(event['delta']) || blocks.size > 0) return false;
          const delta = event['delta'];
          if (!hasOnlyKeys(delta, ['stop_reason', 'stop_sequence'])) return false;
          const stopReason = delta['stop_reason'];
          if (typeof stopReason !== 'string' || !ANTHROPIC_STOP_REASONS.has(stopReason)) return false;
          if (sawToolUse !== (stopReason === 'tool_use')) return false;
          const stopSequence = delta['stop_sequence'];
          if (stopReason === 'stop_sequence') {
            if (typeof stopSequence !== 'string' || stopSequence.length === 0) return false;
          } else if (stopSequence !== undefined && stopSequence !== null) return false;
          if (event['usage'] !== undefined && !validAnthropicUsage(event['usage'])) return false;
          sawMessageDelta = true;
          return true;
        }
        case 'message_stop': {
          if (!sawMessageStart || !sawMessageDelta
            || !hasOnlyKeys(event, ['type']) || blocks.size > 0) return false;
          sawMessageStop = true;
          return true;
        }
        default:
          return false;
      }
    },
    finish() {
      return sawMessageStart && sawMessageDelta && sawMessageStop && blocks.size === 0;
    },
  };
}
