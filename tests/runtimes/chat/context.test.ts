import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadContext } from '../../../src/runtimes/chat/context.ts';
import type { SearchResult, MemoryRecord, EntitySearchResult } from '../../../src/runtimes/chat/providers/pinecone.ts';

vi.mock('../../../src/config.ts', () => ({
  config: { pineconeSearchMode: 'memory', botName: 'Loops' },
}));
vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import * as configModule from '../../../src/config.ts';

// ---- Mock factory ----

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'rec-default',
    text: 'default fact',
    chatJid: 'chat@g.us',
    senderJid: 'alice@s.whatsapp.net',
    senderName: 'Alice',
    memoryType: 'user_fact',
    confidence: 0.9,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    superseded: 'false',
    sourceMessagePks: '1',
    ...overrides,
  };
}

function makeResult(id: string, text: string, score = 0.9): SearchResult {
  return {
    id,
    score,
    record: makeRecord({ id, text }),
  };
}

// Build a mock PineconeMemory object with vi.fn() methods
function makeMockPinecone(
  chatResults: SearchResult[] = [],
  senderResults: SearchResult[] = [],
  selfResults: SearchResult[] = [],
) {
  return {
    searchForChat: vi.fn().mockResolvedValue(chatResults),
    searchForSender: vi.fn().mockResolvedValue(senderResults),
    searchSelfFacts: vi.fn().mockResolvedValue(selfResults),
    search: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue(undefined),
    checkDuplicate: vi.fn().mockResolvedValue({ isDuplicate: false }),
  };
}

describe('loadContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- Positive cases ----

  it('returns "Background knowledge:" header when both searches return results', async () => {
    const pinecone = makeMockPinecone(
      [makeResult('r1', 'chat fact one')],
      [makeResult('r2', 'sender fact two')],
    );

    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      'test query',
    );

    expect(result).toMatch(/^Background knowledge:/);
  });

  it('includes both chat and sender results in the output', async () => {
    const pinecone = makeMockPinecone(
      [makeResult('r1', 'chat fact one')],
      [makeResult('r2', 'sender fact two')],
    );

    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      'test query',
    );

    expect(result).toContain('chat fact one');
    expect(result).toContain('sender fact two');
  });

  it('formats each result on its own line with "- " prefix', async () => {
    const pinecone = makeMockPinecone(
      [makeResult('r1', 'fact alpha'), makeResult('r2', 'fact beta')],
      [],
    );

    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      'test query',
    );

    expect(result).toContain('- fact alpha');
    expect(result).toContain('- fact beta');
    // Each item is on its own line
    const lines = result.split('\n');
    const factLines = lines.filter((l) => l.startsWith('- '));
    expect(factLines).toHaveLength(2);
  });

  it('deduplicates results by id, keeping the chat result when both have the same id', async () => {
    const sharedId = 'shared-id';
    const chatResult = makeResult(sharedId, 'chat version of the fact');
    const senderResult = makeResult(sharedId, 'sender version of the fact');

    const pinecone = makeMockPinecone([chatResult], [senderResult]);

    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      'test query',
    );

    // Only one entry for the shared ID, using the chat version (first seen)
    expect(result).toContain('chat version of the fact');
    expect(result).not.toContain('sender version of the fact');
    const lines = result.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(1);
  });

  it('chat results appear before sender results in the output (insertion order)', async () => {
    const pinecone = makeMockPinecone(
      [makeResult('c1', 'chat fact first')],
      [makeResult('s1', 'sender fact second')],
    );

    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      'test query',
    );

    const idxChat = result.indexOf('chat fact first');
    const idxSender = result.indexOf('sender fact second');
    expect(idxChat).toBeLessThan(idxSender);
  });

  it('passes chatJid and senderJid to the correct search methods', async () => {
    const pinecone = makeMockPinecone([], []);

    await loadContext(
      pinecone as any,
      'mygroup@g.us',
      'myuser@s.whatsapp.net',
      'my query',
    );

    expect(pinecone.searchForChat).toHaveBeenCalledWith('mygroup@g.us', 'my query');
    expect(pinecone.searchForSender).toHaveBeenCalledWith('myuser@s.whatsapp.net', 'my query');
  });

  it('all three searches are called in parallel (all called regardless of the others)', async () => {
    const pinecone = makeMockPinecone(
      [makeResult('r1', 'fact')],
      [makeResult('r2', 'fact2')],
    );

    await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      'query',
    );

    expect(pinecone.searchForChat).toHaveBeenCalledTimes(1);
    expect(pinecone.searchForSender).toHaveBeenCalledTimes(1);
    expect(pinecone.searchSelfFacts).toHaveBeenCalledTimes(1);
  });

  it('handles multiple results from each search, all appearing in output', async () => {
    const chatResults = [
      makeResult('c1', 'chat1'),
      makeResult('c2', 'chat2'),
      makeResult('c3', 'chat3'),
    ];
    const senderResults = [
      makeResult('s1', 'sender1'),
      makeResult('s2', 'sender2'),
    ];
    const pinecone = makeMockPinecone(chatResults, senderResults);

    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      'query',
    );

    expect(result).toContain('chat1');
    expect(result).toContain('chat2');
    expect(result).toContain('chat3');
    expect(result).toContain('sender1');
    expect(result).toContain('sender2');
  });

  // ---- Negative cases ----

  it('returns empty string when both searches return no results', async () => {
    const pinecone = makeMockPinecone([], []);

    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      'test query',
    );

    expect(result).toBe('');
  });

  it('does NOT include the "Background knowledge:" header when both results are empty', async () => {
    const pinecone = makeMockPinecone([], []);

    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      'test query',
    );

    expect(result).not.toContain('Background knowledge:');
  });

  it('still includes sender results when chat search returns empty array', async () => {
    const pinecone = makeMockPinecone([], [makeResult('s1', 'sender only fact')]);

    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      'test query',
    );

    expect(result).toContain('Background knowledge:');
    expect(result).toContain('sender only fact');
  });

  it('still includes chat results when sender search returns empty array', async () => {
    const pinecone = makeMockPinecone([makeResult('c1', 'chat only fact')], []);

    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      'test query',
    );

    expect(result).toContain('Background knowledge:');
    expect(result).toContain('chat only fact');
  });

  it('handles null senderJid without crashing (passes null to searchForSender)', async () => {
    const pinecone = makeMockPinecone([makeResult('c1', 'chat fact')], []);

    // TypeScript would complain, but the runtime must not crash
    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      null as unknown as string,
      'test query',
    );

    // searchForSender called with null — it returns [] because mock is set up that way
    expect(result).toContain('chat fact');
    expect(pinecone.searchForSender).toHaveBeenCalledWith(null, 'test query');
  });

  it('preserves special characters and punctuation in fact text without escaping', async () => {
    const specialText = 'fact with <html> & "quotes" and \'apostrophes\' and emoji 🎉';
    const pinecone = makeMockPinecone([makeResult('r1', specialText)], []);

    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      'test query',
    );

    // Text must appear verbatim — no HTML escaping or character replacement
    expect(result).toContain(specialText);
  });

  it('dedup preserves all unique IDs from both searches', async () => {
    const pinecone = makeMockPinecone(
      [makeResult('a', 'factA'), makeResult('b', 'factB')],
      [makeResult('c', 'factC'), makeResult('b', 'factB-dup')],
    );

    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      'query',
    );

    const lines = result.split('\n').filter((l) => l.startsWith('- '));
    // a, b (chat version), c → 3 unique results
    expect(lines).toHaveLength(3);
    expect(result).toContain('factA');
    expect(result).toContain('factB');
    expect(result).toContain('factC');
    expect(result).not.toContain('factB-dup');
  });

  it('returns empty string when messageText is empty string', async () => {
    const pinecone = makeMockPinecone([], []);

    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      '',
    );

    expect(result).toBe('');
  });

  // ---- Self-fact cases ----

  it('includes self-facts in a separate section with consistency header', async () => {
    const selfFact = makeResult('sf1', 'Loops said he lived in Montreal');
    selfFact.record.memoryType = 'self_fact';
    const pinecone = makeMockPinecone([], [], [selfFact]);

    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      'where do you live',
    );

    expect(result).toContain('Things you (Loops) have said about yourself before');
    expect(result).toContain('Loops said he lived in Montreal');
  });

  it('includes both background knowledge and self-facts when both exist', async () => {
    const selfFact = makeResult('sf1', 'Loops mentioned doing freelance work');
    selfFact.record.memoryType = 'self_fact';
    const pinecone = makeMockPinecone(
      [makeResult('c1', 'Alice works at Google')],
      [],
      [selfFact],
    );

    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      'what do you do for work',
    );

    expect(result).toContain('Background knowledge:');
    expect(result).toContain('Alice works at Google');
    expect(result).toContain('Things you (Loops) have said about yourself before');
    expect(result).toContain('Loops mentioned doing freelance work');
  });

  it('deduplicates self-facts against chat and sender results', async () => {
    const sharedId = 'shared-self';
    const chatResult = makeResult(sharedId, 'chat version');
    const selfResult = makeResult(sharedId, 'self version');
    selfResult.record.memoryType = 'self_fact';
    const pinecone = makeMockPinecone([chatResult], [], [selfResult]);

    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      'query',
    );

    expect(result).toContain('chat version');
    expect(result).not.toContain('self version');
  });

  it('returns only self-facts section when no chat/sender results exist', async () => {
    const selfFact = makeResult('sf1', 'Loops likes electronic music');
    selfFact.record.memoryType = 'self_fact';
    const pinecone = makeMockPinecone([], [], [selfFact]);

    const result = await loadContext(
      pinecone as any,
      'chat@g.us',
      'alice@s.whatsapp.net',
      'what music do you like',
    );

    expect(result).not.toContain('Background knowledge:');
    expect(result).toContain('Things you (Loops) have said about yourself before');
    expect(result).toContain('Loops likes electronic music');
  });
});

// ---------------------------------------------------------------------------
// Entity mode
// ---------------------------------------------------------------------------

function makeEntityResult(
  id: string,
  entityType: string,
  text: string,
  score = 0.88,
): EntitySearchResult {
  return {
    id,
    score,
    record: {
      id,
      text,
      entityType,
      source: 'crm',
      metadata: {},
    },
  };
}

function makeMockPineconeWithEntity(entityResults: EntitySearchResult[] = []) {
  return {
    searchForChat: vi.fn().mockResolvedValue([]),
    searchForSender: vi.fn().mockResolvedValue([]),
    searchSelfFacts: vi.fn().mockResolvedValue([]),
    searchEntities: vi.fn().mockResolvedValue(entityResults),
    search: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue(undefined),
    checkDuplicate: vi.fn().mockResolvedValue({ isDuplicate: false }),
  };
}

describe('loadContext — entity mode', () => {
  const mutableConfig = configModule.config as unknown as Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    mutableConfig.pineconeSearchMode = 'entity';
  });

  afterEach(() => {
    mutableConfig.pineconeSearchMode = 'memory';
  });

  it('calls searchEntities (not searchForChat/searchForSender/searchSelfFacts) in entity mode', async () => {
    const pinecone = makeMockPineconeWithEntity([]);

    await loadContext(pinecone as any, 'chat@g.us', 'alice@s.whatsapp.net', 'find invoice');

    expect(pinecone.searchEntities).toHaveBeenCalledOnce();
    expect(pinecone.searchForChat).not.toHaveBeenCalled();
    expect(pinecone.searchForSender).not.toHaveBeenCalled();
    expect(pinecone.searchSelfFacts).not.toHaveBeenCalled();
  });

  it('passes the message text to searchEntities', async () => {
    const pinecone = makeMockPineconeWithEntity([]);

    await loadContext(pinecone as any, 'chat@g.us', 'alice@s.whatsapp.net', 'find invoice 17088');

    expect(pinecone.searchEntities).toHaveBeenCalledWith('find invoice 17088');
  });

  it('returns empty string when searchEntities returns no results', async () => {
    const pinecone = makeMockPineconeWithEntity([]);

    const result = await loadContext(pinecone as any, 'chat@g.us', 'alice@s.whatsapp.net', 'find building');

    expect(result).toBe('');
  });

  it('output is grouped by entity type with correct section labels', async () => {
    const pinecone = makeMockPineconeWithEntity([
      makeEntityResult('bld-1', 'building', 'BUILDING: 1240 Westchester Ave'),
      makeEntityResult('inv-1', 'invoice', 'CUSTOMER: 370 CPW...'),
    ]);

    const result = await loadContext(pinecone as any, 'chat@g.us', 'alice@s.whatsapp.net', 'query');

    expect(result).toContain('Buildings:');
    expect(result).toContain('Invoices:');
    expect(result).toContain('BUILDING: 1240 Westchester Ave');
    expect(result).toContain('CUSTOMER: 370 CPW...');
  });

  it('output starts with the "Background data" framing header', async () => {
    const pinecone = makeMockPineconeWithEntity([
      makeEntityResult('b1', 'building', 'BUILDING: 100 Main St'),
    ]);

    const result = await loadContext(pinecone as any, 'chat@g.us', 'alice@s.whatsapp.net', 'find building');

    expect(result).toMatch(/^Background data/);
  });

  it('groups multiple records of the same entity type under one label', async () => {
    const pinecone = makeMockPineconeWithEntity([
      makeEntityResult('b1', 'building', 'BUILDING: 100 Main St'),
      makeEntityResult('b2', 'building', 'BUILDING: 200 Elm Ave'),
    ]);

    const result = await loadContext(pinecone as any, 'chat@g.us', 'alice@s.whatsapp.net', 'query');

    // Only one 'Buildings:' heading, both records present
    const matches = [...result.matchAll(/Buildings:/g)];
    expect(matches).toHaveLength(1);
    expect(result).toContain('BUILDING: 100 Main St');
    expect(result).toContain('BUILDING: 200 Elm Ave');
  });

  it('entity mode: output does NOT include memory-mode headers', async () => {
    const pinecone = makeMockPineconeWithEntity([
      makeEntityResult('c1', 'contact', 'CONTACT/CUSTOMER: LOGICAL BUILDINGS'),
    ]);

    const result = await loadContext(pinecone as any, 'chat@g.us', 'alice@s.whatsapp.net', 'logical buildings');

    expect(result).not.toContain('Background knowledge:');
    expect(result).not.toContain('Things you (Loops) have said about yourself before');
  });

  it('entity mode: notes results appear under "Notes:" label (no double-s)', async () => {
    const pinecone = makeMockPineconeWithEntity([
      makeEntityResult('n1', 'notes', 'Finance meeting transcript — Q4 budget review'),
    ]);

    const result = await loadContext(pinecone as any, 'chat@g.us', 'alice@s.whatsapp.net', 'budget');

    expect(result).toContain('Notes:');
    expect(result).not.toContain('Notess');
    expect(result).toContain('Finance meeting transcript — Q4 budget review');
  });

  it('returns empty string when messageText is blank (entity mode)', async () => {
    const pinecone = makeMockPineconeWithEntity([
      makeEntityResult('b1', 'building', 'BUILDING: 100 Main St'),
    ]);

    const result = await loadContext(pinecone as any, 'chat@g.us', 'alice@s.whatsapp.net', '   ');

    // Blank message text short-circuits before hitting the entity branch
    expect(result).toBe('');
    expect(pinecone.searchEntities).not.toHaveBeenCalled();
  });
});
