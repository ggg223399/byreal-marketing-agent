import { afterEach, describe, expect, it } from 'vitest';
import { classifyTweets, deriveAlertLevel } from '../classifier/classify.js';
import type { CollectorConfig, RawTweet } from '../types/index.js';

const baseConfig: CollectorConfig = {
  dataSource: { type: 'mock', apiKey: '' },
  monitoring: { accountsTier1: [], accountsPartners: [], keywords: [], pollingIntervalMinutes: 30 },
  classification: { model: 'claude-haiku-4-5', temperature: 0 },
  notifications: {},
  governance: { maxRepliesPerHour: 5, maxRepliesPerDay: 20, blacklist: [], riskKeywords: [] },
};

const tweets: RawTweet[] = [
  { id: 't1', author: '@a', content: 'one', url: 'u1', created_at: 1 },
  { id: 't2', author: '@b', content: 'two', url: 'u2', created_at: 2 },
];

afterEach(() => {
  delete process.env.MOCK_CLASSIFICATION_RESPONSE;
});

describe('deriveAlertLevel', () => {
  it('maps risk_event to red at any confidence', () => {
    expect(deriveAlertLevel(8, 10)).toBe('red');
    expect(deriveAlertLevel(8, 90)).toBe('red');
  });

  it('maps high confidence solana_growth_milestone to red', () => {
    expect(deriveAlertLevel(1, 90)).toBe('red');
  });

  it('maps lower confidence solana_growth_milestone to yellow', () => {
    expect(deriveAlertLevel(1, 50)).toBe('yellow');
  });

  it('maps high confidence byreal_ranking_mention to red', () => {
    expect(deriveAlertLevel(6, 90)).toBe('red');
  });

  it('maps medium confidence byreal_ranking_mention to orange', () => {
    expect(deriveAlertLevel(6, 60)).toBe('orange');
  });

  it('maps low confidence byreal_ranking_mention to none', () => {
    expect(deriveAlertLevel(6, 30)).toBe('none');
  });

  it('maps institutional_adoption with sufficient confidence to orange', () => {
    expect(deriveAlertLevel(2, 70)).toBe('orange');
  });

  it('maps institutional_adoption with low confidence to none', () => {
    expect(deriveAlertLevel(2, 30)).toBe('none');
  });

  it('maps market_structure_insight with sufficient confidence to orange', () => {
    expect(deriveAlertLevel(5, 60)).toBe('orange');
  });

  it('maps rwa_signal to yellow regardless of confidence', () => {
    expect(deriveAlertLevel(3, 10)).toBe('yellow');
  });

  it('maps liquidity_signal to yellow regardless of confidence', () => {
    expect(deriveAlertLevel(4, 90)).toBe('yellow');
  });

  it('maps partner_momentum to yellow regardless of confidence', () => {
    expect(deriveAlertLevel(7, 20)).toBe('yellow');
  });

  it('clamps >100 confidence before mapping', () => {
    expect(deriveAlertLevel(6, 900)).toBe('red');
  });

  it('treats NaN as zero confidence', () => {
    expect(deriveAlertLevel(2, Number.NaN)).toBe('none');
  });

  it('treats Infinity as zero confidence', () => {
    expect(deriveAlertLevel(5, Number.POSITIVE_INFINITY)).toBe('none');
  });
});

describe('classifyTweets', () => {
  it('returns empty for empty input', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = '[]';
    await expect(classifyTweets([], baseConfig)).resolves.toEqual([]);
  });

  it('parses mocked response and preserves tweet order', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      {
        tweetId: 't2',
        category: 3,
        confidence: 70,
        sentiment: 'neutral',
        priority: 3,
        riskLevel: 'low',
        suggestedAction: 'monitor',
        reason: 'r2',
      },
      {
        tweetId: 't1',
        category: 1,
        confidence: 85,
        sentiment: 'positive',
        priority: 5,
        riskLevel: 'medium',
        suggestedAction: 'reply_supportive',
        reason: 'r1',
      },
    ]);

    const result = await classifyTweets(tweets, baseConfig);
    expect(result.map((r) => r.tweetId)).toEqual(['t1', 't2']);
    expect(result[0].alertLevel).toBe('red');
    expect(result[1].alertLevel).toBe('yellow');
  });

  it('extracts JSON when wrapped in prose', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = `noise\n${JSON.stringify([
      {
        tweetId: 't1',
        category: 4,
        confidence: 20,
        sentiment: 'neutral',
        priority: 2,
        riskLevel: 'low',
        suggestedAction: 'like_only',
        reason: 'x',
      },
      {
        tweetId: 't2',
        category: 3,
        confidence: 50,
        sentiment: 'positive',
        priority: 4,
        riskLevel: 'medium',
        suggestedAction: 'qrt_positioning',
        reason: 'y',
      },
    ])}\nmore noise`;

    const result = await classifyTweets(tweets, baseConfig);
    expect(result[0].category).toBe(4);
    expect(result[1].category).toBe(3);
  });

  it('throws on missing classification for tweet', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      {
        tweetId: 't1',
        category: 4,
        confidence: 20,
        sentiment: 'neutral',
        priority: 2,
        riskLevel: 'low',
        suggestedAction: 'monitor',
        reason: 'x',
      },
    ]);

    await expect(classifyTweets(tweets, baseConfig)).rejects.toThrow('Missing classification for tweet t2');
  });

  it('throws on invalid category', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      {
        tweetId: 't1',
        category: 99,
        confidence: 20,
        sentiment: 'neutral',
        priority: 2,
        riskLevel: 'low',
        suggestedAction: 'monitor',
        reason: 'x',
      },
      {
        tweetId: 't2',
        category: 4,
        confidence: 20,
        sentiment: 'neutral',
        priority: 2,
        riskLevel: 'low',
        suggestedAction: 'monitor',
        reason: 'x',
      },
    ]);
    await expect(classifyTweets(tweets, baseConfig)).rejects.toThrow('Invalid category at index 0');
  });

  it('throws on invalid reason', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      {
        tweetId: 't1',
        category: 4,
        confidence: 20,
        sentiment: 'neutral',
        priority: 2,
        riskLevel: 'low',
        suggestedAction: 'monitor',
        reason: '',
      },
      {
        tweetId: 't2',
        category: 8,
        confidence: 20,
        sentiment: 'negative',
        priority: 5,
        riskLevel: 'high',
        suggestedAction: 'escalate_internal',
        reason: 'x',
      },
    ]);
    await expect(classifyTweets(tweets, baseConfig)).rejects.toThrow('Invalid reason');
  });

  it('clamps confidence values from parser', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      {
        tweetId: 't1',
        category: 1,
        confidence: 150,
        sentiment: 'positive',
        priority: 5,
        riskLevel: 'medium',
        suggestedAction: 'reply_supportive',
        reason: 'x',
      },
      {
        tweetId: 't2',
        category: 1,
        confidence: -10,
        sentiment: 'neutral',
        priority: 1,
        riskLevel: 'low',
        suggestedAction: 'monitor',
        reason: 'x',
      },
    ]);
    const result = await classifyTweets(tweets, baseConfig);
    expect(result[0].confidence).toBe(100);
    expect(result[1].confidence).toBe(0);
  });
});
