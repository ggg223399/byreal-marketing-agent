import { insertSignal, InsertSignalInput } from '../db/index.js';
import { classifyTweets } from '../classifier/classify.js';
import { DataSourceAdapter } from '../types/index.js';
import { MockAdapter } from './adapters/mock.js';
import { TwitterApiIoAdapter } from './adapters/twitterapiio.js';
import { TwitterV2Adapter } from './adapters/twitter-v2.js';
import { XpozAdapter } from './adapters/xpoz.js';
import { loadConfig } from '../config/loader.js';

const DRY_RUN = process.argv.includes('--dry-run');

function createAdapter(type: string): DataSourceAdapter {
  switch (type) {
    case 'mock': return new MockAdapter();
    case 'twitterapi_io': return new TwitterApiIoAdapter();
    case 'twitter_v2': return new TwitterV2Adapter();
    case 'xpoz': return new XpozAdapter();
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

async function notifyRedSignals(signals: InsertSignalInput[], webhookUrl: string): Promise<void> {
  const content = signals
    .map(
      (s) =>
        `🔴 **${s.author}** | ${s.signalClass} (${(s.confidence * 100).toFixed(0)}%)\n> ${s.content.slice(0, 200)}\n${s.url ?? ''}`
    )
    .join('\n\n');

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `🚨 **${signals.length} RED signal(s) detected**\n\n${content}`,
    }),
  });
}

async function main() {
  const config = loadConfig();
  const adapter = createAdapter(config.dataSource.type);
  const tweets = await adapter.fetchTweets(config);
  const results = await classifyTweets(tweets, config);

  if (DRY_RUN) {
    const counts = {
      reply_needed: 0,
      watch_only: 0,
      ignore: 0,
    };

    for (const result of results) {
      counts[result.signalClass] += 1;
    }

    console.log(
      `Fetched ${tweets.length} tweets, classified: {reply_needed: ${counts.reply_needed}, watch_only: ${counts.watch_only}, ignore: ${counts.ignore}} (dry-run, not stored)`
    );
    process.exit(0);
  }

  let stored = 0;
  let skipped = 0;
  const redSignals: InsertSignalInput[] = [];
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
      signalClass: classification.signalClass,
      confidence: classification.confidence,
      alertLevel: classification.alertLevel,
      sourceAdapter: adapter.name,
      rawJson: JSON.stringify(tweet),
    };

    try {
      insertSignal(input);
      stored++;
      if (input.alertLevel === 'red') {
        redSignals.push(input);
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

  if (redSignals.length > 0 && config.notifications.discordWebhookUrl) {
    try {
      await notifyRedSignals(redSignals, config.notifications.discordWebhookUrl);
    } catch (err: unknown) {
      logJson('error', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logJson('collect', {
    fetched: tweets.length,
    stored,
    skipped,
    red: redSignals.length,
  });
  process.exit(0);
}

main().catch((err) => {
  logJson('error', {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
