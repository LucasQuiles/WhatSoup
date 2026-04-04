import OpenAI from 'openai';
import { config } from '../../../config.ts';
import { createChildLogger } from '../../../logger.ts';
import { WhatSoupError as AppError } from '../../../errors.ts';
import type { LLMProvider, GenerateRequest, GenerateResponse, ChatMessage } from './types.ts';
import { classifyApiError, extractStatusCode } from './api-error-classifier.ts';

const logger = createChildLogger('openai-provider');

function toOpenAIMessage(m: ChatMessage): OpenAI.Chat.ChatCompletionMessageParam {
  if (!m.images || m.images.length === 0) {
    return { role: m.role, content: m.content };
  }

  const content: Array<OpenAI.Chat.ChatCompletionContentPart> = [];
  if (m.content) {
    content.push({ type: 'text', text: m.content });
  }
  for (const img of m.images) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    });
  }

  if (m.role === 'assistant') {
    return { role: 'assistant', content: content as OpenAI.Chat.ChatCompletionContentPartText[] };
  }
  return { role: 'user', content };
}

export function createOpenAIProvider(): LLMProvider {
  const client = new OpenAI();

  return {
    name: 'openai',

    async generate(request: GenerateRequest): Promise<GenerateResponse> {
      const { model, maxTokens, systemPrompt, messages } = request;

      const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...messages.map(toOpenAIMessage),
      ];

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.apiTimeoutMs);

      const startMs = Date.now();
      let response: OpenAI.Chat.ChatCompletion;
      try {
        response = await client.chat.completions.create(
          {
            model,
            max_tokens: maxTokens,
            messages: chatMessages,
          },
          { signal: controller.signal },
        );
      } catch (err) {
        const elapsed_ms = Date.now() - startMs;
        const errorType = classifyApiError(err);
        const statusCode = extractStatusCode(err);
        logger.error(
          { errorType, statusCode, provider: 'openai', model, elapsed_ms, err },
          'llm_api_error',
        );
        if (errorType === 'timeout') {
          throw new AppError('OpenAI request timed out', 'LLM_TIMEOUT', err);
        }
        if (errorType === 'auth') {
          throw new AppError('OpenAI auth failed', 'LLM_AUTH_ERROR', err);
        }
        if (errorType === 'rate_limit') {
          throw new AppError('OpenAI rate limited', 'LLM_RATE_LIMITED', err);
        }
        throw new AppError('OpenAI request failed', 'LLM_UNAVAILABLE', err);
      } finally {
        clearTimeout(timeout);
      }

      const durationMs = Date.now() - startMs;

      const choice = response.choices[0];
      if (!choice?.message?.content) {
        logger.error({ model, provider: 'openai', response }, 'Unexpected response shape from OpenAI');
        throw new AppError('Unexpected response shape from OpenAI', 'LLM_UNAVAILABLE');
      }

      const inputTokens = response.usage?.prompt_tokens ?? 0;
      const outputTokens = response.usage?.completion_tokens ?? 0;

      logger.info(
        { model, provider: 'openai', inputTokens, outputTokens, durationMs },
        'OpenAI generate complete',
      );

      return {
        content: choice.message.content,
        inputTokens,
        outputTokens,
        model: response.model,
        durationMs,
      };
    },
  };
}
