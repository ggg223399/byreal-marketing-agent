import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { AlertLevel, Approval, ApprovalAction, Signal, SignalCategory } from '../types/index.js';

const DEFAULT_DB_PATH = process.env.DB_PATH || 'data/signals.db';

let dbInstance: Database.Database | null = null;

function ensureParentDir(dbPath: string): void {
  if (dbPath === ':memory:') {
    return;
  }

  const parentDir = path.dirname(dbPath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }
}

function ensureSchema(db: Database.Database): void {
  const hasSignals = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='signals'")
    .get() as { name: string } | undefined;

  if (hasSignals) {
    return;
  }

  const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf-8');
  db.exec(schemaSql);
}

export function getDb(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
  ensureParentDir(dbPath);
  dbInstance = new Database(dbPath);
  dbInstance.pragma('journal_mode = WAL');
  ensureSchema(dbInstance);
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

type SignalRow = {
  id: number;
  tweet_id: string;
  author: string;
  content: string;
  url: string | null;
  category: SignalCategory;
  confidence: number;
  relevance: number;
  sentiment: string | null;
  priority: number | null;
  risk_level: string | null;
  suggested_action: string | null;
  alert_level: AlertLevel;
  source_adapter: string;
  raw_json: string | null;
  created_at: number;
  notified_at: number | null;
};

type ApprovalRow = {
  id: number;
  signal_id: number;
  action: ApprovalAction;
  draft_text: string | null;
  final_text: string | null;
  approved_by: string | null;
  created_at: number;
};

function mapSignal(row: SignalRow): Signal {
  return {
    id: row.id,
    tweetId: row.tweet_id,
    author: row.author,
    content: row.content,
    url: row.url ?? undefined,
    category: row.category,
    confidence: row.confidence,
    relevance: row.relevance,
    sentiment: (row.sentiment as Signal['sentiment']) ?? 'neutral',
    priority: row.priority ?? 3,
    riskLevel: (row.risk_level as Signal['riskLevel']) ?? 'low',
    suggestedAction: (row.suggested_action as Signal['suggestedAction']) ?? 'monitor',
    alertLevel: row.alert_level,
    sourceAdapter: row.source_adapter,
    rawJson: row.raw_json ?? undefined,
    createdAt: row.created_at,
    notifiedAt: row.notified_at ?? undefined,
  };
}

function mapApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    signalId: row.signal_id,
    action: row.action,
    draftText: row.draft_text ?? undefined,
    finalText: row.final_text ?? undefined,
    approvedBy: row.approved_by ?? undefined,
    createdAt: row.created_at,
  };
}

export interface InsertSignalInput {
  tweetId: string;
  author: string;
  content: string;
  url?: string;
  category: SignalCategory;
  confidence: number;
  relevance: number;
  sentiment?: string;
  priority?: number;
  riskLevel?: string;
  suggestedAction?: string;
  alertLevel: AlertLevel;
  sourceAdapter: string;
  rawJson?: string;
}

export function insertSignal(input: InsertSignalInput): Signal {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO signals
        (tweet_id, author, content, url, category, confidence, relevance, sentiment, priority, risk_level, suggested_action, alert_level, source_adapter, raw_json)
       VALUES
        (@tweetId, @author, @content, @url, @category, @confidence, @relevance, @sentiment, @priority, @riskLevel, @suggestedAction, @alertLevel, @sourceAdapter, @rawJson)`
    )
    .run({
      ...input,
      url: input.url ?? null,
      sentiment: input.sentiment ?? null,
      priority: input.priority ?? null,
      riskLevel: input.riskLevel ?? null,
      suggestedAction: input.suggestedAction ?? null,
      rawJson: input.rawJson ?? null,
    });

  const inserted = getSignalById(Number(result.lastInsertRowid));
  if (!inserted) {
    throw new Error('Failed to fetch inserted signal');
  }
  return inserted;
}

export function getSignalById(id: number): Signal | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM signals WHERE id = ?').get(id) as SignalRow | undefined;
  return row ? mapSignal(row) : null;
}

export function getPendingSignals(limit = 10): Signal[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.*
       FROM signals s
       LEFT JOIN approvals a ON a.signal_id = s.id
       WHERE a.id IS NULL
       ORDER BY s.created_at DESC
       LIMIT ?`
    )
    .all(limit) as SignalRow[];

  return rows.map(mapSignal);
}

export function getUnnotifiedSignals(limit = 20): Signal[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, tweet_id, author, content, url, category, confidence, relevance, sentiment, priority, risk_level, suggested_action, alert_level, source_adapter, raw_json, created_at, notified_at
       FROM signals WHERE notified_at IS NULL ORDER BY created_at ASC LIMIT ?`
    )
    .all(limit) as SignalRow[];

  return rows.map(mapSignal);
}
export function getSignalsSince(epochSeconds: number): Signal[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, tweet_id, author, content, url, category, confidence, relevance, sentiment, priority, risk_level, suggested_action, alert_level, source_adapter, raw_json, created_at, notified_at
       FROM signals WHERE created_at > ? ORDER BY created_at DESC`
    )
    .all(epochSeconds) as SignalRow[];

  return rows.map(mapSignal);
}

export function markSignalNotified(signalId: number): void {
  const db = getDb();
  db.prepare('UPDATE signals SET notified_at = unixepoch() WHERE id = ?').run(signalId);
}

export interface RecordApprovalInput {
  signalId: number;
  action: ApprovalAction;
  draftText?: string;
  finalText?: string;
  approvedBy?: string;
}

export function recordApproval(input: RecordApprovalInput): Approval {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO approvals (signal_id, action, draft_text, final_text, approved_by)
       VALUES (@signalId, @action, @draftText, @finalText, @approvedBy)`
    )
    .run({
      ...input,
      draftText: input.draftText ?? null,
      finalText: input.finalText ?? null,
      approvedBy: input.approvedBy ?? null,
    });

  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(result.lastInsertRowid) as ApprovalRow | undefined;
  if (!row) {
    throw new Error('Failed to fetch inserted approval');
  }

  return mapApproval(row);
}

export function logAudit(actionType: string, details?: Record<string, unknown>): void {
  const db = getDb();
  db.prepare('INSERT INTO audit_log (action_type, details_json) VALUES (?, ?)').run(
    actionType,
    details ? JSON.stringify(details) : null
  );
}

export function getConfigOverride(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare('SELECT value FROM config_overrides WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setConfigOverride(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO config_overrides (key, value, updated_at)
     VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value);
}

export function getRateLimit(counterType: string, windowStart: number): number {
  const db = getDb();
  const row = db
    .prepare('SELECT count FROM rate_limits WHERE counter_type = ? AND window_start = ?')
    .get(counterType, windowStart) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function incrementRateLimit(counterType: string, windowStart: number, windowEnd: number, by = 1): number {
  const db = getDb();
  db.prepare(
    `INSERT INTO rate_limits (counter_type, count, window_start, window_end)
     VALUES (@counterType, @count, @windowStart, @windowEnd)
     ON CONFLICT(counter_type, window_start)
     DO UPDATE SET count = rate_limits.count + excluded.count, window_end = excluded.window_end`
  ).run({
    counterType,
    count: by,
    windowStart,
    windowEnd,
  });

  return getRateLimit(counterType, windowStart);
}
