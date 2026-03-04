import { afterEach, describe, expect, it } from 'vitest';
import { classifyForPipeline } from '../classifier/classify.js';
import type { CollectorConfig, Pipeline, RawTweet } from '../types/index.js';

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

describe('classifyForPipeline', () => {
  it('returns empty for empty input', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = '[]';
    await expect(classifyForPipeline([], 'mentions', baseConfig)).resolves.toEqual([]);
  });

  it('parses mocked response and preserves tweet order for mentions pipeline', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      {
        tweetId: 't2',
        actionType: 'reply',
        angle: 'Celebrate the milestone',
        tones: [
          { id: 'friendly_peer', label: 'Friendly Peer', description: '轻松对等，亲切友好' }
        ],
        reason: 'Great news for the ecosystem',
      },
      {
        tweetId: 't1',
        actionType: 'qrt',
        angle: 'Share the news',
        tones: [
          { id: 'helpful_expert', label: 'Helpful Expert', description: '专业权威，提供具体价值' },
          { id: 'friendly_peer', label: 'Friendly Peer', description: '轻松对等，亲切友好' }
        ],
        reason: 'Important announcement',
      },
    ]);

    const result = await classifyForPipeline(tweets, 'mentions', baseConfig);
    expect(result.map((r) => r.tweetId)).toEqual(['t1', 't2']);
    expect(result[0].actionType).toBe('qrt');
    expect(result[1].actionType).toBe('reply');
    expect(result[0].tones).toHaveLength(2);
    expect(result[1].tones).toHaveLength(1);
  });

  it('parses mocked response for crisis pipeline with severity', async () => {
    const crisisTweets: RawTweet[] = [
      { id: 'c1', author: '@reporter', content: 'Security breach reported', url: 'u3', created_at: 3 },
    ];

    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      {
        tweetId: 'c1',
        actionType: 'statement',
        angle: 'Issue acknowledgment',
        tones: [
          { id: 'direct_rebuttal', label: 'Direct Rebuttal', description: '正面回应关切，建设性反驳' }
        ],
        severity: 'high',
        reason: 'Potential security incident requiring response',
      },
    ]);

    const result = await classifyForPipeline(crisisTweets, 'crisis', baseConfig);
    expect(result[0].actionType).toBe('statement');
    expect(result[0].severity).toBe('high');
    expect(result[0].tones[0].id).toBe('direct_rebuttal');
  });

  it('parses mocked response for network pipeline with accountTier', async () => {
    const networkTweets: RawTweet[] = [
      { id: 'n1', author: '@influencer', content: 'Big announcement', url: 'u4', created_at: 4 },
    ];

    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      {
        tweetId: 'n1',
        actionType: 'reply',
        angle: 'Engage with influential voice',
        tones: [
          { id: 'helpful_expert', label: 'Helpful Expert', description: '专业权威，提供具体价值' }
        ],
        accountTier: 'S',
        reason: 'High-impact account in the network',
      },
    ]);

    const result = await classifyForPipeline(networkTweets, 'network', baseConfig);
    expect(result[0].actionType).toBe('reply');
    expect(result[0].accountTier).toBe('S');
  });

  it('parses mocked response for trends pipeline with connection', async () => {
    const trendsTweets: RawTweet[] = [
      { id: 'tr1', author: '@user', content: 'New trend emerging', url: 'u5', created_at: 5 },
    ];

    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      {
        tweetId: 'tr1',
        actionType: 'qrt',
        angle: 'Join the conversation',
        tones: [
          { id: 'friendly_peer', label: 'Friendly Peer', description: '轻松对等，亲切友好' }
        ],
        connection: 'direct',
        reason: 'Directly related to our ecosystem',
      },
    ]);

    const result = await classifyForPipeline(trendsTweets, 'trends', baseConfig);
    expect(result[0].actionType).toBe('qrt');
    expect(result[0].connection).toBe('direct');
  });

  it('extracts JSON when wrapped in prose', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = `noise\n${JSON.stringify([
      {
        tweetId: 't1',
        actionType: 'like',
        angle: 'Show appreciation',
        tones: [
          { id: 'friendly_peer', label: 'Friendly Peer', description: '轻松对等，亲切友好' }
        ],
        reason: 'Nice content',
      },
      {
        tweetId: 't2',
        actionType: 'monitor',
        angle: 'Keep track',
        tones: [
          { id: 'humble_ack', label: 'Humble Ack', description: '感恩致谢，不强推' }
        ],
        reason: 'Needs monitoring',
      },
    ])}\nmore noise`;

    const result = await classifyForPipeline(tweets, 'mentions', baseConfig);
    expect(result[0].actionType).toBe('like');
    expect(result[1].actionType).toBe('monitor');
  });

  it('throws on missing classification for tweet', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      {
        tweetId: 't1',
        actionType: 'reply',
        angle: 'Test',
        tones: [
          { id: 'friendly_peer', label: 'Friendly Peer', description: '轻松对等，亲切友好' }
        ],
        reason: 'x',
      },
    ]);

    await expect(classifyForPipeline(tweets, 'mentions', baseConfig)).rejects.toThrow('Missing classification for tweet t2');
  });

  it('throws on invalid actionType for pipeline', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      {
        tweetId: 't1',
        actionType: 'invalid_action',
        angle: 'Test',
        tones: [
          { id: 'friendly_peer', label: 'Friendly Peer', description: '轻松对等，亲切友好' }
        ],
        reason: 'x',
      },
    ]);

    await expect(classifyForPipeline(tweets, 'mentions', baseConfig)).rejects.toThrow('Invalid actionType');
  });

  it('throws on invalid reason', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      {
        tweetId: 't1',
        actionType: 'reply',
        angle: 'Test',
        tones: [
          { id: 'friendly_peer', label: 'Friendly Peer', description: '轻松对等，亲切友好' }
        ],
        reason: '',
      },
    ]);

    await expect(classifyForPipeline(tweets, 'mentions', baseConfig)).rejects.toThrow('Invalid reason');
  });

  it('throws when tones array is empty', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      {
        tweetId: 't1',
        actionType: 'skip',
        angle: 'Skip',
        tones: [],
        reason: 'No action needed',
      },
    ]);

    await expect(classifyForPipeline(tweets, 'mentions', baseConfig)).rejects.toThrow('Invalid tones');
  });

  it('throws when tones array exceeds 3 items', async () => {
    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      {
        tweetId: 't1',
        actionType: 'reply',
        angle: 'Test',
        tones: [
          { id: 't1', label: 'T1', description: 'd1' },
          { id: 't2', label: 'T2', description: 'd2' },
          { id: 't3', label: 'T3', description: 'd3' },
          { id: 't4', label: 'T4', description: 'd4' },
        ],
        reason: 'x',
      },
    ]);

    await expect(classifyForPipeline(tweets, 'mentions', baseConfig)).rejects.toThrow('Invalid tones');
  });

  it('throws on missing severity for crisis pipeline', async () => {
    const crisisTweets: RawTweet[] = [
      { id: 'c1', author: '@user', content: 'Issue', url: 'u', created_at: 1 },
    ];

    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      {
        tweetId: 'c1',
        actionType: 'statement',
        angle: 'Test',
        tones: [{ id: 'direct', label: 'Direct', description: 'd' }],
        reason: 'x',
      },
    ]);

    await expect(classifyForPipeline(crisisTweets, 'crisis', baseConfig)).rejects.toThrow('Invalid severity');
  });

  it('throws on missing connection for trends pipeline', async () => {
    const trendsTweets: RawTweet[] = [
      { id: 'tr1', author: '@user', content: 'Trend', url: 'u', created_at: 1 },
    ];

    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      {
        tweetId: 'tr1',
        actionType: 'qrt',
        angle: 'Test',
        tones: [{ id: 'friendly', label: 'Friendly', description: 'd' }],
        reason: 'x',
      },
    ]);

    await expect(classifyForPipeline(trendsTweets, 'trends', baseConfig)).rejects.toThrow('Invalid connection');
  });

  it('throws on missing accountTier for network pipeline', async () => {
    const networkTweets: RawTweet[] = [
      { id: 'n1', author: '@user', content: 'Mention', url: 'u', created_at: 1 },
    ];

    process.env.MOCK_CLASSIFICATION_RESPONSE = JSON.stringify([
      {
        tweetId: 'n1',
        actionType: 'reply',
        angle: 'Test',
        tones: [{ id: 'helpful', label: 'Helpful', description: 'd' }],
        reason: 'x',
      },
    ]);

    await expect(classifyForPipeline(networkTweets, 'network', baseConfig)).rejects.toThrow('Invalid accountTier');
  });
});
