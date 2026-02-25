import type { DataSourceAdapter, RawTweet, CollectorConfig } from '../../types/index.js';

const BASE_URL = 'https://api.twitter.com/2';
const FETCH_TIMEOUT_MS = 15000;
const INTER_QUERY_DELAY_MS = 1500;
const DEFAULT_MAX_TWEETS_PER_QUERY = 5;
const API_MIN_MAX_RESULTS = 10;
const API_MAX_MAX_RESULTS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeDesiredMaxTweetsPerQuery(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_TWEETS_PER_QUERY;
  }

  const normalized = Math.floor(value as number);
  if (normalized < 1) {
    return DEFAULT_MAX_TWEETS_PER_QUERY;
  }

  return Math.min(normalized, API_MAX_MAX_RESULTS);
}

function toTwitterApiMaxResults(desiredMaxTweetsPerQuery: number): number {
  return Math.min(
    API_MAX_MAX_RESULTS,
    Math.max(API_MIN_MAX_RESULTS, desiredMaxTweetsPerQuery)
  );
}

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return response;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

interface TwitterUser {
  id: string;
  username: string;
}

interface TwitterTweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
  };
}

interface TwitterSearchResponse {
  data?: TwitterTweet[];
  includes?: { users?: TwitterUser[] };
  meta?: { result_count?: number; next_token?: string };
  errors?: { title: string; detail: string }[];
}

function mapTweet(tweet: TwitterTweet, usersMap: Map<string, string>): RawTweet {
  const username = tweet.author_id ? usersMap.get(tweet.author_id) : undefined;
  return {
    id: tweet.id,
    author: username ? `@${username}` : '@unknown',
    content: tweet.text,
    url: `https://twitter.com/i/web/status/${tweet.id}`,
    created_at: tweet.created_at
      ? Math.floor(new Date(tweet.created_at).getTime() / 1000)
      : Math.floor(Date.now() / 1000),
    metadata: tweet.public_metrics,
  };
}

async function searchRecent(
  query: string,
  bearerToken: string,
  usersMap: Map<string, string>,
  maxTweetsPerQuery: number
): Promise<TwitterTweet[]> {
  const maxResults = toTwitterApiMaxResults(maxTweetsPerQuery);
  const params = new URLSearchParams({
    query,
    max_results: String(maxResults),
    'tweet.fields': 'created_at,author_id,public_metrics',
    expansions: 'author_id',
    'user.fields': 'username',
  });

  const response = await fetchWithTimeout(`${BASE_URL}/tweets/search/recent?${params}`, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });

  if (response.status === 429) {
    console.warn('[TwitterV2Adapter] Rate limited (429). Skipping this query.');
    return [];
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`[TwitterV2Adapter] API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as TwitterSearchResponse;

  for (const user of data.includes?.users ?? []) {
    usersMap.set(user.id, user.username);
  }

  return (data.data ?? []).slice(0, maxTweetsPerQuery);
}

export class TwitterV2Adapter implements DataSourceAdapter {
  name = 'twitter_v2';

  async fetchTweets(config: CollectorConfig): Promise<RawTweet[]> {
    const bearerToken = config.dataSource.apiKey ?? '';
    const maxTweetsPerQuery = normalizeDesiredMaxTweetsPerQuery(config.dataSource.maxTweetsPerQuery);
    if (!bearerToken) {
      throw new Error(
        '[TwitterV2Adapter] 缺少 Bearer Token。请在 .env 设置 DATA_SOURCE_API_KEY 或在 config.yaml 设置 api_key。'
      );
    }

    const usersMap = new Map<string, string>();
    const seen = new Set<string>();
    const allTweets: TwitterTweet[] = [];

    // 1. 账号查询
    const accounts = [
      ...config.monitoring.accountsTier1,
      ...config.monitoring.accountsPartners,
    ].map(a => a.replace(/^@/, ''));

    if (accounts.length > 0) {
      const query = accounts.map(a => `from:${a}`).join(' OR ');
      const tweets = await searchRecent(query, bearerToken, usersMap, maxTweetsPerQuery);
      allTweets.push(...tweets);
    }

    // 2. 关键词查询（间隔避免限流）
    if (config.monitoring.keywords.length > 0) {
      if (accounts.length > 0) await sleep(INTER_QUERY_DELAY_MS);
      const query = config.monitoring.keywords.join(' OR ');
      const tweets = await searchRecent(query, bearerToken, usersMap, maxTweetsPerQuery);
      allTweets.push(...tweets);
    }

    // 3. 去重
    const deduped = allTweets.filter(t => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    return deduped.map(t => mapTweet(t, usersMap));
  }
}
