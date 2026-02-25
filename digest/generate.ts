import { getDb, getPendingSignals } from '../db/index.js';
import type { AlertLevel, SignalClass } from '../types/index.js';

type ClassCounts = Record<SignalClass, number>;
type AlertCounts = Record<AlertLevel, number>;

export interface DailyDigest {
  date: string;
  totalSignals: number;
  pendingSignals: number;
  classCounts: ClassCounts;
  alertCounts: AlertCounts;
  highlights: Array<{ id: number; author: string; content: string; alertLevel: AlertLevel; confidence: number }>;
}

export function generateDailyDigest(targetDate = new Date()): DailyDigest {
  const start = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
  const end = new Date(start.getTime() + 86400000);
  const startTs = Math.floor(start.getTime() / 1000);
  const endTs = Math.floor(end.getTime() / 1000);

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, author, content, signal_class, confidence, alert_level
       FROM signals
       WHERE created_at >= ? AND created_at < ?
       ORDER BY created_at DESC`
    )
    .all(startTs, endTs) as Array<{
    id: number;
    author: string;
    content: string;
    signal_class: SignalClass;
    confidence: number;
    alert_level: AlertLevel;
  }>;

  const classCounts: ClassCounts = {
    reply_needed: 0,
    watch_only: 0,
    ignore: 0,
  };
  const alertCounts: AlertCounts = {
    red: 0,
    orange: 0,
    yellow: 0,
    none: 0,
  };

  for (const row of rows) {
    classCounts[row.signal_class] += 1;
    alertCounts[row.alert_level] += 1;
  }

  const pendingSignals = getPendingSignals(1000).filter((s) => s.createdAt >= startTs && s.createdAt < endTs).length;
  const highlights = rows
    .filter((row) => row.alert_level === 'red' || row.alert_level === 'orange')
    .slice(0, 5)
    .map((row) => ({
      id: row.id,
      author: row.author,
      content: row.content,
      alertLevel: row.alert_level,
      confidence: row.confidence,
    }));

  return {
    date: start.toISOString().slice(0, 10),
    totalSignals: rows.length,
    pendingSignals,
    classCounts,
    alertCounts,
    highlights,
  };
}

export function formatDailyDigest(digest: DailyDigest): string {
  const highlightLines =
    digest.highlights.length === 0
      ? 'No red/orange highlights today.'
      : digest.highlights
          .map(
            (item) =>
              `- #${item.id} ${item.author} (${item.alertLevel}, ${(item.confidence * 100).toFixed(0)}%): ${item.content.slice(0, 120)}`
          )
          .join('\n');

  return [
    `📊 Daily Marketing Digest (${digest.date})`,
    `Total signals: ${digest.totalSignals}`,
    `Pending review: ${digest.pendingSignals}`,
    `Classes: reply_needed=${digest.classCounts.reply_needed}, watch_only=${digest.classCounts.watch_only}, ignore=${digest.classCounts.ignore}`,
    `Alerts: red=${digest.alertCounts.red}, orange=${digest.alertCounts.orange}, yellow=${digest.alertCounts.yellow}, none=${digest.alertCounts.none}`,
    '',
    'Highlights:',
    highlightLines,
  ].join('\n');
}
