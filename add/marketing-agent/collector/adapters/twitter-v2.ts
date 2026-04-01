import type { DataSourceAdapter, RawTweet, CollectorConfig } from '../../types/index.js';

/** Twitter API v2 基础 URL */
const BASE_URL = 'https://api.twitter.com/2';
/** 单次请求超时时间（毫秒） */
const FETCH_TIMEOUT_MS = 15000;
/** 账号查询与关键词查询之间的延迟，避免触发限流 */
const INTER_QUERY_DELAY_MS = 1500;
/** 每次查询的默认最大 tweet 数 */
const DEFAULT_MAX_TWEETS_PER_QUERY = 5;
/** Twitter API v2 max_results 最小值 */
const API_MIN_MAX_RESULTS = 10;
/** Twitter API v2 max_results 最大值 */
const API_MAX_MAX_RESULTS = 100;

/** 工具函数：异步等待指定毫秒数 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 将用户配置的 maxTweetsPerQuery 规范化为合法整数。
 * 非有限数值或小于 1 时使用默认值，超上限时截断。
 */
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

/**
 * 将期望获取数转换为 Twitter API 接受的 max_results 参数值。
 * Twitter API 要求该值在 [10, 100] 区间内。
 */
function toTwitterApiMaxResults(desiredMaxTweetsPerQuery: number): number {
  return Math.min(
    API_MAX_MAX_RESULTS,
    Math.max(API_MIN_MAX_RESULTS, desiredMaxTweetsPerQuery)
  );
}

/**
 * 带超时控制的 fetch 封装。
 * 超时后通过 AbortController 取消请求。
 */
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

/** Twitter API v2 用户对象 */
interface TwitterUser {
  id: string;
  username: string;
}

/** Twitter API v2 单条 tweet 对象 */
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

/** Twitter API v2 搜索接口响应结构 */
interface TwitterSearchResponse {
  data?: TwitterTweet[];
  includes?: { users?: TwitterUser[] };
  meta?: { result_count?: number; next_token?: string };
  errors?: { title: string; detail: string }[];
}

/**
 * 将 Twitter API v2 原始 tweet 对象映射为统一的 RawTweet 格式。
 * @param tweet   原始 tweet 数据
 * @param usersMap author_id → username 的映射表（用于填充作者名）
 */
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

/**
 * 向 Twitter API v2 发起一次搜索请求，并将返回的用户信息写入 usersMap。
 * 遇到 429 限流时直接返回空数组而非抛出错误。
 *
 * @param query              搜索查询字符串
 * @param bearerToken        Twitter Bearer Token
 * @param usersMap           共享的 author_id → username 映射表（会被就地更新）
 * @param maxTweetsPerQuery  期望获取的最大条数
 */
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
    // 遭遇限流，跳过本次查询而非中断整个采集流程
    console.warn('[TwitterV2Adapter] Rate limited (429). Skipping this query.');
    return [];
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`[TwitterV2Adapter] API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as TwitterSearchResponse;

  // 将本次响应中的用户信息写入共享映射表，供后续 mapTweet 使用
  for (const user of data.includes?.users ?? []) {
    usersMap.set(user.id, user.username);
  }

  return (data.data ?? []).slice(0, maxTweetsPerQuery);
}

/**
 * TwitterV2Adapter — 基于 Twitter API v2 的官方数据源适配器
 *
 * 依赖 Bearer Token（config.dataSource.apiKey）。
 * 采集顺序：先查账号 tweet，再查关键词 tweet，最后全局去重。
 */
export class TwitterV2Adapter implements DataSourceAdapter {
  name = 'twitter_v2';

  /**
   * 采集 tweet 并返回去重后的 RawTweet 列表。
   * @param config 采集器配置
   */
  async fetchTweets(config: CollectorConfig): Promise<RawTweet[]> {
    const bearerToken = config.dataSource.apiKey ?? '';
    const maxTweetsPerQuery = normalizeDesiredMaxTweetsPerQuery(config.dataSource.maxTweetsPerQuery);
    if (!bearerToken) {
      throw new Error(
        '[TwitterV2Adapter] 缺少 Bearer Token。请在 .env 设置 DATA_SOURCE_API_KEY 或在 config.yaml 设置 api_key。'
      );
    }

    // author_id → username 的共享映射表，所有查询复用同一份
    const usersMap = new Map<string, string>();
    const seen = new Set<string>();
    const allTweets: TwitterTweet[] = [];

    // 1. 账号查询：将所有监控账号合并为一条 OR 查询
    const accounts = [
      ...config.monitoring.accountsTier1,
      ...config.monitoring.accountsPartners,
    ].map(a => a.replace(/^@/, ''));

    if (accounts.length > 0) {
      const query = accounts.map(a => `from:${a}`).join(' OR ');
      const tweets = await searchRecent(query, bearerToken, usersMap, maxTweetsPerQuery);
      allTweets.push(...tweets);
    }

    // 2. 关键词查询（与账号查询之间插入延迟，避免触发限流）
    if (config.monitoring.keywords.length > 0) {
      if (accounts.length > 0) await sleep(INTER_QUERY_DELAY_MS);
      const query = config.monitoring.keywords.join(' OR ');
      const tweets = await searchRecent(query, bearerToken, usersMap, maxTweetsPerQuery);
      allTweets.push(...tweets);
    }

    // 3. 去重：按 tweet id 过滤重复条目
    const deduped = allTweets.filter(t => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    return deduped.map(t => mapTweet(t, usersMap));
  }
}
