import { DataSourceAdapter, RawTweet, CollectorConfig } from '../../../types/index.js';

const BASE_URL = 'https://api.twitterapi.io';
const RETRY_DELAY_MS = 2000;
const FETCH_TIMEOUT_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, options: RequestInit, retries = 1): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return response;
  } catch (err) {
    clearTimeout(timer);
    if (retries > 0) {
      await sleep(RETRY_DELAY_MS);
      return fetchWithRetry(url, options, retries - 1);
    }
    throw err;
  }
}

interface ApiAuthor {
  userName?: string;
}

interface ApiTweet {
  id: string;
  url: string;
  text: string;
  createdAt: string;
  author?: ApiAuthor;
  retweetCount?: number;
  replyCount?: number;
  likeCount?: number;
  quoteCount?: number;
  viewCount?: number;
  lang?: string;
}

interface ApiResponse {
  tweets: ApiTweet[];
  has_next_page: boolean;
  next_cursor: string;
}

function mapTweet(tweet: ApiTweet): RawTweet {
  return {
    id: tweet.id,
    author: `@${tweet.author?.userName ?? 'unknown'}`,
    content: tweet.text,
    url: tweet.url,
    created_at: Math.floor(new Date(tweet.createdAt).getTime() / 1000),
    metadata: {
      retweetCount: tweet.retweetCount,
      replyCount: tweet.replyCount,
      likeCount: tweet.likeCount,
      quoteCount: tweet.quoteCount,
      viewCount: tweet.viewCount,
      lang: tweet.lang,
    },
  };
}

async function searchTweets(query: string, apiKey: string): Promise<ApiTweet[]> {
  const params = new URLSearchParams({ query, queryType: 'Latest' });
  const url = `${BASE_URL}/twitter/tweet/advanced_search?${params}`;
  const options: RequestInit = {
    headers: { 'X-API-Key': apiKey },
  };

  const response = await fetchWithRetry(url, options);

  if (response.status === 429) {
    console.warn('[TwitterApiIoAdapter] Rate limited (429). Returning empty results for this query.');
    return [];
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`[TwitterApiIoAdapter] API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as ApiResponse;
  return data.tweets ?? [];
}

export class TwitterApiIoAdapter implements DataSourceAdapter {
  name = 'twitterapi_io';

  async fetchTweets(config: CollectorConfig): Promise<RawTweet[]> {
    const apiKey = config.dataSource.apiKey ?? '';
    const seen = new Set<string>();
    const allTweets: ApiTweet[] = [];

    const accounts = [
      ...config.monitoring.accountsTier1,
      ...config.monitoring.accountsPartners,
    ].map(a => a.replace(/^@/, ''));

    if (accounts.length > 0) {
      const accountQuery = accounts.map(a => `from:${a}`).join(' OR ');
      const tweets = await searchTweets(accountQuery, apiKey);
      allTweets.push(...tweets);
    }

    // Delay between queries to avoid rate limiting
    if (accounts.length > 0 && config.monitoring.keywords.length > 0) {
      await sleep(2000);
    }

    if (config.monitoring.keywords.length > 0) {
      const keywordQuery = config.monitoring.keywords.join(' OR ');
      const tweets = await searchTweets(keywordQuery, apiKey);
      allTweets.push(...tweets);
    }

    const deduped: ApiTweet[] = [];
    for (const tweet of allTweets) {
      if (!seen.has(tweet.id)) {
        seen.add(tweet.id);
        deduped.push(tweet);
      }
    }

    return deduped.map(mapTweet);
  }
}
