import { insertSignal, InsertSignalInput } from '../db/index.js';
import { classifyTweets } from '../classifier/classify.js';
import { DataSourceAdapter, SIGNAL_CATEGORIES } from '../types/index.js';
import { MockAdapter } from './adapters/mock.js';
import { TwitterApiIoAdapter } from './adapters/twitterapiio.js';
import { TwitterV2Adapter } from './adapters/twitter-v2.js';
import { XpozAdapter } from './adapters/xpoz.js';
import { XaiSearchAdapter } from './adapters/xai-search.js';
import { loadConfig } from '../config/loader.js';

const DRY_RUN = process.argv.includes('--dry-run');

function createAdapter(type: string): DataSourceAdapter {
  switch (type) {
    case 'mock': return new MockAdapter();
    case 'twitterapi_io': return new TwitterApiIoAdapter();
    case 'twitter_v2': return new TwitterV2Adapter();
    case 'xpoz': return new XpozAdapter();
    case 'xai_search': return new XaiSearchAdapter();
    default: throw new Error(`Unknown adapter type: ${type}`);
  }
}

function logJson(action: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: Math.floor(Date.now() / 1000), action, ...payload }));
}

function isDuplicateError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const maybeError = err as { message?: string; code?: string };
  return (
    maybeError.message?.includes('UNIQUE constraint failed') === true ||
    maybeError.code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

async function main() {
  const config = loadConfig();
  const adapter = createAdapter(config.dataSource.type);
  const tweets = await adapter.fetchTweets(config);
  const results = await classifyTweets(tweets, config);

  if (DRY_RUN) {
    const counts: Record<number, number> = {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
      6: 0,
      7: 0,
      8: 0,
    };

    for (const result of results) {
      counts[result.category] += 1;
    }

    console.log(
      `Fetched ${tweets.length} tweets, classified: ${JSON.stringify(counts)} categories=${JSON.stringify(SIGNAL_CATEGORIES)} (dry-run, not stored)`
    );
    process.exit(0);
  }

  let stored = 0;
  let skipped = 0;
  let redCount = 0;
  const byTweetId = new Map(results.map((result) => [result.tweetId, result]));

  for (const tweet of tweets) {
    const classification = byTweetId.get(tweet.id);
    if (!classification) {
      throw new Error(`Missing classification for tweet ${tweet.id}`);
    }

    const input: InsertSignalInput = {
      tweetId: tweet.id,
      author: tweet.author,
      content: tweet.content,
      url: tweet.url,
      category: classification.category,
      confidence: classification.confidence,
      sentiment: classification.sentiment,
      priority: classification.priority,
      riskLevel: classification.riskLevel,
      suggestedAction: classification.suggestedAction,
      alertLevel: classification.alertLevel,
      sourceAdapter: adapter.name,
      rawJson: JSON.stringify(tweet),
    };

    try {
      const inserted = insertSignal(input);
      stored++;
      if (inserted.alertLevel === 'red') {
        redCount += 1;
      }
    } catch (err: unknown) {
      if (isDuplicateError(err)) {
        logJson('duplicate', { tweetId: tweet.id });
        skipped++;
        continue;
      }
      throw err;
    }
  }

  logJson('collect', {
    fetched: tweets.length,
    stored,
    skipped,
    red: redCount,
  });
  process.exit(0);
}

main().catch((err) => {
  logJson('error', {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
