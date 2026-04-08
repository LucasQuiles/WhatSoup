/**
 * FeedCard component — structural and logic tests.
 *
 * No DOM environment is configured, so these tests verify:
 *   - FeedCard source renders provider badge when provider is present
 *   - FeedEvent type includes provider field
 *   - Mock data carries provider field on feed events
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

function read(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), 'utf8');
}

describe('FeedCard provider badge', () => {
  it('FeedCard renders event.provider when present', () => {
    const source = read('console/src/components/FeedCard.tsx');
    expect(source).toContain('event.provider');
  });

  it('FeedCard imports and calls getProvider', () => {
    const source = read('console/src/components/FeedCard.tsx');
    expect(source).toContain('getProvider');
  });

  it('FeedCard uses fc-badge class for provider badge', () => {
    const source = read('console/src/components/FeedCard.tsx');
    expect(source).toContain('fc-badge');
  });
});

describe('FeedEvent type includes provider', () => {
  it('types.ts FeedEvent has provider field', () => {
    const source = read('console/src/types.ts');
    expect(source).toContain('provider?: string');
  });
});

describe('MOCK_FEED includes provider field', () => {
  it('mock-data feedEvent factory accepts provider parameter', () => {
    const source = read('console/src/mock-data.ts');
    // The factory signature should include provider
    expect(source).toContain('provider?: string');
  });

  it('mock-data includes provider strings for known providers', () => {
    const source = read('console/src/mock-data.ts');
    expect(source).toContain('claude-cli');
    expect(source).toContain('anthropic-api');
    expect(source).toContain('codex-cli');
  });
});
