import { createHash } from 'node:crypto';
import { getConfigOverride, setConfigOverride } from '../../db/index.js';
import type { DataSourceAdapter, RawTweet, CollectorConfig } from '../../types/index.js';
const RESPONSES_API_URL = 'https://api.x.ai/v1/responses';
const MODEL = process.env.XAI_SEARCH_MODEL || 'grok-4-1-fast-non-reasoning';
const FETCH_TIMEOUT_MS = 60000;
export const INTER_CALL_DELAY_MS = 2000;
const POLL_ROUND_DELAY_MS = 1200;
export const MAX_HANDLES_PER_CALL = 10;
const MAX_POLL_ROUNDS = 10;
const SAFE_MAX_TWEETS_PER_POLL = 10;
export const DEFAULT_MAX_TWEETS_PER_QUERY = 5;
const API_MAX_TWEETS_PER_QUERY = 100;
const MAX_TWEET_AGE_SECONDS = 24 * 60 * 60;

const SYSTEM_PROMPT = `You are a tweet collector. Search X for the requested tweets and return them as a JSON object.
Return ONLY valid JSON with this schema:
{"tweets": [{"id": "tweet_id", "author": "@username", "author_followers": 0, "content": "tweet text", "url": "https://x.com/user/status/id", "created_at": "ISO8601 datetime", "image_url": "https://pbs.twimg.com/... or null if no image", "metrics": {"likes": 0, "retweets": 0, "replies": 0, "views": 0}}]}

THREAD HANDLING: If multiple tweets belong to the same thread (same author, posted as a reply chain), merge them into ONE entry:
- "id" and "url": use the FIRST tweet in the thread
- "content": concatenate all tweets in order, separated by "\\n---\\n" (e.g. "first tweet\\n---\\nsecond tweet\\n---\\nthird tweet")
- "metrics": use the highest values across the thread
- "created_at": use the earliest tweet's timestamp
Do NOT return individual tweets from a thread as separate entries.

Include image_url only if the tweet has an attached image, otherwise set to null.
Include author_followers as the approximate follower count of the tweet author. Use 0 if unknown.
If no tweets found, return {"tweets": []}.
Return the FULL, COMPLETE tweet text. Never truncate, summarize, or add ellipsis to tweet content.
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
  author_followers?: number | string;
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

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
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

export function toNormalizedHandle(handle: string): string {
  return handle.trim().replace(/^@/, '');
}

export function chunk<T>(items: T[], size: number): T[][] {
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

export function mapTweetToRaw(tweet: XaiTweet): RawTweet {
  const id = (tweet.id ?? '').trim() || createFallbackTweetId(tweet);
  const author = toAuthorWithPrefix(tweet.author);
  const content = (tweet.content ?? '').trim();
  const url = (tweet.url ?? '').trim() || `https://x.com/${getAuthorForUrl(author)}/status/${id}`;
  const imageUrl = typeof tweet.image_url === 'string' ? tweet.image_url.trim() : undefined;

  const rawFollowers = tweet.author_followers;
  const parsedFollowers = typeof rawFollowers === 'number'
    ? rawFollowers
    : typeof rawFollowers === 'string' && /^\d+$/.test(rawFollowers)
      ? Number(rawFollowers)
      : undefined;

  return {
    id,
    author,
    content,
    url,
    created_at: toUnixSeconds(tweet.created_at),
    metrics: {
      likes: Number(tweet.metrics?.likes ?? 0),
      retweets: Number(tweet.metrics?.retweets ?? 0),
      replies: Number(tweet.metrics?.replies ?? 0),
      views: Number(tweet.metrics?.views ?? 0),
    },
    metadata: {
      ...(tweet.metrics ?? {}),
      ...(imageUrl ? { imageUrl } : {}),
      ...(typeof parsedFollowers === 'number' && parsedFollowers > 0
        ? { authorFollowers: parsedFollowers }
        : {}),
    },
  };
}

function stripMarkdownCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return raw.slice(start, end + 1);
}

function parseTweetPayload(rawAssistantText: string): XaiTweetPayload {
  const normalized = stripMarkdownCodeFence(rawAssistantText);
  const candidates = [normalized, extractJsonObject(normalized)].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as XaiTweetPayload;
    } catch {}
  }

  throw new Error('[XaiSearchAdapter] Invalid JSON returned by xAI assistant output.');
}

function buildPollingPrompt(basePrompt: string, perRoundMax: number, excludeIds: string[]): string {
  const excluded = excludeIds.length > 0
    ? ` Exclude these tweet IDs from results: ${excludeIds.slice(0, 50).join(', ')}.`
    : '';
  return `${basePrompt} Return up to ${perRoundMax} tweets. Sort results in reverse chronological order (newest first).${excluded}`;
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
): Promise<XaiResponsesApiResponse | null> {
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
      // Intentional cost-control behavior: skip this batch instead of retrying.
      // We prefer dropping one polling round over spending extra xAI calls during rate limits.
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

    if (isAbortError(err)) {
      console.warn('[XaiSearchAdapter] Request timed out, skipping this call.', {
        timeoutMs: FETCH_TIMEOUT_MS,
      });
      return null;
    }

    throw err;
  }
}

export async function searchWithTool(
  apiKey: string,
  basePrompt: string,
  tool: XaiTool,
  maxTweetsPerQuery: number
): Promise<RawTweet[]> {
  const targetMax = normalizeMaxTweetsPerQuery(maxTweetsPerQuery);
  const maxRounds = Math.max(1, Math.min(MAX_POLL_ROUNDS, Math.ceil(targetMax / SAFE_MAX_TWEETS_PER_POLL) + 1));
  let perRoundMax = Math.min(targetMax, SAFE_MAX_TWEETS_PER_POLL);

  const seen = new Set<string>();
  const collected: RawTweet[] = [];

  for (let round = 0; round < maxRounds && collected.length < targetMax; round += 1) {
    const userPrompt = buildPollingPrompt(basePrompt, perRoundMax, Array.from(seen));
    const response = await fetchResponsesWithRetry(apiKey, userPrompt, tool);
    if (!response) {
      break;
    }

    const assistantText = getAssistantOutputText(response);
    let payload: XaiTweetPayload;
    try {
      payload = parseTweetPayload(assistantText);
    } catch {
      console.warn('[XaiSearchAdapter] Failed to parse assistant JSON payload; reducing round size and retrying.', {
        perRoundMax,
        round,
        rawAssistantText: assistantText.slice(0, 500),
      });

      if (perRoundMax > 1) {
        perRoundMax = Math.max(1, Math.floor(perRoundMax / 2));
        continue;
      }

      break;
    }

    const mapped = (payload.tweets ?? [])
      .map(mapTweetToRaw)
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    let added = 0;
    for (const tweet of mapped) {
      if (seen.has(tweet.id)) {
        continue;
      }
      seen.add(tweet.id);
      collected.push(tweet);
      added += 1;

      if (collected.length >= targetMax) {
        break;
      }
    }

    if (added === 0) {
      break;
    }

    const remaining = targetMax - collected.length;
    perRoundMax = Math.min(remaining, SAFE_MAX_TWEETS_PER_POLL);
    if (remaining > 0 && round < maxRounds - 1) {
      await sleep(POLL_ROUND_DELAY_MS);
    }
  }

  return collected.slice(0, targetMax);
}

export class XaiSearchAdapter implements DataSourceAdapter {
  name = 'xai_search';

  async fetchTweets(config: CollectorConfig): Promise<RawTweet[]> {
    const legacyMonitoring = (config as unknown as {
      monitoring?: {
        accountsTier1?: string[];
        accountsPartners?: string[];
        keywords?: string[];
        lastSeenKeyPrefix?: string;
      };
    }).monitoring;

    const apiKey = config.dataSource.apiKey ?? '';
    if (!apiKey) {
      throw new Error(
        '[XaiSearchAdapter] Missing API key. Set DATA_SOURCE_API_KEY or data_source.api_key in config.'
      );
    }

    const maxTweetsPerQuery = normalizeMaxTweetsPerQuery(config.dataSource.maxTweetsPerQuery);
    
    // Get last_seen timestamp for freshness tracking
    const defaultFromDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const lastSeenTimestamp = getConfigOverride('last_seen_xai_search');
    let fromDate = defaultFromDate;
    
    if (lastSeenTimestamp) {
      const lastSeenDate = new Date(parseInt(lastSeenTimestamp, 10) * 1000);
      // Use the more recent of: 24h ago or last seen timestamp
      if (lastSeenDate > fromDate) {
        fromDate = lastSeenDate;
      }
    }

    const accounts = [
      ...(legacyMonitoring?.accountsTier1 ?? []),
      ...(legacyMonitoring?.accountsPartners ?? []),
    ]
      .map(toNormalizedHandle)
      .filter(Boolean);

    const keywords = (legacyMonitoring?.keywords ?? [])
      .map(keyword => keyword.trim())
      .filter(Boolean);

    const allTweets: RawTweet[] = [];
    let callCount = 0;

    const accountBatches = chunk(accounts, MAX_HANDLES_PER_CALL);
    for (let batchIndex = 0; batchIndex < accountBatches.length; batchIndex++) {
      const batch = accountBatches[batchIndex];
      
      if (callCount > 0) {
        await sleep(INTER_CALL_DELAY_MS);
      }

      // Get batch-specific last_seen timestamp
      const batchLastSeenKey = `last_seen_accounts_batch_${batchIndex}`;
      const batchLastSeen = getConfigOverride(batchLastSeenKey);
      let batchFromDate = fromDate;
      if (batchLastSeen) {
        const batchLastSeenDate = new Date(parseInt(batchLastSeen, 10) * 1000);
        if (batchLastSeenDate > batchFromDate) {
          batchFromDate = batchLastSeenDate;
        }
      }

      const cutoffIso = batchFromDate.toISOString().replace('.000Z', 'Z');
      const prompt = [
        `Find the most recent tweets from the following accounts: ${batch.join(', ')}.`,
        `Search for tweets from these exact X handles only: ${batch.join(', ')}.`,
        `Only return tweets posted after ${cutoffIso}.`,
        'Do NOT return tweets from any other accounts.',
        'Do NOT return tweets older than the cutoff even if they seem more relevant or popular.',
        'If no matching tweets exist, return {"tweets":[]}.',
      ].join('\n');
      const tweets = await searchWithTool(apiKey, prompt, {
        type: 'x_search',
        allowed_x_handles: batch,
        from_date: batchFromDate.toISOString(),
      }, maxTweetsPerQuery);
      
      allTweets.push(...tweets);
      callCount += 1;

      // Update batch-specific last_seen timestamp
      if (tweets.length > 0) {
        const maxCreatedAt = Math.max(...tweets.map(t => t.created_at));
        setConfigOverride(batchLastSeenKey, String(maxCreatedAt));
      }
    }

    // Keywords query
    if (keywords.length > 0) {
      if (callCount > 0) {
        await sleep(INTER_CALL_DELAY_MS);
      }

      // Get keywords-specific last_seen timestamp
      const keyPrefix = legacyMonitoring?.lastSeenKeyPrefix || 'keywords';
      const lastSeenKey = `last_seen_${keyPrefix}`;
      const keywordsLastSeen = getConfigOverride(lastSeenKey);
      let keywordsFromDate = fromDate;
      if (keywordsLastSeen) {
        const keywordsLastSeenDate = new Date(parseInt(keywordsLastSeen, 10) * 1000);
        if (keywordsLastSeenDate > keywordsFromDate) {
          keywordsFromDate = keywordsLastSeenDate;
        }
      }

      const prompt = `Find the most recent tweets containing these keywords: ${keywords.join(', ')}.`;
      const tweets = await searchWithTool(apiKey, prompt, {
        type: 'x_search',
        from_date: keywordsFromDate.toISOString(),
      }, maxTweetsPerQuery);
      
      allTweets.push(...tweets);

      // Update keywords last_seen timestamp
      if (tweets.length > 0) {
        const maxCreatedAt = Math.max(...tweets.map(t => t.created_at));
        setConfigOverride(lastSeenKey, String(maxCreatedAt));
      }
    }

    // Update global last_seen timestamp
    if (allTweets.length > 0) {
      const maxCreatedAt = Math.max(...allTweets.map(t => t.created_at));
      setConfigOverride('last_seen_xai_search', String(maxCreatedAt));
    }

    const seen = new Set<string>();
    const deduped: RawTweet[] = [];
    const minCreatedAt = Math.floor(Date.now() / 1000) - MAX_TWEET_AGE_SECONDS;
    for (const tweet of allTweets) {
      if (tweet.created_at < minCreatedAt) {
        continue;
      }
      if (!seen.has(tweet.id)) {
        seen.add(tweet.id);
        deduped.push(tweet);
      }
    }

    return deduped;
  }
}
