import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DB_PATH = ':memory:';
});

import { closeDb, getDb, insertV5Signal, recordSignalFeedback } from '../../db/index.js';
import { formatDailyFeedbackDigest, generateDailyFeedbackDigest } from '../../digest/feedback.js';

beforeEach(() => {
  closeDb();
  getDb();
});

describe('digest/feedback', () => {
  it('aggregates daily feedback counts and top sources', () => {
    const signal1 = insertV5Signal({
      tweetId: 'fd-1',
      author: '@alice',
      content: 'one',
      url: 'https://x.com/alice/status/1',
      resolvedChannels: ['needs-reply'],
      sourceName: 'mentions',
      alertLevel: 'orange',
      suggestedAction: 'reply_supportive',
      tones: [{ id: 'casual', label: 'Casual', description: 'Friendly' }],
      replyAngle: 'Say thanks',
      judgeReasoning: 'Relevant',
      rawJson: '{}',
    });
    const signal2 = insertV5Signal({
      tweetId: 'fd-2',
      author: '@bob',
      content: 'two',
      url: 'https://x.com/bob/status/2',
      resolvedChannels: ['noise'],
      sourceName: 'ecosystem',
      alertLevel: 'yellow',
      suggestedAction: 'like_only',
      tones: [{ id: 'official', label: 'Official', description: 'Formal' }],
      replyAngle: 'Monitor',
      judgeReasoning: 'Low priority',
      rawJson: '{}',
    });

    recordSignalFeedback({
      signalId: signal1.id,
      feedbackType: 'wrong_category',
      feedbackBy: 'tester1',
      sourceName: 'mentions',
      alertLevel: 'orange',
      suggestedAction: 'reply_supportive',
      resolvedChannels: ['needs-reply'],
      tweetId: 'fd-1',
      snapshotJson: '{}',
    });
    recordSignalFeedback({
      signalId: signal2.id,
      feedbackType: 'good_signal',
      feedbackBy: 'tester2',
      sourceName: 'ecosystem',
      alertLevel: 'yellow',
      suggestedAction: 'like_only',
      resolvedChannels: ['noise'],
      tweetId: 'fd-2',
      snapshotJson: '{}',
    });
    recordSignalFeedback({
      signalId: signal1.id,
      feedbackType: 'duplicate',
      feedbackBy: 'tester3',
      sourceName: 'mentions',
      alertLevel: 'orange',
      suggestedAction: 'reply_supportive',
      resolvedChannels: ['needs-reply'],
      tweetId: 'fd-1',
      snapshotJson: '{}',
    });

    const digest = generateDailyFeedbackDigest(new Date());
    expect(digest.totalFeedback).toBe(3);
    expect(digest.uniqueSignals).toBe(2);
    expect(digest.feedbackCounts.wrong_category).toBe(1);
    expect(digest.feedbackCounts.good_signal).toBe(1);
    expect(digest.feedbackCounts.duplicate).toBe(1);
    expect(digest.topSources[0]).toEqual({ sourceName: 'mentions', count: 2 });
  });

  it('formats a readable digest message', () => {
    const digest = {
      date: '2026-03-09',
      totalFeedback: 2,
      uniqueSignals: 2,
      feedbackCounts: {
        not_relevant: 1,
        wrong_category: 0,
        low_quality: 0,
        duplicate: 0,
        good_signal: 1,
      },
      topSources: [{ sourceName: 'mentions', count: 2 }],
      recentFeedback: [
        { signalId: 11, feedbackType: 'good_signal' as const, feedbackBy: 'alice', sourceName: 'mentions' },
      ],
    };

    const message = formatDailyFeedbackDigest(digest);
    expect(message).toContain('Daily Feedback Digest (2026-03-09)');
    expect(message).toContain('Top sources: mentions=2');
    expect(message).toContain('#11 good_signal (mentions) by alice');
  });
});
