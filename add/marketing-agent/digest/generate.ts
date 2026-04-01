import { getDb, getPendingSignals } from '../db/index.js';
import type { ActionType, CrisisSeverity, Pipeline } from '../types/index.js';

type PipelineCounts = Record<Pipeline, number>;
type SeverityCounts = Record<CrisisSeverity | 'none', number>;
type ActionCounts = Record<ActionType, number>;

export interface DailyDigest {
  date: string;
  totalSignals: number;
  pendingSignals: number;
  pipelineCounts: PipelineCounts;
  severityCounts: SeverityCounts;
  actionCounts: ActionCounts;
  highlights: Array<{ id: number; author: string; content: string; severity: CrisisSeverity | 'none'; pipeline: Pipeline; angle: string }>;
}

export function generateDailyDigest(targetDate = new Date()): DailyDigest {
  const start = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
  const end = new Date(start.getTime() + 86400000);
  const startTs = Math.floor(start.getTime() / 1000);
  const endTs = Math.floor(end.getTime() / 1000);

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, author, content, pipeline, action_type, angle, severity
       FROM signals
       WHERE created_at >= ? AND created_at < ?
       ORDER BY created_at DESC`
    )
    .all(startTs, endTs) as Array<{
    id: number;
    author: string;
    content: string;
    pipeline: Pipeline;
    action_type: ActionType;
    angle: string | null;
    severity: CrisisSeverity | null;
  }>;

  const pipelineCounts: PipelineCounts = {
    mentions: 0,
    network: 0,
    trends: 0,
    crisis: 0,
  };
  const severityCounts: SeverityCounts = {
    critical: 0,
    high: 0,
    medium: 0,
    none: 0,
  };
  const actionCounts: ActionCounts = {
    reply: 0,
    qrt: 0,
    like: 0,
    monitor: 0,
    skip: 0,
    statement: 0,
  };

  for (const row of rows) {
    pipelineCounts[row.pipeline] += 1;
    actionCounts[row.action_type] += 1;
    if (row.severity) {
      severityCounts[row.severity] += 1;
    } else {
      severityCounts.none += 1;
    }
  }

  const pendingSignals = getPendingSignals(1000).filter((s) => s.createdAt >= startTs && s.createdAt < endTs).length;
  const highlights = rows
    .filter((row) => row.pipeline === 'crisis' && (row.severity === 'critical' || row.severity === 'high'))
    .slice(0, 5)
    .map((row) => ({
      id: row.id,
      author: row.author,
      content: row.content,
      severity: (row.severity ?? 'none') as CrisisSeverity | 'none',
      pipeline: row.pipeline,
      angle: row.angle ?? '',
    }));

  return {
    date: start.toISOString().slice(0, 10),
    totalSignals: rows.length,
    pendingSignals,
    pipelineCounts,
    severityCounts,
    actionCounts,
    highlights,
  };
}

export function formatDailyDigest(digest: DailyDigest): string {
  const highlightLines =
    digest.highlights.length === 0
      ? 'No crisis highlights today.'
      : digest.highlights
          .map(
            (item) =>
              `- #${item.id} ${item.author} (${item.pipeline}, ${item.severity}): ${item.content.slice(0, 100)}... [angle: ${item.angle}]`
          )
          .join('\n');

  const pipelineLine = Object.entries(digest.pipelineCounts).map(([key, count]) => `${key}=${count}`).join(', ');
  
  const actionLine = Object.entries(digest.actionCounts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key}=${count}`)
    .join(', ');

  return [
    `📊 Daily Marketing Digest (${digest.date})`,
    `Total signals: ${digest.totalSignals}`,
    `Pending review: ${digest.pendingSignals}`,
    `Pipelines: ${pipelineLine}`,
    `Actions: ${actionLine || 'none'}`,
    `Severity: critical=${digest.severityCounts.critical}, high=${digest.severityCounts.high}, medium=${digest.severityCounts.medium}, none=${digest.severityCounts.none}`,
    '',
    'Highlights:',
    highlightLines,
  ].join('\n');
}
