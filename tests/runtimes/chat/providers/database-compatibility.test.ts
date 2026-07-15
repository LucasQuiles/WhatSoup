import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../../../src/core/database.ts';
import { DatabaseCompatibilityError } from '../../../../src/core/database-compatibility.ts';
import { withDatabaseCompatibility } from '../../../../src/runtimes/chat/providers/database-compatibility.ts';
import type {
  GenerateRequest,
  GenerateResponse,
  LLMProvider,
} from '../../../../src/runtimes/chat/providers/types.ts';

const request: GenerateRequest = {
  model: 'test-model',
  maxTokens: 128,
  systemPrompt: 'system',
  messages: [{ role: 'user', content: 'hello' }],
};

function makeDatabase(assertion: () => void): Database {
  return {
    assertWritableCompatibility: vi.fn(assertion),
  } as unknown as Database;
}

describe('withDatabaseCompatibility', () => {
  it('notifies the runtime before propagating the exact compatibility rejection', async () => {
    const rejection = new DatabaseCompatibilityError(
      'future_schema',
      'database compatibility drained',
      undefined,
      45,
    );
    const db = makeDatabase(() => {
      throw rejection;
    });
    const onCompatibilityRejection = vi.fn();
    const delegate: LLMProvider = {
      name: 'primary',
      generate: vi.fn(),
    };

    const provider = withDatabaseCompatibility(db, delegate, onCompatibilityRejection);

    await expect(provider.generate(request)).rejects.toBe(rejection);
    expect(db.assertWritableCompatibility).toHaveBeenCalledTimes(1);
    expect(onCompatibilityRejection).toHaveBeenCalledOnce();
    expect(onCompatibilityRejection).toHaveBeenCalledWith(rejection);
    expect(delegate.generate).not.toHaveBeenCalled();
  });

  it('does not report an unrelated assertion failure as database compatibility loss', async () => {
    const rejection = new Error('database unavailable');
    const db = makeDatabase(() => { throw rejection; });
    const onCompatibilityRejection = vi.fn();
    const delegate: LLMProvider = { name: 'primary', generate: vi.fn() };

    const provider = withDatabaseCompatibility(db, delegate, onCompatibilityRejection);

    await expect(provider.generate(request)).rejects.toBe(rejection);
    expect(onCompatibilityRejection).not.toHaveBeenCalled();
    expect(delegate.generate).not.toHaveBeenCalled();
  });

  it('asserts compatibility before one delegate call and preserves name and response', async () => {
    const db = makeDatabase(() => undefined);
    const response: GenerateResponse = {
      content: 'unchanged',
      inputTokens: 7,
      outputTokens: 3,
      model: 'test-model',
      durationMs: 11,
    };
    const delegate: LLMProvider = {
      name: 'provider-name',
      generate: vi.fn().mockResolvedValue(response),
    };

    const provider = withDatabaseCompatibility(db, delegate);
    const result = await provider.generate(request);

    expect(provider.name).toBe(delegate.name);
    expect(result).toBe(response);
    expect(db.assertWritableCompatibility).toHaveBeenCalledTimes(1);
    expect(delegate.generate).toHaveBeenCalledTimes(1);
    expect(delegate.generate).toHaveBeenCalledWith(request);
    expect(vi.mocked(db.assertWritableCompatibility).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(delegate.generate).mock.invocationCallOrder[0]!);
  });
});
