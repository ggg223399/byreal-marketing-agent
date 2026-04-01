import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DB_PATH = ':memory:';
});

import { closeDb, getDb, getUnnotifiedSignals, insertV5Signal } from '../../db/index.js';
import { createEnrichmentJob } from '../../engine/enrichment.js';
import type { EnrichmentConfig, ProcessedSignal } from '../../engine/types.js';

const ENRICHMENT_CONFIG: EnrichmentConfig = {
  enrichment: {
    enabled: true,
    delay_minutes: 0,
    schedule: '*/10 * * * *',
    batch_size: 10,
    max_age_hours: 24,
    trending: {
      enabled: true,
      channel: 'trending',
      thresholds: {
        views: 1000,
        likes: 100,
        retweets: 10,
      },
    },
  },
};

beforeEach(() => {
  closeDb();
  getDb();
});

describe('enrichment', () => {
  it('persists resolved route snapshot for auto-upgraded trending signals', async () => {
    insertV5Signal({
      tweetId: 'base-1',
      author: '@alice',
      content: 'original signal',
      url: 'https://x.com/alice/status/1',
      resolvedChannels: ['needs-reply'],
      sourceName: 'mentions',
      alertLevel: 'orange',
      suggestedAction: 'reply_supportive',
      tones: [{ id: 'casual', label: 'Casual', description: 'Friendly' }],
      replyAngle: 'Say thanks',
      judgeReasoning: 'Relevant mention',
      rawJson: '{}',
    });

    const resolveChannels = vi.fn((signal: ProcessedSignal) => {
      expect(signal.alertLevel).toBe('red');
      return ['trending'];
    });

    const job = createEnrichmentJob(
      ENRICHMENT_CONFIG,
      vi.fn().mockResolvedValue({ views: 5000, likes: 200, retweets: 50, replies: 12 }),
      resolveChannels,
    );

    const result = await job.runOnce();
    expect(result.trending).toBe(1);

    const trendingSignal = getUnnotifiedSignals(10).find((item) => item.tweetId === 'base-1_trending');
    expect(trendingSignal?.resolvedChannels).toEqual(['trending']);
    expect(trendingSignal?.replyAngle).toBe(
      'Say thanks | TRENDING - views: 5000, likes: 200, retweets: 50',
    );
    expect(trendingSignal?.judgeReasoning).toBe(
      'Relevant mention | Auto-upgraded by enrichment: exceeded trending thresholds',
    );
    expect(resolveChannels).toHaveBeenCalledTimes(1);
  });
});
