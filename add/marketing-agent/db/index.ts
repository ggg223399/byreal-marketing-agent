import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigration } from './migrate.js';
import type {
  ActionType,
  AccountTier,
  Approval,
  ApprovalAction,
  ConnectionStrength,
  CrisisSeverity,
  Pipeline,
  PipelineSignal,
  ToneItem,
} from '../types/index.js';

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
  runMigration(dbPath);
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
  pipeline: Pipeline;
  pipelines: string | null;
  action_type: ActionType;
  angle: string | null;
  tones: string | null;
  connection: ConnectionStrength | null;
  account_tier: AccountTier | null;
  severity: CrisisSeverity | null;
  reason: string | null;
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

function mapSignal(row: SignalRow): PipelineSignal {
  let tones: ToneItem[] = [];
  if (row.tones) {
    try {
      const parsed = JSON.parse(row.tones) as unknown;
      if (Array.isArray(parsed)) {
        tones = parsed as ToneItem[];
      }
    } catch {
      tones = [];
    }
  }

  let pipelines: string[] = [];
  if (row.pipelines) {
    try {
      const parsed = JSON.parse(row.pipelines) as unknown;
      if (Array.isArray(parsed)) {
        pipelines = parsed as string[];
      }
    } catch {
      pipelines = [];
    }
  }

  return {
    id: row.id,
    tweetId: row.tweet_id,
    author: row.author,
    content: row.content,
    url: row.url ?? undefined,
    pipeline: row.pipeline,
    pipelines,
    actionType: row.action_type,
    angle: row.angle ?? '',
    tones,
    connection: row.connection ?? undefined,
    accountTier: row.account_tier ?? undefined,
    severity: row.severity ?? undefined,
    reason: row.reason ?? '',
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
  pipeline: Pipeline;
  actionType: ActionType;
  angle?: string;
  tones?: ToneItem[];
  connection?: ConnectionStrength;
  accountTier?: AccountTier;
  severity?: CrisisSeverity;
  reason?: string;
  sourceAdapter: string;
  rawJson?: string;
}

export function insertSignal(input: InsertSignalInput): PipelineSignal {
  const db = getDb();

  // Check if signal with same tweet_id already exists
  const existing = db.prepare('SELECT * FROM signals WHERE tweet_id = ?').get(input.tweetId) as SignalRow | undefined;

  let pipelinesJson: string;
  if (existing?.pipelines) {
    // Merge existing pipelines with new pipeline
    try {
      const existingPipelines = JSON.parse(existing.pipelines) as string[];
      if (!existingPipelines.includes(input.pipeline)) {
        pipelinesJson = JSON.stringify([...existingPipelines, input.pipeline]);
      } else {
        pipelinesJson = existing.pipelines;
      }
    } catch {
      pipelinesJson = JSON.stringify([input.pipeline]);
    }
  } else {
    pipelinesJson = JSON.stringify([input.pipeline]);
  }

  if (existing) {
    // Update existing record with merged pipelines
    db.prepare(
      `UPDATE signals SET
        pipeline = @pipeline,
        pipelines = @pipelines,
        action_type = @actionType,
        angle = @angle,
        tones = @tones,
        connection = @connection,
        account_tier = @accountTier,
        severity = @severity,
        reason = @reason,
        source_adapter = @sourceAdapter,
        raw_json = @rawJson
       WHERE tweet_id = @tweetId`
    ).run({
      tweetId: input.tweetId,
      pipeline: input.pipeline,
      pipelines: pipelinesJson,
      actionType: input.actionType,
      angle: input.angle ?? null,
      tones: input.tones ? JSON.stringify(input.tones) : null,
      connection: input.connection ?? null,
      accountTier: input.accountTier ?? null,
      severity: input.severity ?? null,
      reason: input.reason ?? null,
      sourceAdapter: input.sourceAdapter,
      rawJson: input.rawJson ?? null,
    });
  } else {
    // Insert new record
    db.prepare(
      `INSERT INTO signals
        (tweet_id, author, content, url, pipeline, pipelines, action_type, angle, tones, connection, account_tier, severity, reason, source_adapter, raw_json, created_at)
       VALUES
        (@tweetId, @author, @content, @url, @pipeline, @pipelines, @actionType, @angle, @tones, @connection, @accountTier, @severity, @reason, @sourceAdapter, @rawJson, @createdAt)`
    ).run({
      tweetId: input.tweetId,
      author: input.author,
      content: input.content,
      url: input.url ?? null,
      pipeline: input.pipeline,
      pipelines: pipelinesJson,
      actionType: input.actionType,
      angle: input.angle ?? null,
      tones: input.tones ? JSON.stringify(input.tones) : null,
      connection: input.connection ?? null,
      accountTier: input.accountTier ?? null,
      severity: input.severity ?? null,
      reason: input.reason ?? null,
      sourceAdapter: input.sourceAdapter,
      rawJson: input.rawJson ?? null,
      createdAt: Math.floor(Date.now() / 1000),
    });
  // Get the inserted/updated signal
  const signal = db.prepare('SELECT * FROM signals WHERE tweet_id = ?').get(input.tweetId) as SignalRow | undefined;
  if (!signal) {
    throw new Error('Failed to fetch inserted signal');
  }
  return mapSignal(signal);
}

  // Get the inserted/updated signal
  const signal = db.prepare('SELECT * FROM signals WHERE tweet_id = ?').get(input.tweetId) as SignalRow | undefined;
  if (!signal) {
    throw new Error('Failed to fetch inserted signal');
  }
  return mapSignal(signal);
}

export function getSignalById(id: number): PipelineSignal | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM signals WHERE id = ?').get(id) as SignalRow | undefined;
  return row ? mapSignal(row) : null;
}

export function getPendingSignals(limit = 10): PipelineSignal[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.id, s.tweet_id, s.author, s.content, s.url, s.pipeline, s.pipelines, s.action_type, s.angle, s.tones, s.connection, s.account_tier, s.severity, s.reason, s.source_adapter, s.raw_json, s.created_at, s.notified_at
       FROM signals s
       LEFT JOIN approvals a ON a.signal_id = s.id
       WHERE a.id IS NULL
       ORDER BY s.created_at DESC
       LIMIT ?`
    )
    .all(limit) as SignalRow[];

  return rows.map(mapSignal);
}

export function getUnnotifiedSignals(limit = 20): PipelineSignal[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, tweet_id, author, content, url, pipeline, pipelines, action_type, angle, tones, connection, account_tier, severity, reason, source_adapter, raw_json, created_at, notified_at
       FROM signals WHERE notified_at IS NULL ORDER BY created_at ASC LIMIT ?`
    )
    .all(limit) as SignalRow[];

  return rows.map(mapSignal);
}

export function getSignalsSince(epochSeconds: number): PipelineSignal[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, tweet_id, author, content, url, pipeline, pipelines, action_type, angle, tones, connection, account_tier, severity, reason, source_adapter, raw_json, created_at, notified_at
       FROM signals WHERE created_at > ? ORDER BY created_at DESC`
    )
    .all(epochSeconds) as SignalRow[];

  return rows.map(mapSignal);
}

export function getSignalsByPipeline(pipeline: Pipeline, limit = 20): PipelineSignal[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, tweet_id, author, content, url, pipeline, pipelines, action_type, angle, tones, connection, account_tier, severity, reason, source_adapter, raw_json, created_at, notified_at
       FROM signals WHERE pipeline = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(pipeline, limit) as SignalRow[];

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
