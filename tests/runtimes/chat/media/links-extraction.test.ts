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

vi.mock('../../../../src/logger.ts', async () => (await import('../../../helpers/logger-mock.ts')).loggerMock());

import { extractLinkContent, isPrivateHost, isPrivateIP } from '../../../../src/runtimes/chat/media/links.ts';

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

  it('falls back to the URL as readability title when only text content is present', async () => {
    mockReadabilityParse.mockReturnValue({
      title: undefined,
      textContent: 'readable body',
    });

    const result = await extractLinkContent('https://article.example.com/readability-no-title');

    expect(result).toEqual({
      title: 'https://article.example.com/readability-no-title',
      content: 'readable body',
      fallbackLevel: 'readability',
    });
  });

  it('normalizes missing readability text content to an empty string', async () => {
    mockReadabilityParse.mockReturnValue({
      title: 'Title without body',
      textContent: undefined,
    });

    const result = await extractLinkContent('https://article.example.com/readability-no-body');

    expect(result).toEqual({
      title: 'Title without body',
      content: '',
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

  it('falls back to the URL as OpenGraph title when only description is present', async () => {
    installCheerioValues({
      ogDesc: 'description only',
    });

    const result = await extractLinkContent('https://article.example.com/meta-description-only');

    expect(result).toEqual({
      title: 'https://article.example.com/meta-description-only',
      content: 'description only',
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

  it('normalizes missing OpenGraph attributes before falling through to raw fallback', async () => {
    mockCheerioLoad.mockImplementation(() => () => ({
      attr: () => undefined,
      text: () => '',
    }));

    const url = 'https://article.example.com/no-meta-attributes';
    const result = await extractLinkContent(url);

    expect(result).toEqual({
      title: url,
      content: "[couldn't fetch content]",
      fallbackLevel: 'raw',
    });
  });

  it('uses raw fallback when fetch rejects after public DNS resolution', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const url = 'https://article.example.com/fetch-error';
    const result = await extractLinkContent(url);

    expect(mockDnsLookup).toHaveBeenCalledWith('article.example.com');
    expect(result).toEqual({
      title: url,
      content: "[couldn't fetch content]",
      fallbackLevel: 'raw',
    });
  });

  it('uses raw fallback for malformed URLs after fetch failure without DNS lookup', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('invalid URL')));

    const result = await extractLinkContent('not a url');

    expect(mockDnsLookup).not.toHaveBeenCalled();
    expect(result).toEqual({
      title: 'not a url',
      content: "[couldn't fetch content]",
      fallbackLevel: 'raw',
    });
  });

  it('blocks private hostnames before DNS or fetch', async () => {
    const result = await extractLinkContent('http://localhost/private');

    expect(mockDnsLookup).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      title: 'http://localhost/private',
      content: '[blocked: private host]',
      fallbackLevel: 'raw',
    });
  });

  it('blocks public hostnames that resolve to private IPs', async () => {
    mockDnsLookup.mockResolvedValue({ address: '169.254.169.254', family: 4 });

    const result = await extractLinkContent('https://metadata.example.com/latest');

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      title: 'https://metadata.example.com/latest',
      content: '[blocked: private host]',
      fallbackLevel: 'raw',
    });
  });

  it('uses raw fallback when DNS resolution fails', async () => {
    mockDnsLookup.mockRejectedValue(new Error('ENOTFOUND'));

    const result = await extractLinkContent('https://missing.example.com/article');

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toEqual({
      title: 'https://missing.example.com/article',
      content: "[couldn't fetch content]",
      fallbackLevel: 'raw',
    });
  });
});

describe('private host and IP guards', () => {
  it('classifies local and private hostnames as private', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('0.0.0.0')).toBe(true);
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isPrivateHost('127.10.0.1')).toBe(true);
    expect(isPrivateHost('10.1.2.3')).toBe(true);
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
    expect(isPrivateHost('192.168.1.10')).toBe(true);
    expect(isPrivateHost('169.254.1.2')).toBe(true);
  });

  it('allows public hostnames and IPs', () => {
    expect(isPrivateHost('172.32.0.1')).toBe(false);
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateIP('8.8.8.8')).toBe(false);
    expect(isPrivateIP('2001:4860:4860::8888')).toBe(false);
  });

  it('classifies private and loopback resolved IPs as private', () => {
    expect(isPrivateIP('10.0.0.1')).toBe(true);
    expect(isPrivateIP('172.20.0.1')).toBe(true);
    expect(isPrivateIP('192.168.0.1')).toBe(true);
    expect(isPrivateIP('127.0.0.1')).toBe(true);
    expect(isPrivateIP('169.254.169.254')).toBe(true);
    expect(isPrivateIP('0.0.0.0')).toBe(true);
    expect(isPrivateIP('::1')).toBe(true);
    expect(isPrivateIP('::')).toBe(true);
  });
});
