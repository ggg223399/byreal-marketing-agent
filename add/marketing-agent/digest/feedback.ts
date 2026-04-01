import { getDb } from '../db/index.js';
import type { SignalFeedbackType } from '../types/index.js';

type FeedbackCounts = Record<SignalFeedbackType, number>;

export interface DailyFeedbackDigest {
  date: string;
  totalFeedback: number;
  uniqueSignals: number;
  feedbackCounts: FeedbackCounts;
  topSources: Array<{ sourceName: string; count: number }>;
  recentFeedback: Array<{
    signalId: number;
    feedbackType: SignalFeedbackType;
    feedbackBy?: string;
    sourceName?: string;
    alertLevel?: string;
    suggestedAction?: string;
    tweetId?: string;
  }>;
}

export function generateDailyFeedbackDigest(targetDate = new Date()): DailyFeedbackDigest {
  const start = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
  const end = new Date(start.getTime() + 86400000);
  const startTs = Math.floor(start.getTime() / 1000);
  const endTs = Math.floor(end.getTime() / 1000);

  const db = getDb();
  const rows = db.prepare(
    `SELECT signal_id, feedback_type, feedback_by, source_name, alert_level, suggested_action, tweet_id
     FROM signal_feedback
     WHERE created_at >= ? AND created_at < ?
     ORDER BY created_at DESC`,
  ).all(startTs, endTs) as Array<{
    signal_id: number;
    feedback_type: SignalFeedbackType;
    feedback_by: string | null;
    source_name: string | null;
    alert_level: string | null;
    suggested_action: string | null;
    tweet_id: string | null;
  }>;

  const feedbackCounts: FeedbackCounts = {
    not_relevant: 0,
    wrong_category: 0,
    low_quality: 0,
    duplicate: 0,
    good_signal: 0,
  };

  const sourceCounts = new Map<string, number>();
  const uniqueSignals = new Set<number>();

  for (const row of rows) {
    feedbackCounts[row.feedback_type] += 1;
    uniqueSignals.add(row.signal_id);

    const sourceName = row.source_name ?? 'unknown';
    sourceCounts.set(sourceName, (sourceCounts.get(sourceName) ?? 0) + 1);
  }

  const topSources = Array.from(sourceCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([sourceName, count]) => ({ sourceName, count }));

  const recentFeedback = rows.slice(0, 5).map((row) => ({
    signalId: row.signal_id,
    feedbackType: row.feedback_type,
    feedbackBy: row.feedback_by ?? undefined,
    sourceName: row.source_name ?? undefined,
    alertLevel: row.alert_level ?? undefined,
    suggestedAction: row.suggested_action ?? undefined,
    tweetId: row.tweet_id ?? undefined,
  }));

  return {
    date: start.toISOString().slice(0, 10),
    totalFeedback: rows.length,
    uniqueSignals: uniqueSignals.size,
    feedbackCounts,
    topSources,
    recentFeedback,
  };
}

export function formatDailyFeedbackDigest(digest: DailyFeedbackDigest): string {
  const topSources = digest.topSources.length > 0
    ? digest.topSources.map((item) => `${item.sourceName}=${item.count}`).join(', ')
    : 'none';

  const recentFeedback = digest.recentFeedback.length > 0
    ? digest.recentFeedback.map((item) => {
        const source = item.sourceName ?? 'unknown';
        const actor = item.feedbackBy ?? 'unknown';
        return `- #${item.signalId} ${item.feedbackType} (${source}) by ${actor}`;
      }).join('\n')
    : 'No feedback recorded today.';

  return [
    `Daily Feedback Digest (${digest.date})`,
    `Total feedback: ${digest.totalFeedback}`,
    `Unique signals touched: ${digest.uniqueSignals}`,
    `Breakdown: not_relevant=${digest.feedbackCounts.not_relevant}, wrong_category=${digest.feedbackCounts.wrong_category}, low_quality=${digest.feedbackCounts.low_quality}, duplicate=${digest.feedbackCounts.duplicate}, good_signal=${digest.feedbackCounts.good_signal}`,
    `Top sources: ${topSources}`,
    '',
    'Recent feedback:',
    recentFeedback,
  ].join('\n');
}
