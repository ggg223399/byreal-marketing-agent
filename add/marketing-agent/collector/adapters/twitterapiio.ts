import { DataSourceAdapter, RawTweet, CollectorConfig } from '../../types/index.js';

/** twitterapi.io 服务基础 URL */
const BASE_URL = 'https://api.twitterapi.io';
/** 请求失败后重试前的等待时间（毫秒） */
const RETRY_DELAY_MS = 2000;
/** 单次请求超时时间（毫秒） */
const FETCH_TIMEOUT_MS = 15000;
/** 每次查询的默认最大 tweet 数 */
const DEFAULT_MAX_TWEETS_PER_QUERY = 5;
/** twitterapi.io 单次查询允许的最大条数 */
const API_MAX_TWEETS_PER_QUERY = 100;

/** 工具函数：异步等待指定毫秒数 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 将用户配置的 maxTweetsPerQuery 规范化为合法整数。
 * 非有限数值或小于 1 时使用默认值，超上限时截断。
 */
function normalizeMaxTweetsPerQuery(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_TWEETS_PER_QUERY;
  }

  const normalized = Math.floor(value as number);
  if (normalized < 1) {
    return DEFAULT_MAX_TWEETS_PER_QUERY;
  }

  return Math.min(normalized, API_MAX_TWEETS_PER_QUERY);
}

/**
 * 带超时与自动重试的 fetch 封装。
 * 请求超时时通过 AbortController 中止；失败后最多重试 retries 次。
 *
 * @param url     请求 URL
 * @param options fetch 选项
 * @param retries 失败后的最大重试次数（默认 1）
 */
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

/** twitterapi.io 响应中的作者信息 */
interface ApiAuthor {
  userName?: string;
}

/** twitterapi.io 单条 tweet 原始结构 */
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

/** twitterapi.io 搜索接口响应结构 */
interface ApiResponse {
  tweets: ApiTweet[];
  has_next_page: boolean;
  next_cursor: string;
}

/**
 * 将 twitterapi.io 原始 tweet 对象映射为统一的 RawTweet 格式。
 * createdAt 字符串会被转换为 Unix 时间戳（秒）。
 */
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

/**
 * 向 twitterapi.io 发起一次高级搜索请求。
 * 遇到 429 限流时返回空数组，遇到其他错误时抛出异常。
 *
 * @param query  搜索查询字符串
 * @param apiKey twitterapi.io API Key
 * @param count  期望获取的最大条数
 */
async function searchTweets(query: string, apiKey: string, count: number): Promise<ApiTweet[]> {
  const params = new URLSearchParams({ query, queryType: 'Latest', count: String(count) });
  const url = `${BASE_URL}/twitter/tweet/advanced_search?${params}`;
  const options: RequestInit = {
    headers: { 'X-API-Key': apiKey },
  };

  const response = await fetchWithRetry(url, options);

  if (response.status === 429) {
    // 遭遇限流，跳过本次查询而非中断整个采集流程
    console.warn('[TwitterApiIoAdapter] Rate limited (429). Returning empty results for this query.');
    return [];
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`[TwitterApiIoAdapter] API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as ApiResponse;
  return (data.tweets ?? []).slice(0, count);
}

/**
 * TwitterApiIoAdapter — 基于 twitterapi.io 第三方服务的数据源适配器
 *
 * 依赖 X-API-Key（config.dataSource.apiKey）。
 * 采集顺序：先查账号 tweet，再查关键词 tweet，两次查询之间插入 2s 延迟，最后全局去重。
 */
export class TwitterApiIoAdapter implements DataSourceAdapter {
  name = 'twitterapi_io';

  /**
   * 采集 tweet 并返回去重后的 RawTweet 列表。
   * @param config 采集器配置
   */
  async fetchTweets(config: CollectorConfig): Promise<RawTweet[]> {
    const apiKey = config.dataSource.apiKey ?? '';
    const maxTweetsPerQuery = normalizeMaxTweetsPerQuery(config.dataSource.maxTweetsPerQuery);
    const seen = new Set<string>();
    const allTweets: ApiTweet[] = [];

    // 将监控账号列表合并为一条 from:xxx OR from:yyy 查询
    const accounts = [
      ...config.monitoring.accountsTier1,
      ...config.monitoring.accountsPartners,
    ].map(a => a.replace(/^@/, ''));

    if (accounts.length > 0) {
      const accountQuery = accounts.map(a => `from:${a}`).join(' OR ');
      const tweets = await searchTweets(accountQuery, apiKey, maxTweetsPerQuery);
      allTweets.push(...tweets);
    }

    // 账号查询与关键词查询之间插入延迟，降低触发限流的概率
    if (accounts.length > 0 && config.monitoring.keywords.length > 0) {
      await sleep(2000);
    }

    if (config.monitoring.keywords.length > 0) {
      const keywordQuery = config.monitoring.keywords.join(' OR ');
      const tweets = await searchTweets(keywordQuery, apiKey, maxTweetsPerQuery);
      allTweets.push(...tweets);
    }

    // 去重：按 tweet id 过滤重复条目
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
