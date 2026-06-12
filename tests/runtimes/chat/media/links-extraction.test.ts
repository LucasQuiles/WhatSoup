import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockDnsLookup,
  mockReadabilityParse,
  mockCheerioLoad,
} = vi.hoisted(() => ({
  mockDnsLookup: vi.fn(async () => ({ address: '93.184.216.34', family: 4 })),
  mockReadabilityParse: vi.fn(),
  mockCheerioLoad: vi.fn(),
}));

vi.mock('node:dns', () => ({
  promises: {
    lookup: mockDnsLookup,
  },
}));

vi.mock('@mozilla/readability', () => ({
  Readability: class {
    parse(): unknown {
      return mockReadabilityParse();
    }
  },
}));

vi.mock('linkedom', () => ({
  parseHTML: vi.fn(() => ({ document: {} })),
}));

vi.mock('cheerio', () => ({
  load: mockCheerioLoad,
}));

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { extractLinkContent } from '../../../../src/runtimes/chat/media/links.ts';

function stubFetchHtml(html = '<html><head><title>Fallback</title></head><body>body</body></html>'): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    text: () => Promise.resolve(html),
    ok: true,
  }));
}

function installCheerioValues(values: { ogTitle?: string; ogDesc?: string; title?: string }): void {
  mockCheerioLoad.mockImplementation(() => (selector: string) => ({
    attr: (name: string) => {
      if (name !== 'content') return undefined;
      if (selector === 'meta[property="og:title"]') return values.ogTitle ?? '';
      if (selector === 'meta[property="og:description"]') return values.ogDesc ?? '';
      return undefined;
    },
    text: () => selector === 'title' ? values.title ?? '' : '',
  }));
}

describe('extractLinkContent extraction fallbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDnsLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
    mockReadabilityParse.mockReturnValue(null);
    installCheerioValues({});
    stubFetchHtml();
  });

  it('returns truncated readability content when readability can parse the page', async () => {
    mockReadabilityParse.mockReturnValue({
      title: 'Readable Title',
      textContent: 'x'.repeat(2_500),
    });

    const result = await extractLinkContent('https://article.example.com/readable');

    expect(result).toEqual({
      title: 'Readable Title',
      content: 'x'.repeat(2_000),
      fallbackLevel: 'readability',
    });
  });

  it('falls back to OpenGraph metadata when readability has no article', async () => {
    installCheerioValues({
      ogTitle: 'OG Title',
      ogDesc: 'OpenGraph description',
    });

    const result = await extractLinkContent('https://article.example.com/meta');

    expect(result).toEqual({
      title: 'OG Title',
      content: 'OpenGraph description',
      fallbackLevel: 'meta',
    });
  });

  it('uses the title tag when readability and OpenGraph metadata are empty', async () => {
    installCheerioValues({ title: 'Only Title' });

    const result = await extractLinkContent('https://article.example.com/title');

    expect(result).toEqual({
      title: 'Only Title',
      content: 'Only Title',
      fallbackLevel: 'title',
    });
  });

  it('uses raw fallback when all extraction strategies fail', async () => {
    mockReadabilityParse.mockImplementation(() => {
      throw new Error('readability failed');
    });
    mockCheerioLoad.mockImplementation(() => {
      throw new Error('cheerio failed');
    });

    const url = 'https://article.example.com/raw';
    const result = await extractLinkContent(url);

    expect(result).toEqual({
      title: url,
      content: "[couldn't fetch content]",
      fallbackLevel: 'raw',
    });
  });
});
