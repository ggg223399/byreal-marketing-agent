import cron from 'node-cron';
import type { EnrichmentConfig, ProcessedSignal, SuggestedAction } from './types.js';
import { getSignalsForEnrichment, insertV5Signal, updateSignalMetrics } from '../db/index.js';

export interface TweetMetrics {
  likes: number;
  retweets: number;
  replies: number;
  views: number;
  [key: string]: unknown;
}

export type MetricsFetchFn = (tweetId: string, tweetUrl?: string) => Promise<TweetMetrics | null>;
export type ResolveChannelsFn = (signal: ProcessedSignal) => string[];

export interface EnrichmentJob {
  start(): void;
  stop(): void;
  runOnce(): Promise<EnrichmentRunResult>;
}

export interface EnrichmentRunResult {
  processed: number;
  enriched: number;
  trending: number;
  errors: number;
}

function isTrending(
  metrics: TweetMetrics,
  thresholds: EnrichmentConfig['enrichment']['trending']['thresholds'],
): boolean {
  return (
    metrics.views >= thresholds.views
    || metrics.likes >= thresholds.likes
    || metrics.retweets >= thresholds.retweets
  );
}

function appendTrendingNote(original: string | undefined, note: string): string {
  return original && original.trim().length > 0
    ? `${original} | ${note}`
    : note;
}

export function createEnrichmentJob(
  config: EnrichmentConfig,
  fetchMetrics: MetricsFetchFn,
  resolveChannels: ResolveChannelsFn,
): EnrichmentJob {
  const { enrichment } = config;
  let task: cron.ScheduledTask | null = null;

  async function runOnce(): Promise<EnrichmentRunResult> {
    const result: EnrichmentRunResult = { processed: 0, enriched: 0, trending: 0, errors: 0 };

    if (!enrichment.enabled) {
      console.log('[enrichment] Disabled, skipping');
      return result;
    }

    const signals = getSignalsForEnrichment(
      enrichment.delay_minutes,
      enrichment.max_age_hours,
      enrichment.batch_size,
    );

    if (signals.length === 0) {
      console.log('[enrichment] No signals to enrich');
      return result;
    }

    console.log(`[enrichment] Processing ${signals.length} signals`);

    for (const signal of signals) {
      result.processed++;

      try {
        const metrics = await fetchMetrics(signal.tweetId, signal.url);
        if (!metrics) {
          updateSignalMetrics(signal.id, { fetched: false });
          continue;
        }

        updateSignalMetrics(signal.id, { ...metrics });
        result.enriched++;

        if (enrichment.trending?.enabled && isTrending(metrics, enrichment.trending.thresholds)) {
          result.trending++;
          console.log(
            `[enrichment] TRENDING: @${signal.author} - `
            + `views=${metrics.views} likes=${metrics.likes} rt=${metrics.retweets} - ${signal.url}`,
          );

          try {
            const trendingSignal: ProcessedSignal = {
              tweet: {
                id: `${signal.tweetId}_trending`,
                author: signal.author,
                content: signal.content,
                url: signal.url ?? '',
                created_at: signal.createdAt,
              },
              sourceName: signal.sourceName ?? 'mentions',
              alertLevel: 'red',
              suggestedAction: (signal.suggestedAction ?? 'like_only') as SuggestedAction,
              tones: [
                {
                  id: signal.v5Tone ?? 'casual',
                  label: signal.v5Tone ?? 'Casual',
                  description: 'Auto-assigned by enrichment',
                },
              ],
              replyAngle: appendTrendingNote(
                signal.replyAngle,
                `TRENDING - views: ${metrics.views}, likes: ${metrics.likes}, retweets: ${metrics.retweets}`,
              ),
              reasoning: appendTrendingNote(
                signal.judgeReasoning,
                'Auto-upgraded by enrichment: exceeded trending thresholds',
              ),
            };

            insertV5Signal({
              tweetId: trendingSignal.tweet.id,
              author: trendingSignal.tweet.author,
              content: trendingSignal.tweet.content,
              url: signal.url,
              resolvedChannels: resolveChannels(trendingSignal),
              sourceName: trendingSignal.sourceName,
              alertLevel: trendingSignal.alertLevel,
              suggestedAction: trendingSignal.suggestedAction,
              tones: trendingSignal.tones,
              replyAngle: trendingSignal.replyAngle,
              judgeReasoning: trendingSignal.reasoning,
              rawJson: JSON.stringify({ originalSignalId: signal.id, metrics }),
            });
          } catch (err) {
            console.error(`[enrichment] Failed to insert trending signal for ${signal.tweetId}:`, err);
          }
        }
      } catch (err) {
        result.errors++;
        console.error(`[enrichment] Error enriching signal ${signal.id}:`, err);
        updateSignalMetrics(signal.id, { error: String(err) });
      }
    }

    console.log(
      `[enrichment] Done: processed=${result.processed} enriched=${result.enriched} `
      + `trending=${result.trending} errors=${result.errors}`,
    );
    return result;
  }

  return {
    start() {
      if (!enrichment.enabled) {
        console.log('[enrichment] Disabled by config');
        return;
      }

      task = cron.schedule(
        enrichment.schedule,
        () => {
          runOnce().catch((err) => {
            console.error('[enrichment] Cron run failed:', err);
          });
        },
        { scheduled: false } as any,
      );

      task.start();
      console.log(
        `[enrichment] Started with schedule: ${enrichment.schedule} `
        + `(delay: ${enrichment.delay_minutes}min, batch: ${enrichment.batch_size})`,
      );
    },

    stop() {
      if (task) {
        task.stop();
        task = null;
        console.log('[enrichment] Stopped');
      }
    },

    runOnce,
  };
}
