import { createHash } from 'node:crypto';
import type { DataSourceAdapter, RawTweet, CollectorConfig } from '../../types/index.js';

const RESPONSES_API_URL = 'https://api.x.ai/v1/responses';
const MODEL = 'grok-4-1-fast-non-reasoning';
const RETRY_DELAY_MS = 2000;
const FETCH_TIMEOUT_MS = 30000;
const INTER_CALL_DELAY_MS = 2000;
const MAX_HANDLES_PER_CALL = 10;
const DEFAULT_MAX_TWEETS_PER_QUERY = 5;
const API_MAX_TWEETS_PER_QUERY = 100;

const SYSTEM_PROMPT = `You are a tweet collector. Search X for the requested tweets and return them as a JSON object.
Return ONLY valid JSON with this schema:
{"tweets": [{"id": "tweet_id", "author": "@username", "content": "tweet text", "url": "https://x.com/user/status/id", "created_at": "ISO8601 datetime", "image_url": "https://pbs.twimg.com/... or null if no image", "metrics": {"likes": 0, "retweets": 0, "replies": 0, "views": 0}}]}
Include image_url only if the tweet has an attached image, otherwise set to null.
If no tweets found, return {"tweets": []}.
Do NOT include any explanation, only the JSON object.`;

interface XaiTool {
  type: 'x_search';
  allowed_x_handles?: string[];
  from_date: string;
}

interface XaiResponseContentItem {
  type?: string;
  text?: string;
}

interface XaiResponseOutputItem {
  type?: string;
  role?: string;
  content?: XaiResponseContentItem[];
}

interface XaiResponsesApiResponse {
  output?: XaiResponseOutputItem[];
}

interface XaiTweet {
  id?: string;
  author?: string;
  content?: string;
  url?: string;
  created_at?: string;
  image_url?: string | null;
  metrics?: {
    likes?: number;
    retweets?: number;
    replies?: number;
    views?: number;
  };
}

interface XaiTweetPayload {
  tweets?: XaiTweet[];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

function toNormalizedHandle(handle: string): string {
  return handle.trim().replace(/^@/, '');
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

function createFallbackTweetId(tweet: XaiTweet): string {
  const hashSource = `${tweet.author ?? ''}|${tweet.content ?? ''}|${tweet.created_at ?? ''}`;
  const digest = createHash('sha256').update(hashSource).digest('hex').slice(0, 16);
  return `xai_${digest}`;
}

function toAuthorWithPrefix(author: string | undefined): string {
  const normalized = (author ?? '').trim();
  if (!normalized) {
    return '@unknown';
  }
  return normalized.startsWith('@') ? normalized : `@${normalized}`;
}

function getAuthorForUrl(author: string): string {
  return author.replace(/^@/, '') || 'unknown';
}

function toUnixSeconds(isoDate: string | undefined): number {
  if (!isoDate) {
    return Math.floor(Date.now() / 1000);
  }
  const epochMs = new Date(isoDate).getTime();
  if (Number.isNaN(epochMs)) {
    return Math.floor(Date.now() / 1000);
  }
  return Math.floor(epochMs / 1000);
}

function mapTweetToRaw(tweet: XaiTweet): RawTweet {
  const id = (tweet.id ?? '').trim() || createFallbackTweetId(tweet);
  const author = toAuthorWithPrefix(tweet.author);
  const content = (tweet.content ?? '').trim();
  const url = (tweet.url ?? '').trim() || `https://x.com/${getAuthorForUrl(author)}/status/${id}`;
  const imageUrl = typeof tweet.image_url === 'string' ? tweet.image_url.trim() : undefined;

  return {
    id,
    author,
    content,
    url,
    created_at: toUnixSeconds(tweet.created_at),
    metadata: {
      ...(tweet.metrics ?? {}),
      ...(imageUrl ? { imageUrl } : {}),
    },
  };
}

function getAssistantOutputText(response: XaiResponsesApiResponse): string {
  const message = (response.output ?? []).find(
    item => item.type === 'message' && item.role === 'assistant'
  );

  if (!message) {
    throw new Error('[XaiSearchAdapter] Missing assistant message in xAI response output.');
  }

  const outputText = (message.content ?? []).find(
    item => item.type === 'output_text' && typeof item.text === 'string'
  );

  if (!outputText?.text) {
    throw new Error('[XaiSearchAdapter] Missing assistant output_text content in xAI response.');
  }

  return outputText.text;
}

async function fetchResponsesWithRetry(
  apiKey: string,
  userPrompt: string,
  tool: XaiTool,
  retries = 1
): Promise<XaiResponsesApiResponse | null> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(RESPONSES_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          input: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          tools: [tool],
          text: { format: { type: 'json_object' } },
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.status === 429) {
        console.warn('[XaiSearchAdapter] Rate limited (429). Returning empty results for this call.');
        return null;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`[XaiSearchAdapter] API error ${response.status}: ${body}`);
      }

      const data = (await response.json()) as XaiResponsesApiResponse;
      return data;
    } catch (err) {
      clearTimeout(timer);

      if (attempt < retries) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      throw err;
    }
  }

  return null;
}

async function searchWithTool(
  apiKey: string,
  userPrompt: string,
  tool: XaiTool
): Promise<RawTweet[]> {
  const response = await fetchResponsesWithRetry(apiKey, userPrompt, tool, 1);
  if (!response) {
    return [];
  }

  const assistantText = getAssistantOutputText(response);

  let payload: XaiTweetPayload;
  try {
    payload = JSON.parse(assistantText) as XaiTweetPayload;
  } catch {
    console.warn('[XaiSearchAdapter] Failed to parse assistant JSON payload.', {
      rawAssistantText: assistantText,
    });
    throw new Error('[XaiSearchAdapter] Invalid JSON returned by xAI assistant output.');
  }

  return (payload.tweets ?? []).map(mapTweetToRaw);
}

export class XaiSearchAdapter implements DataSourceAdapter {
  name = 'xai_search';

  async fetchTweets(config: CollectorConfig): Promise<RawTweet[]> {
    const apiKey = config.dataSource.apiKey ?? '';
    if (!apiKey) {
      throw new Error(
        '[XaiSearchAdapter] Missing API key. Set DATA_SOURCE_API_KEY or data_source.api_key in config.'
      );
    }

    const maxTweetsPerQuery = normalizeMaxTweetsPerQuery(config.dataSource.maxTweetsPerQuery);
    const fromDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const accounts = [
      ...config.monitoring.accountsTier1,
      ...config.monitoring.accountsPartners,
    ]
      .map(toNormalizedHandle)
      .filter(Boolean);

    const keywords = config.monitoring.keywords
      .map(keyword => keyword.trim())
      .filter(Boolean);

    const allTweets: RawTweet[] = [];
    let callCount = 0;

    const accountBatches = chunk(accounts, MAX_HANDLES_PER_CALL);
    for (const batch of accountBatches) {
      if (callCount > 0) {
        await sleep(INTER_CALL_DELAY_MS);
      }

      const prompt = `Find the most recent tweets from the following accounts: ${batch.join(', ')}. Return up to ${maxTweetsPerQuery} tweets.`;
      const tweets = await searchWithTool(apiKey, prompt, {
        type: 'x_search',
        allowed_x_handles: batch,
        from_date: fromDate,
      });
      allTweets.push(...tweets);
      callCount += 1;
    }

    if (keywords.length > 0) {
      if (callCount > 0) {
        await sleep(INTER_CALL_DELAY_MS);
      }

      const prompt = `Find the most recent tweets containing these keywords: ${keywords.join(', ')}. Return up to ${maxTweetsPerQuery} tweets.`;
      const tweets = await searchWithTool(apiKey, prompt, {
        type: 'x_search',
        from_date: fromDate,
      });
      allTweets.push(...tweets);
    }

    const seen = new Set<string>();
    const deduped: RawTweet[] = [];
    for (const tweet of allTweets) {
      if (!seen.has(tweet.id)) {
        seen.add(tweet.id);
        deduped.push(tweet);
      }
    }

    return deduped;
  }
}
