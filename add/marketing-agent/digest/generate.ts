import { getDb, getPendingSignals } from '../db/index.js';
import { SIGNAL_CATEGORIES } from '../types/index.js';
import type { AlertLevel, SignalCategory } from '../types/index.js';

type ClassCounts = Record<SignalCategory, number>;
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
      `SELECT id, author, content, category, confidence, alert_level
       FROM signals
       WHERE created_at >= ? AND created_at < ?
       ORDER BY created_at DESC`
    )
    .all(startTs, endTs) as Array<{
    id: number;
    author: string;
    content: string;
    category: SignalCategory;
    confidence: number;
    alert_level: AlertLevel;
  }>;

  const classCounts: ClassCounts = {
    0: 0,
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
    6: 0,
    7: 0,
    8: 0,
  };
  const alertCounts: AlertCounts = {
    red: 0,
    orange: 0,
    yellow: 0,
    none: 0,
  };

  for (const row of rows) {
    classCounts[row.category] += 1;
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
              `- #${item.id} ${item.author} (${item.alertLevel}, ${item.confidence}%): ${item.content.slice(0, 120)}`
          )
          .join('\n');

  const categoryLine = Object.entries(digest.classCounts)
    .map(([key, count]) => {
      const category = Number(key) as SignalCategory;
      const name = SIGNAL_CATEGORIES[category] ?? `unknown_${key}`;
      return `${key}(${name})=${count}`;
    })
    .join(', ');

  return [
    `📊 Daily Marketing Digest (${digest.date})`,
    `Total signals: ${digest.totalSignals}`,
    `Pending review: ${digest.pendingSignals}`,
    `Categories: ${categoryLine}`,
    `Alerts: red=${digest.alertCounts.red}, orange=${digest.alertCounts.orange}, yellow=${digest.alertCounts.yellow}, none=${digest.alertCounts.none}`,
    '',
    'Highlights:',
    highlightLines,
  ].join('\n');
}
