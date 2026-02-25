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
  it('maps high confidence reply_needed to red', () => {
    expect(deriveAlertLevel('reply_needed', 0.9)).toBe('red');
  });

  it('maps medium confidence reply_needed to orange', () => {
    expect(deriveAlertLevel('reply_needed', 0.6)).toBe('orange');
  });

  it('maps low confidence reply_needed to none', () => {
    expect(deriveAlertLevel('reply_needed', 0.2)).toBe('none');
  });

  it('maps watch_only to yellow', () => {
    expect(deriveAlertLevel('watch_only', 0.1)).toBe('yellow');
  });

  it('maps ignore to none', () => {
    expect(deriveAlertLevel('ignore', 0.9)).toBe('none');
  });

  it('clamps >1 confidence before mapping', () => {
    expect(deriveAlertLevel('reply_needed', 9)).toBe('red');
  });

  it('treats NaN as zero confidence', () => {
    expect(deriveAlertLevel('reply_needed', Number.NaN)).toBe('none');
  });

  it('treats Infinity as zero confidence', () => {
    expect(deriveAlertLevel('reply_needed', Number.POSITIVE_INFINITY)).toBe('none');
  });
});

describe('classifyTweets', () => {
  it('returns empty for empty input', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = '[]';
    await expect(classifyTweets([], baseConfig)).resolves.toEqual([]);
  });

  it('parses mocked response and preserves tweet order', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      { tweetId: 't2', signalClass: 'watch_only', confidence: 0.7, reason: 'r2' },
      { tweetId: 't1', signalClass: 'reply_needed', confidence: 0.85, reason: 'r1' },
    ]);

    const result = await classifyTweets(tweets, baseConfig);
    expect(result.map((r) => r.tweetId)).toEqual(['t1', 't2']);
    expect(result[0].alertLevel).toBe('red');
    expect(result[1].alertLevel).toBe('yellow');
  });

  it('extracts JSON when wrapped in prose', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = `noise\n${JSON.stringify([
      { tweetId: 't1', signalClass: 'ignore', confidence: 0.2, reason: 'x' },
      { tweetId: 't2', signalClass: 'watch_only', confidence: 0.5, reason: 'y' },
    ])}\nmore noise`;

    const result = await classifyTweets(tweets, baseConfig);
    expect(result[0].signalClass).toBe('ignore');
    expect(result[1].signalClass).toBe('watch_only');
  });

  it('throws on missing classification for tweet', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      { tweetId: 't1', signalClass: 'ignore', confidence: 0.2, reason: 'x' },
    ]);

    await expect(classifyTweets(tweets, baseConfig)).rejects.toThrow('Missing classification for tweet t2');
  });

  it('throws on invalid signal class', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      { tweetId: 't1', signalClass: 'bad', confidence: 0.2, reason: 'x' },
      { tweetId: 't2', signalClass: 'ignore', confidence: 0.2, reason: 'x' },
    ]);
    await expect(classifyTweets(tweets, baseConfig)).rejects.toThrow('Invalid signalClass');
  });

  it('throws on invalid reason', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      { tweetId: 't1', signalClass: 'ignore', confidence: 0.2, reason: '' },
      { tweetId: 't2', signalClass: 'ignore', confidence: 0.2, reason: 'x' },
    ]);
    await expect(classifyTweets(tweets, baseConfig)).rejects.toThrow('Invalid reason');
  });

  it('clamps confidence values from parser', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      { tweetId: 't1', signalClass: 'reply_needed', confidence: 10, reason: 'x' },
      { tweetId: 't2', signalClass: 'reply_needed', confidence: -1, reason: 'x' },
    ]);
    const result = await classifyTweets(tweets, baseConfig);
    expect(result[0].confidence).toBe(1);
    expect(result[1].confidence).toBe(0);
  });
});
