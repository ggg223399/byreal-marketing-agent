import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAdapter } from '../collector/adapters/mock.js';
import { TwitterApiIoAdapter } from '../collector/adapters/twitterapiio.js';
import { TwitterV2Adapter } from '../collector/adapters/twitter-v2.js';
import { XpozAdapter } from '../collector/adapters/xpoz.js';
import type { CollectorConfig } from '../types/index.js';

const config: CollectorConfig = {
  dataSource: { type: 'twitterapi_io', apiKey: 'k' },
  monitoring: {
    accountsTier1: ['@solana'],
    accountsPartners: ['@partner'],
    keywords: ['DeFi'],
    pollingIntervalMinutes: 30,
  },
  classification: { model: 'claude-haiku-4-5', temperature: 0 },
  notifications: {},
  governance: { maxRepliesPerHour: 5, maxRepliesPerDay: 20, blacklist: [], riskKeywords: [] },
};

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MockAdapter', () => {
  it('returns 5 tweets', async () => {
    const tweets = await new MockAdapter().fetchTweets(config);
    expect(tweets).toHaveLength(5);
  });

  it('returns stable mock ids', async () => {
    const tweets = await new MockAdapter().fetchTweets(config);
    expect(tweets.map((t) => t.id)).toEqual(['mock_1', 'mock_2', 'mock_3', 'mock_4', 'mock_5']);
  });

  it('includes required tweet fields', async () => {
    const tweet = (await new MockAdapter().fetchTweets(config))[0];
    expect(tweet.author).toMatch(/^@/);
    expect(tweet.url).toContain('https://');
    expect(typeof tweet.created_at).toBe('number');
  });

  it('is named mock', () => {
    expect(new MockAdapter().name).toBe('mock');
  });

  it('does not read config values', async () => {
    const custom = { ...config, monitoring: { ...config.monitoring, keywords: [] } };
    const tweets = await new MockAdapter().fetchTweets(custom);
    expect(tweets).toHaveLength(5);
  });
});

describe('XpozAdapter', () => {
  it('throws not implemented', async () => {
    await expect(new XpozAdapter().fetchTweets(config)).rejects.toThrow('not implemented');
  });

  it('is named xpoz', () => {
    expect(new XpozAdapter().name).toBe('xpoz');
  });
});

describe('TwitterApiIoAdapter', () => {
  it('is named twitterapi_io', () => {
    expect(new TwitterApiIoAdapter().name).toBe('twitterapi_io');
  });

  it('queries account and keyword endpoints', async () => {
    const fetchMock = vi.fn(async () => response(200, { tweets: [], has_next_page: false, next_cursor: '' }));
    vi.stubGlobal('fetch', fetchMock);

    await new TwitterApiIoAdapter().fetchTweets(config);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain('query=');
    expect(String(fetchMock.mock.calls[1][0])).toContain('query=DeFi');
    expect(String(fetchMock.mock.calls[0][0])).toContain('count=5');
    expect(String(fetchMock.mock.calls[1][0])).toContain('count=5');
  });

  it('caps returned tweets even if upstream returns more than requested', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(200, {
          tweets: [
            { id: '1', url: 'u1', text: 't1', createdAt: '2026-01-01T00:00:00.000Z', author: { userName: 'a' } },
            { id: '2', url: 'u2', text: 't2', createdAt: '2026-01-01T00:00:00.000Z', author: { userName: 'a' } },
            { id: '3', url: 'u3', text: 't3', createdAt: '2026-01-01T00:00:00.000Z', author: { userName: 'a' } },
            { id: '4', url: 'u4', text: 't4', createdAt: '2026-01-01T00:00:00.000Z', author: { userName: 'a' } },
          ],
          has_next_page: false,
          next_cursor: '',
        })
      )
    );

    const tweets = await new TwitterApiIoAdapter().fetchTweets({
      ...config,
      dataSource: { ...config.dataSource, maxTweetsPerQuery: 2 },
      monitoring: { ...config.monitoring, keywords: [] },
    });

    expect(tweets).toHaveLength(2);
  });

  it('maps API tweet shape into RawTweet', async () => {
    const fetchMock = vi.fn(async () =>
      response(200, {
        tweets: [
          {
            id: '1',
            url: 'https://x.com/t/1',
            text: 'hi',
            createdAt: '2026-01-01T00:00:00.000Z',
            author: { userName: 'alice' },
            likeCount: 2,
          },
        ],
        has_next_page: false,
        next_cursor: '',
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const tweets = await new TwitterApiIoAdapter().fetchTweets({
      ...config,
      monitoring: { ...config.monitoring, keywords: [] },
    });
    expect(tweets).toHaveLength(1);
    expect(tweets[0].author).toBe('@alice');
    expect(tweets[0].metadata?.likeCount).toBe(2);
  });

  it('falls back unknown author', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(200, {
          tweets: [{ id: '1', url: 'u', text: 't', createdAt: '2026-01-01T00:00:00.000Z' }],
          has_next_page: false,
          next_cursor: '',
        })
      )
    );
    const tweets = await new TwitterApiIoAdapter().fetchTweets({ ...config, monitoring: { ...config.monitoring, keywords: [] } });
    expect(tweets[0].author).toBe('@unknown');
  });

  it('deduplicates tweets from both queries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(200, {
          tweets: [{ id: 'same', url: 'u', text: 'a', createdAt: '2026-01-01T00:00:00.000Z', author: { userName: 'a' } }],
          has_next_page: false,
          next_cursor: '',
        })
      )
      .mockResolvedValueOnce(
        response(200, {
          tweets: [
            { id: 'same', url: 'u', text: 'a', createdAt: '2026-01-01T00:00:00.000Z', author: { userName: 'a' } },
            { id: 'other', url: 'u2', text: 'b', createdAt: '2026-01-01T00:00:00.000Z', author: { userName: 'b' } },
          ],
          has_next_page: false,
          next_cursor: '',
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const tweets = await new TwitterApiIoAdapter().fetchTweets(config);
    expect(tweets).toHaveLength(2);
  });

  it('returns empty on 429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(429, { error: 'rate' })));
    const tweets = await new TwitterApiIoAdapter().fetchTweets({ ...config, monitoring: { ...config.monitoring, keywords: [] } });
    expect(tweets).toEqual([]);
  });

  it('throws on non-OK non-429 responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(500, { error: 'boom' })));
    await expect(
      new TwitterApiIoAdapter().fetchTweets({ ...config, monitoring: { ...config.monitoring, keywords: [] } })
    ).rejects.toThrow('API error 500');
  });

  it('retries once on fetch throw and then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(response(200, { tweets: [], has_next_page: false, next_cursor: '' }));
    vi.stubGlobal('fetch', fetchMock);

    await new TwitterApiIoAdapter().fetchTweets({ ...config, monitoring: { ...config.monitoring, keywords: [] } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses provided API key header', async () => {
    const fetchMock = vi.fn(async () => response(200, { tweets: [], has_next_page: false, next_cursor: '' }));
    vi.stubGlobal('fetch', fetchMock);
    await new TwitterApiIoAdapter().fetchTweets({ ...config, monitoring: { ...config.monitoring, keywords: [] } });
    const secondArg = fetchMock.mock.calls[0][1] as RequestInit;
    expect((secondArg.headers as Record<string, string>)['X-API-Key']).toBe('k');
  });

  it('returns empty when no accounts and no keywords', async () => {
    const fetchMock = vi.fn(async () => response(200, { tweets: [], has_next_page: false, next_cursor: '' }));
    vi.stubGlobal('fetch', fetchMock);
    const tweets = await new TwitterApiIoAdapter().fetchTweets({
      ...config,
      monitoring: { accountsTier1: [], accountsPartners: [], keywords: [], pollingIntervalMinutes: 30 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tweets).toEqual([]);
  });

  it('normalizes account names by stripping @', async () => {
    const fetchMock = vi.fn(async () => response(200, { tweets: [], has_next_page: false, next_cursor: '' }));
    vi.stubGlobal('fetch', fetchMock);
    await new TwitterApiIoAdapter().fetchTweets({
      ...config,
      monitoring: { ...config.monitoring, accountsTier1: ['@solana'], accountsPartners: [] },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('from%3Asolana');
  });

  it('throws after retry is exhausted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('no network'))));
    await expect(
      new TwitterApiIoAdapter().fetchTweets({ ...config, monitoring: { ...config.monitoring, keywords: [] } })
    ).rejects.toThrow('no network');
  });

  it('maps createdAt to unix timestamp', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(200, {
          tweets: [{ id: 'x', url: 'u', text: 't', createdAt: '2026-01-02T00:00:00.000Z', author: { userName: 'a' } }],
          has_next_page: false,
          next_cursor: '',
        })
      )
    );
    const out = await new TwitterApiIoAdapter().fetchTweets({ ...config, monitoring: { ...config.monitoring, keywords: [] } });
    expect(out[0].created_at).toBe(1767312000);
  });
});

describe('TwitterV2Adapter', () => {
  const v2Config: CollectorConfig = {
    ...config,
    dataSource: {
      type: 'twitter_v2',
      apiKey: 'bearer-token',
    },
  };

  it('uses maxTweetsPerQuery for output and clamps request min to 10', async () => {
    const fetchMock = vi.fn(async () =>
      response(200, {
        data: Array.from({ length: 12 }, (_, i) => ({
          id: String(i + 1),
          text: `tweet-${i + 1}`,
          created_at: '2026-01-01T00:00:00.000Z',
          author_id: 'user-1',
          public_metrics: { retweet_count: 0, reply_count: 0, like_count: 0, quote_count: 0 },
        })),
        includes: { users: [{ id: 'user-1', username: 'alice' }] },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const tweets = await new TwitterV2Adapter().fetchTweets({
      ...v2Config,
      dataSource: { ...v2Config.dataSource, maxTweetsPerQuery: 5 },
      monitoring: { ...v2Config.monitoring, keywords: [] },
    });

    expect(tweets).toHaveLength(5);
    expect(String(fetchMock.mock.calls[0][0])).toContain('max_results=10');
  });

  it('clamps request max_results to 100 when config is too large', async () => {
    const fetchMock = vi.fn(async () => response(200, { data: [], includes: { users: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    await new TwitterV2Adapter().fetchTweets({
      ...v2Config,
      dataSource: { ...v2Config.dataSource, maxTweetsPerQuery: 500 },
      monitoring: { ...v2Config.monitoring, keywords: [] },
    });

    expect(String(fetchMock.mock.calls[0][0])).toContain('max_results=100');
  });
});
