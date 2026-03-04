import 'dotenv/config';

import { insertSignal } from '../db/index.js';
import type { InsertSignalInput } from '../db/index.js';
import * as classifier from '../classifier/classify.js';
import type {
  AccountConfig,
  AccountTier,
  CollectorConfig,
  DataSourceAdapter,
  NarrativeConfig,
  Pipeline,
  RawTweet,
} from '../types/index.js';
import { MockAdapter } from './adapters/mock.js';
import { TwitterApiIoAdapter } from './adapters/twitterapiio.js';
import { TwitterV2Adapter } from './adapters/twitter-v2.js';
import { XpozAdapter } from './adapters/xpoz.js';
import { XaiSearchAdapter } from './adapters/xai-search.js';
import { loadAccountsConfig, loadConfig, loadNarrativesConfig } from '../config/loader.js';

const DRY_RUN = process.argv.includes('--dry-run');
const PIPELINES: Pipeline[] = ['mentions', 'network', 'trends', 'crisis'];
const CLASSIFY_BATCH_SIZE = 5;

type HotThreshold = {
  minLikes: number;
  minRetweets: number;
  minViews: number;
};

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

function parsePipelineArg(argv: string[]): Pipeline | null {
  const inlineArg = argv.find((arg) => arg.startsWith('--pipeline='));
  const value = inlineArg?.split('=')[1]
    ?? (argv.includes('--pipeline') ? argv[argv.indexOf('--pipeline') + 1] : null);

  if (!value) {
    return null;
  }

  if ((PIPELINES as string[]).includes(value)) {
    return value as Pipeline;
  }

  throw new Error(`Invalid --pipeline value: ${value}. Expected one of ${PIPELINES.join(', ')}`);
}

function buildMentionsQuery(): string {
  return '"Byreal" OR "byreal" OR "@byreal_io" OR "byreal.io" OR "#byreal" OR "$BYREAL" OR "@emilyRioFreeman"';
}

function buildAccountsClause(accounts: AccountConfig[]): string {
  return accounts.map((account) => `from:${account.handle}`).join(' OR ');
}

function buildNetworkQuery(
  accounts: AccountConfig[],
  tier: AccountTier,
  bTierEventKeywords: string[],
  cTierEventKeywords: string[]
): string {
  if (accounts.length === 0) {
    throw new Error(`No accounts configured for network tier ${tier}`);
  }

  const handles = buildAccountsClause(accounts);
  if (tier === 'B') {
    const keywordStr = bTierEventKeywords.map((keyword) => `"${keyword}"`).join(' OR ');
    return `(${handles}) (${keywordStr})`;
  }

  if (tier === 'C') {
    const keywordStr = cTierEventKeywords.map((keyword) => `"${keyword}"`).join(' OR ');
    return `(${handles}) (${keywordStr})`;
  }

  return handles;
}

function buildTrendsQuery(narrative: NarrativeConfig): string {
  const keywords = narrative.keywords.map((keyword) => `"${keyword}"`).join(' OR ');
  return `(${keywords}) min_faves:50 -filter:replies`;
}

function buildCrisisQuery(): string {
  return '(exploit OR hack OR "rug pull" OR depeg) Solana min_faves:100';
}

function withQuery(
  config: CollectorConfig,
  query: string,
  adapterType: string,
  tierKey?: string
): CollectorConfig {
  const legacyMonitoring = (config as unknown as {
    monitoring?: { pollingIntervalMinutes?: number };
  }).monitoring;

  return {
    ...config,
    dataSource: {
      ...config.dataSource,
      type: adapterType,
    },
    monitoring: {
      accountsTier1: [],
      accountsPartners: [],
      keywords: [query],
      pollingIntervalMinutes: legacyMonitoring?.pollingIntervalMinutes ?? 30,
      ...(tierKey ? { lastSeenKeyPrefix: tierKey } : {}),
    },
  };
}

async function fetchTweetsByQuery(
  config: CollectorConfig,
  query: string,
  adapterType: string,
  tierKey?: string
): Promise<RawTweet[]> {
  const adapter = createAdapter(adapterType);
  const fetched = await adapter.fetchTweets(withQuery(config, query, adapterType, tierKey));
  return fetched.map((tweet) => ({
    ...tweet,
    metadata: {
      ...(tweet.metadata ?? {}),
      pipelineQuery: query,
    },
  }));
}

function isPureRetweet(tweet: RawTweet): boolean {
  return tweet.content.startsWith('RT @');
}

function tweetMetrics(tweet: RawTweet): { likes: number; retweets: number; views: number } {
  const likes = Number(tweet.metrics?.likes ?? tweet.metadata?.likes ?? 0);
  const retweets = Number(tweet.metrics?.retweets ?? tweet.metadata?.retweets ?? 0);
  const views = Number(tweet.metrics?.views ?? tweet.metadata?.views ?? 0);

  return {
    likes: Number.isFinite(likes) ? likes : 0,
    retweets: Number.isFinite(retweets) ? retweets : 0,
    views: Number.isFinite(views) ? views : 0,
  };
}

function preFilterTweets(tweets: RawTweet[], tier: AccountTier, hotThreshold: HotThreshold): RawTweet[] {
  return tweets.filter((tweet) => {
    if (isPureRetweet(tweet)) {
      return false;
    }

    if ((tier === 'B' || tier === 'C') && tweet.content.length < 10) {
      return false;
    }

    if (tier === 'A' || tier === 'C') {
      const metrics = tweetMetrics(tweet);
      const passesHot =
        metrics.likes >= hotThreshold.minLikes ||
        metrics.retweets >= hotThreshold.minRetweets ||
        metrics.views >= hotThreshold.minViews;

      if (!passesHot) {
        return false;
      }
    }

    return true;
  });
}

async function classifyForPipelineCompat(
  tweets: RawTweet[],
  pipeline: Pipeline,
  config: CollectorConfig
): Promise<Array<Record<string, unknown>>> {
  // TODO: update to direct classifyForPipeline import after Task 5 lands.
  const maybeClassifier = (classifier as unknown as {
    classifyForPipeline?: (
      inputTweets: RawTweet[],
      inputPipeline: Pipeline,
      inputConfig: CollectorConfig
    ) => Promise<Array<Record<string, unknown>>>;
  }).classifyForPipeline;

  if (maybeClassifier) {
    return maybeClassifier(tweets, pipeline, config);
  }

  const legacyClassifier = (classifier as unknown as {
    classifyTweets?: (inputTweets: RawTweet[], inputConfig: CollectorConfig) => Promise<Array<Record<string, unknown>>>;
  }).classifyTweets;

  if (!legacyClassifier) {
    throw new Error('Neither classifyForPipeline nor classifyTweets is available');
  }

  return legacyClassifier(tweets, config);
}

async function classifyInBatches(
  tweets: RawTweet[],
  pipeline: Pipeline,
  config: CollectorConfig
): Promise<Array<Record<string, unknown>>> {
  if (tweets.length <= CLASSIFY_BATCH_SIZE) {
    return classifyForPipelineCompat(tweets, pipeline, config);
  }

  const merged: Array<Record<string, unknown>> = [];
  for (let i = 0; i < tweets.length; i += CLASSIFY_BATCH_SIZE) {
    const batch = tweets.slice(i, i + CLASSIFY_BATCH_SIZE);
    const batchResults = await classifyForPipelineCompat(batch, pipeline, config);
    merged.push(...batchResults);
  }
  return merged;
}

function getAdapterTypeForPipeline(pipeline: Pipeline, config: CollectorConfig): string {
  const fallback = config.dataSource.type;
  switch (pipeline) {
    case 'mentions':
      return config.pipelines?.mentions?.adapter ?? fallback;
    case 'network':
      return config.pipelines?.network?.adapter ?? fallback;
    case 'trends':
      return config.pipelines?.trends?.adapter ?? fallback;
    case 'crisis':
      return config.pipelines?.crisis?.adapter ?? fallback;
    default:
      return fallback;
  }
}

function getTrendsAlternateAdapter(config: CollectorConfig): string {
  return config.pipelines?.trends?.alternateAdapter ?? 'xai_search';
}

function logJson(action: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: Math.floor(Date.now() / 1000), action, ...payload }));
}

async function main() {
  const config = loadConfig();
  const selectedPipeline = parsePipelineArg(process.argv);

  if (selectedPipeline) {
    await runPipeline(selectedPipeline, config);
    process.exit(0);
  }

  for (const pipeline of PIPELINES) {
    await runPipeline(pipeline, config);
  }

  process.exit(0);
}

export async function runPipeline(pipeline: Pipeline, config: CollectorConfig): Promise<void> {
  const adapterType = getAdapterTypeForPipeline(pipeline, config);

  if (pipeline === 'network') {
    const accountsConfig = loadAccountsConfig();
    const cTierEventKeywords = [...new Set([
      ...accountsConfig.cTierEventKeywords.data_platforms,
      ...accountsConfig.cTierEventKeywords.infrastructure,
      ...accountsConfig.cTierEventKeywords.media,
    ])];

    const tierDefinitions: Array<{ tier: AccountTier; accounts: AccountConfig[] }> = [
      { tier: 'O', accounts: accountsConfig.O },
      { tier: 'S', accounts: accountsConfig.S },
      { tier: 'A', accounts: accountsConfig.A },
      { tier: 'B', accounts: accountsConfig.B },
      { tier: 'C', accounts: accountsConfig.C },
    ];

    const dryRunCounts: Record<string, number> = {};
    let fetched = 0;
    let stored = 0;
    let redCount = 0;
    let crisisTriggered = 0;

    for (const tierDefinition of tierDefinitions) {
      if (tierDefinition.accounts.length === 0) {
        continue;
      }

      const query = buildNetworkQuery(
        tierDefinition.accounts,
        tierDefinition.tier,
        accountsConfig.bTierEventKeywords,
        cTierEventKeywords
      );
      const tierKey = `network_${tierDefinition.tier}`;
      const tweets = await fetchTweetsByQuery(config, query, adapterType, tierKey);
      const filteredTweets = preFilterTweets(tweets, tierDefinition.tier, accountsConfig.hotThreshold);
      fetched += filteredTweets.length;

      if (tierDefinition.tier === 'O') {
        const riskKeywords = config.governance?.riskKeywords ?? [];

        for (const tweet of filteredTweets) {
          const hasRiskKeyword = riskKeywords.some((keyword) =>
            tweet.content.toLowerCase().includes(keyword.toLowerCase())
          );

          const oTierInput = {
            tweetId: tweet.id,
            author: tweet.author,
            content: tweet.content,
            url: tweet.url,
            category: 0,
            confidence: 100,
            relevance: 100,
            sentiment: 'neutral',
            priority: hasRiskKeyword ? 1 : 3,
            riskLevel: hasRiskKeyword ? 'high' : 'low',
            suggestedAction: 'store',
            alertLevel: hasRiskKeyword ? 'red' : 'none',
            sourceAdapter: adapterType,
            rawJson: JSON.stringify({ tweet, pipeline, accountTier: 'O', hasRiskKeyword }),
            pipeline,
            actionType: 'monitor',
            angle: hasRiskKeyword ? 'Own-account post with risk keyword match; escalate for review.' : 'Own-account activity stored for team awareness.',
            tones: [],
            accountTier: 'O',
            reason: hasRiskKeyword
              ? 'Own account tweet matched risk keywords and should be reviewed immediately.'
              : 'Own account tweet collected for activity visibility.',
          } as InsertSignalInput & Record<string, unknown>;

          if (DRY_RUN) {
            stored += 1;
            if (hasRiskKeyword) {
              redCount += 1;
              crisisTriggered += 1;
            }
            continue;
          }

          try {
            insertSignal(oTierInput);
            stored += 1;
            if (hasRiskKeyword) {
              redCount += 1;
              crisisTriggered += 1;

              const crisisInput = {
                tweetId: tweet.id,
                author: tweet.author,
                content: tweet.content,
                url: tweet.url,
                category: 0,
                confidence: 100,
                relevance: 100,
                sentiment: 'negative',
                priority: 1,
                riskLevel: 'high',
                suggestedAction: 'monitor',
                alertLevel: 'red',
                sourceAdapter: adapterType,
                rawJson: JSON.stringify({ tweet, pipeline: 'crisis', triggeredBy: 'network_O_risk_keyword' }),
                pipeline: 'crisis',
                actionType: 'monitor',
                severity: 'high',
                angle: 'Risk keyword detected in own-account tweet; escalate through crisis workflow.',
                tones: [],
                reason: 'Risk keyword match in own-account content triggered crisis monitoring.',
              } as InsertSignalInput & Record<string, unknown>;

              insertSignal(crisisInput);
            }
          } catch (err: unknown) {
            console.warn(`[${pipeline}] Error inserting O-tier signal for tweet ${tweet.id}:`, err);
          }
        }

        continue;
      }

      const tierTweets = filteredTweets.map((tweet) => ({
        ...tweet,
        metadata: {
          ...(tweet.metadata ?? {}),
          accountTier: tierDefinition.tier,
        },
      }));

      const classificationResults = await classifyInBatches(tierTweets, pipeline, config);

      if (DRY_RUN) {
        for (const result of classificationResults) {
          const key = String(result.actionType ?? result.suggestedAction ?? result.category ?? 'unknown');
          dryRunCounts[key] = (dryRunCounts[key] ?? 0) + 1;
        }
        continue;
      }

      const byTweetId = new Map(classificationResults.map((result) => [String(result.tweetId), result]));

      for (const tweet of tierTweets) {
        const classification = byTweetId.get(tweet.id);
        if (!classification) {
          console.warn(`[WARN] Missing classification for tweet ${tweet.id} — skipping`);
          continue;
        }

        const legacyCategory = typeof classification.category === 'number' ? classification.category : 0;
        const input = {
          tweetId: tweet.id,
          author: tweet.author,
          content: tweet.content,
          url: tweet.url,
          category: legacyCategory,
          confidence: Number(classification.confidence ?? 70),
          relevance: Number(classification.relevance ?? 70),
          sentiment: String(classification.sentiment ?? 'neutral'),
          priority: Number(classification.priority ?? 3),
          riskLevel: String(classification.riskLevel ?? 'low'),
          suggestedAction: String(classification.suggestedAction ?? classification.actionType ?? 'monitor'),
          alertLevel: String(classification.alertLevel ?? 'none'),
          sourceAdapter: adapterType,
          rawJson: JSON.stringify({ tweet, classification, pipeline }),
          pipeline,
          actionType: classification.actionType,
          angle: classification.angle,
          tones: classification.tones,
          connection: classification.connection,
          accountTier: classification.accountTier,
          severity: classification.severity,
          reason: classification.reason,
        } as InsertSignalInput & Record<string, unknown>;

        try {
          insertSignal(input);
          stored += 1;
          if (classification.alertLevel === 'red') {
            redCount += 1;
          }
        } catch (err: unknown) {
          console.warn(`[${pipeline}] Error inserting signal for tweet ${tweet.id}:`, err);
        }
      }
    }

    if (DRY_RUN) {
      console.log(
        `[${pipeline}] Fetched ${fetched} tweets, classified=${JSON.stringify(dryRunCounts)}, storedOwn=${stored}, crisisFlagged=${crisisTriggered} (dry-run, not stored)`
      );
      return;
    }

    logJson('collect', {
      pipeline,
      fetched,
      stored,
      red: redCount,
      crisisFlagged: crisisTriggered,
    });
    return;
  }

  const fetchedTweets: RawTweet[] = [];

  if (pipeline === 'mentions') {
    fetchedTweets.push(...await fetchTweetsByQuery(config, buildMentionsQuery(), adapterType));
  }

  if (pipeline === 'crisis') {
    fetchedTweets.push(...await fetchTweetsByQuery(config, buildCrisisQuery(), adapterType));
  }

  if (pipeline === 'trends') {
    const narratives = loadNarrativesConfig().filter((narrative) => narrative.active);
    for (const narrative of narratives) {
      const query = buildTrendsQuery(narrative);
      const tweets = await fetchTweetsByQuery(config, query, adapterType);
      fetchedTweets.push(...tweets.map((tweet) => ({
        ...tweet,
        metadata: {
          ...(tweet.metadata ?? {}),
          narrativeTag: narrative.tag,
        },
      })));
    }

    const alternateAdapter = getTrendsAlternateAdapter(config);
    const trendKeywords = [...new Set(narratives.flatMap((narrative) => narrative.keywords))]
      .map((keyword) => `"${keyword}"`)
      .join(' OR ');
    if (trendKeywords) {
      const strategyCQuery = `(${trendKeywords}) min_faves:100 -filter:replies lang:en`;
      fetchedTweets.push(...await fetchTweetsByQuery(config, strategyCQuery, alternateAdapter));
    }
  }

  // No global dedup - same tweet can exist in multiple pipelines
  // The insertSignal function handles upsert with pipelines array
  const tweets = fetchedTweets;
  const results = await classifyInBatches(tweets, pipeline, config);

  if (DRY_RUN) {
    const counts: Record<string, number> = {};

    for (const result of results) {
      const key = String(result.actionType ?? result.suggestedAction ?? result.category ?? 'unknown');
      counts[key] = (counts[key] ?? 0) + 1;
    }

    console.log(
      `[${pipeline}] Fetched ${tweets.length} tweets, classified=${JSON.stringify(counts)} (dry-run, not stored)`
    );
    return;
  }

  let stored = 0;
  let redCount = 0;
  const byTweetId = new Map(results.map((result) => [String(result.tweetId), result]));

  for (const tweet of tweets) {
    const classification = byTweetId.get(tweet.id);
    if (!classification) {
      console.warn(`[WARN] Missing classification for tweet ${tweet.id} — skipping`);
      continue;
    }

    const legacyCategory = typeof classification.category === 'number' ? classification.category : 0;
    const input = {
      tweetId: tweet.id,
      author: tweet.author,
      content: tweet.content,
      url: tweet.url,
      category: legacyCategory,
      confidence: Number(classification.confidence ?? 70),
      relevance: Number(classification.relevance ?? 70),
      sentiment: String(classification.sentiment ?? 'neutral'),
      priority: Number(classification.priority ?? 3),
      riskLevel: String(classification.riskLevel ?? 'low'),
      suggestedAction: String(classification.suggestedAction ?? classification.actionType ?? 'monitor'),
      alertLevel: String(classification.alertLevel ?? 'none'),
      sourceAdapter: adapterType,
      rawJson: JSON.stringify({ tweet, classification, pipeline }),
      pipeline,
      actionType: classification.actionType,
      angle: classification.angle,
      tones: classification.tones,
      connection: classification.connection,
      accountTier: classification.accountTier,
      severity: classification.severity,
      reason: classification.reason,
    } as InsertSignalInput & Record<string, unknown>;

    try {
      insertSignal(input);
      stored += 1;
      if (classification.alertLevel === 'red') {
        redCount += 1;
      }
    } catch (err: unknown) {
      // Upsert handles duplicates gracefully by updating the pipelines array
      // Log warning but don't fail
      console.warn(`[${pipeline}] Error inserting signal for tweet ${tweet.id}:`, err);
    }
  }

  logJson('collect', {
    pipeline,
    fetched: tweets.length,
    stored,
    red: redCount,
  });
}

main().catch((err) => {
  logJson('error', {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
