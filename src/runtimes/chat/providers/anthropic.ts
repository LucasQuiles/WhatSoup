import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../../config.ts';
import { createChildLogger } from '../../../logger.ts';
import { WhatSoupError as AppError } from '../../../errors.ts';
import type { LLMProvider, GenerateRequest, GenerateResponse, ChatMessage } from './types.ts';
import { classifyApiError, extractStatusCode } from './api-error-classifier.ts';

const logger = createChildLogger('anthropic-provider');

function toAnthropicMessage(m: ChatMessage): Anthropic.MessageParam {
  if (!m.images || m.images.length === 0) {
    return { role: m.role, content: m.content };
  }

  const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
  if (m.content) {
    content.push({ type: 'text', text: m.content });
  }
  for (const img of m.images) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mimeType as Anthropic.Base64ImageSource['media_type'],
        data: img.base64,
      },
    });
  }
  return { role: m.role, content };
}

export function createAnthropicProvider(): LLMProvider {
  const client = new Anthropic();

  return {
    name: 'anthropic',

    async generate(request: GenerateRequest): Promise<GenerateResponse> {
      const { model, maxTokens, systemPrompt, messages } = request;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.apiTimeoutMs);

      const startMs = Date.now();
      let response: Anthropic.Message;
      try {
        response = await client.messages.create(
          {
            model,
            max_tokens: maxTokens,
            system: systemPrompt,
            messages: messages.map(toAnthropicMessage),
          },
          { signal: controller.signal },
        );
      } catch (err) {
        const elapsed_ms = Date.now() - startMs;
        const errorType = classifyApiError(err);
        const statusCode = extractStatusCode(err);
        logger.error(
          { errorType, statusCode, provider: 'anthropic', model, elapsed_ms, err },
          'llm_api_error',
        );
        if (errorType === 'timeout') {
          throw new AppError('Anthropic request timed out', 'LLM_TIMEOUT', err);
        }
        if (errorType === 'auth') {
          throw new AppError('Anthropic auth failed', 'LLM_AUTH_ERROR', err);
        }
        if (errorType === 'rate_limit') {
          throw new AppError('Anthropic rate limited', 'LLM_RATE_LIMITED', err);
        }
        throw new AppError('Anthropic request failed', 'LLM_UNAVAILABLE', err);
      } finally {
        clearTimeout(timeout);
      }

      const durationMs = Date.now() - startMs;

      const block = response.content[0];
      if (!block || block.type !== 'text') {
        logger.error({ model, provider: 'anthropic', response }, 'Unexpected response shape from Anthropic');
        throw new AppError('Unexpected response shape from Anthropic', 'LLM_UNAVAILABLE');
      }

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;

      logger.info(
        { model, provider: 'anthropic', inputTokens, outputTokens, durationMs },
        'Anthropic generate complete',
      );

      return {
        content: block.text,
        inputTokens,
        outputTokens,
        model: response.model,
        durationMs,
      };
    },
  };
}
