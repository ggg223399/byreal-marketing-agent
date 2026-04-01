import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { applyMigrations, runMigration } from './migrate.js';
import type {
  ActionType,
  AccountTier,
  Approval,
  ApprovalAction,
  ConnectionStrength,
  CrisisSeverity,
  Pipeline,
  SignalFeedback,
  SignalFeedbackType,
  PipelineSignal,
  ToneItem,
} from '../types/index.js';

/** 默认数据库文件路径，优先读取营销专用环境变量，再回退 DB_PATH */
const DEFAULT_DB_PATH =
  process.env.MARKETING_AGENT_DB_PATH ||
  process.env.DB_PATH ||
  'data/signals.db';

/** 全局单例数据库实例，避免重复打开连接 */
let dbInstance: Database.Database | null = null;

/**
 * 确保数据库文件所在的父目录存在。
 * 若路径为内存数据库（`:memory:`）则跳过，否则递归创建目录。
 * @param dbPath 数据库文件路径
 */
function ensureParentDir(dbPath: string): void {
  if (dbPath === ':memory:') {
    return;
  }

  const parentDir = path.dirname(dbPath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }
}

/**
 * 检查数据库中是否已存在 signals 表，若不存在则执行 schema.sql 初始化。
 * 用于在迁移完成后补全首次创建的表结构。
 * @param db 已打开的数据库连接
 */
function ensureSchema(db: Database.Database): void {
  const hasSignals = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='signals'")
    .get() as { name: string } | undefined;

  // signals 表已存在，无需重新执行 schema
  if (hasSignals) {
    return;
  }

  const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf-8');
  db.exec(schemaSql);
}

/**
 * 获取全局单例数据库连接。
 * 首次调用时会：
 * 1. 确保父目录存在
 * 2. 执行数据库迁移
 * 3. 打开连接并启用 WAL 模式（提升并发读写性能）
 * 4. 确保表结构已初始化
 * @returns better-sqlite3 数据库实例
 */
export function getDb(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath =
    process.env.MARKETING_AGENT_DB_PATH ||
    process.env.DB_PATH ||
    DEFAULT_DB_PATH;
  ensureParentDir(dbPath);
  dbInstance = new Database(dbPath);

  if (dbPath === ':memory:') {
    applyMigrations(dbInstance);
  } else {
    runMigration(dbPath);
    ensureSchema(dbInstance);
  }

  dbInstance.pragma('journal_mode = WAL');
  return dbInstance;
}

/**
 * 关闭全局数据库连接并将单例置为 null。
 * 通常在进程退出或测试清理时调用。
 */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * SQLite signals 表的原始行结构（snake_case 字段名与数据库列名一一对应）。
 * JSON 字段（tones、pipelines、raw_json）在此层以字符串形式存储，由 mapSignal 负责解析。
 */
type SignalRow = {
  id: number;
  tweet_id: string;
  author: string;
  content: string;
  url: string | null;
  pipeline: Pipeline;
  /** JSON 序列化的 pipeline 数组，记录该推文被哪些 pipeline 处理过 */
  pipelines: string | null;
  action_type: ActionType;
  angle: string | null;
  /** JSON 序列化的 ToneItem 数组 */
  tones: string | null;
  connection: ConnectionStrength | null;
  account_tier: AccountTier | null;
  severity: CrisisSeverity | null;
  reason: string | null;
  source_adapter: string;
  /** 原始推文 JSON 字符串，用于调试和审计 */
  raw_json: string | null;
  /** JSON 序列化的路由结果频道列表 */
  resolved_channels: string | null;
  /** Unix 秒时间戳，记录信号入库时间 */
  created_at: number;
  /** Unix 秒时间戳，记录通知发出时间；NULL 表示尚未通知 */
  notified_at: number | null;
  // v5 engine 新增字段
  source_name: string | null;
  alert_level: string | null;
  suggested_action: string | null;
  tone: string | null;
  reply_angle: string | null;
  judge_reasoning: string | null;
  enriched_at: number | null;
  enriched_metrics: string | null;
};

/**
 * SQLite approvals 表的原始行结构。
 */
type ApprovalRow = {
  id: number;
  signal_id: number;
  action: ApprovalAction;
  draft_text: string | null;
  final_text: string | null;
  approved_by: string | null;
  created_at: number;
};

type SignalFeedbackRow = {
  id: number;
  signal_id: number;
  feedback_type: SignalFeedbackType;
  feedback_by: string | null;
  source_name: string | null;
  alert_level: string | null;
  suggested_action: string | null;
  resolved_channels: string | null;
  tweet_id: string | null;
  snapshot_json: string | null;
  created_at: number;
};

/**
 * 将数据库原始行（snake_case）映射为应用层 PipelineSignal 对象（camelCase）。
 * 同时负责解析 JSON 字段：tones 和 pipelines。
 * @param row 从 SQLite 查询返回的原始行对象
 * @returns 应用层使用的 PipelineSignal 对象
 */
function mapSignal(row: SignalRow): PipelineSignal {
  let tones: ToneItem[] = [];
  if (row.tones) {
    try {
      const parsed = JSON.parse(row.tones) as unknown;
      // 仅当解析结果为数组时才赋值，防止脏数据破坏类型
      if (Array.isArray(parsed)) {
        tones = parsed as ToneItem[];
      }
    } catch {
      // JSON 解析失败时静默降级为空数组
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

  let resolvedChannels: string[] = [];
  if (row.resolved_channels) {
    try {
      const parsed = JSON.parse(row.resolved_channels) as unknown;
      if (Array.isArray(parsed)) {
        resolvedChannels = parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      resolvedChannels = [];
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
    resolvedChannels,
    createdAt: row.created_at,
    notifiedAt: row.notified_at ?? undefined,
    sourceName: row.source_name ?? undefined,
    alertLevel: row.alert_level ?? undefined,
    suggestedAction: row.suggested_action ?? undefined,
    v5Tone: row.tone ?? undefined,
    replyAngle: row.reply_angle ?? undefined,
    judgeReasoning: row.judge_reasoning ?? undefined,
  };
}

/**
 * 将数据库原始审批行映射为应用层 Approval 对象。
 * @param row 从 SQLite approvals 表查询返回的原始行
 * @returns 应用层使用的 Approval 对象
 */
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

function mapSignalFeedback(row: SignalFeedbackRow): SignalFeedback {
  let resolvedChannels: string[] = [];
  if (row.resolved_channels) {
    try {
      const parsed = JSON.parse(row.resolved_channels) as unknown;
      if (Array.isArray(parsed)) {
        resolvedChannels = parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      resolvedChannels = [];
    }
  }

  return {
    id: row.id,
    signalId: row.signal_id,
    feedbackType: row.feedback_type,
    feedbackBy: row.feedback_by ?? undefined,
    sourceName: row.source_name ?? undefined,
    alertLevel: row.alert_level ?? undefined,
    suggestedAction: row.suggested_action ?? undefined,
    resolvedChannels,
    tweetId: row.tweet_id ?? undefined,
    snapshotJson: row.snapshot_json ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * 插入信号所需的输入参数（v4 引擎格式）。
 * 对应旧版 pipeline 分类体系，v5 引擎请使用 InsertV5SignalInput。
 */
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

/**
 * 插入或更新一条信号记录。
 * 若相同 tweet_id 已存在，则合并 pipelines 列表并更新其他字段；
 * 若不存在，则插入新行。
 * @param input 信号输入参数
 * @returns 插入或更新后的 PipelineSignal 对象
 */
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
  }

  const signal = db.prepare('SELECT * FROM signals WHERE tweet_id = ?').get(input.tweetId) as SignalRow | undefined;
  if (!signal) {
    throw new Error('Failed to fetch inserted signal');
  }
  return mapSignal(signal);
}

/**
 * 按主键 ID 查询单条信号。
 * @param id 信号主键
 * @returns 找到返回 PipelineSignal，否则返回 null
 */
export function getSignalById(id: number): PipelineSignal | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM signals WHERE id = ?').get(id) as SignalRow | undefined;
  return row ? mapSignal(row) : null;
}

/**
 * 获取尚未被人工审批（approvals 表中无对应记录）的信号列表。
 * 按入库时间降序排列，适合用于审批队列展示。
 * @param limit 最多返回条数，默认 10
 * @returns 待审批信号列表
 */
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

/**
 * 获取尚未发送通知（notified_at 为 NULL）的信号列表。
 * 按入库时间升序，优先处理最早的信号。
 * @param limit 最多返回条数，默认 20
 * @returns 未通知信号列表
 */
export function getUnnotifiedSignals(limit = 20): PipelineSignal[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, tweet_id, author, content, url, pipeline, pipelines, action_type, angle, tones, connection, account_tier, severity, reason, source_adapter, raw_json, resolved_channels, created_at, notified_at,
              source_name, alert_level, suggested_action, tone, reply_angle, judge_reasoning, enriched_at, enriched_metrics
       FROM signals WHERE notified_at IS NULL ORDER BY created_at ASC LIMIT ?`
    )
    .all(limit) as SignalRow[];

  return rows.map(mapSignal);
}

/**
 * 获取指定时间点之后入库的所有信号，按时间降序排列。
 * 常用于轮询场景，传入上次查询时间戳以获取增量数据。
 * @param epochSeconds Unix 秒时间戳（不含该时间点本身）
 * @returns 该时间点之后的信号列表
 */
export function getSignalsSince(epochSeconds: number): PipelineSignal[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, tweet_id, author, content, url, pipeline, pipelines, action_type, angle, tones, connection, account_tier, severity, reason, source_adapter, raw_json, resolved_channels, created_at, notified_at,
              source_name, alert_level, suggested_action, tone, reply_angle, judge_reasoning, enriched_at, enriched_metrics
       FROM signals WHERE created_at > ? ORDER BY created_at DESC`
    )
    .all(epochSeconds) as SignalRow[];

  return rows.map(mapSignal);
}

/**
 * 按 pipeline 类型查询信号列表，按时间降序排列。
 * @param pipeline 要查询的 pipeline 类型
 * @param limit 最多返回条数，默认 20
 * @returns 该 pipeline 下的信号列表
 */
export function getSignalsByPipeline(pipeline: Pipeline, limit = 20): PipelineSignal[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, tweet_id, author, content, url, pipeline, pipelines, action_type, angle, tones, connection, account_tier, severity, reason, source_adapter, raw_json, resolved_channels, created_at, notified_at,
              source_name, alert_level, suggested_action, tone, reply_angle, judge_reasoning, enriched_at, enriched_metrics
       FROM signals WHERE pipeline = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(pipeline, limit) as SignalRow[];

  return rows.map(mapSignal);
}

/**
 * 将指定信号标记为已通知，将 notified_at 设置为当前 Unix 时间戳。
 * @param signalId 信号主键
 */
export function markSignalNotified(signalId: number): void {
  const db = getDb();
  db.prepare('UPDATE signals SET notified_at = unixepoch() WHERE id = ?').run(signalId);
}

/**
 * 记录人工审批操作所需的输入参数。
 */
export interface RecordApprovalInput {
  signalId: number;
  /** 审批动作类型，如 approve / reject / escalate */
  action: ApprovalAction;
  /** AI 生成的草稿回复文本 */
  draftText?: string;
  /** 人工修改后的最终文本 */
  finalText?: string;
  /** 执行审批的操作人标识 */
  approvedBy?: string;
}

/**
 * 在 approvals 表中插入一条审批记录，并返回完整的 Approval 对象。
 * @param input 审批输入参数
 * @returns 新插入的 Approval 对象
 * @throws 若插入后无法查回记录则抛出错误
 */
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

  // 通过 lastInsertRowid 立即查回完整记录，确保数据一致性
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(result.lastInsertRowid) as ApprovalRow | undefined;
  if (!row) {
    throw new Error('Failed to fetch inserted approval');
  }

  return mapApproval(row);
}

export interface RecordSignalFeedbackInput {
  signalId: number;
  feedbackType: SignalFeedbackType;
  feedbackBy?: string;
  sourceName?: string;
  alertLevel?: string;
  suggestedAction?: string;
  resolvedChannels?: string[];
  tweetId?: string;
  snapshotJson?: string;
}

export function recordSignalFeedback(input: RecordSignalFeedbackInput): SignalFeedback {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO signal_feedback (
        signal_id, feedback_type, feedback_by, source_name, alert_level,
        suggested_action, resolved_channels, tweet_id, snapshot_json
      )
      VALUES (
        @signalId, @feedbackType, @feedbackBy, @sourceName, @alertLevel,
        @suggestedAction, @resolvedChannels, @tweetId, @snapshotJson
      )`
    )
    .run({
      signalId: input.signalId,
      feedbackType: input.feedbackType,
      feedbackBy: input.feedbackBy ?? null,
      sourceName: input.sourceName ?? null,
      alertLevel: input.alertLevel ?? null,
      suggestedAction: input.suggestedAction ?? null,
      resolvedChannels: input.resolvedChannels ? JSON.stringify(input.resolvedChannels) : null,
      tweetId: input.tweetId ?? null,
      snapshotJson: input.snapshotJson ?? null,
    });

  const row = db.prepare('SELECT * FROM signal_feedback WHERE id = ?').get(result.lastInsertRowid) as SignalFeedbackRow | undefined;
  if (!row) {
    throw new Error('Failed to fetch inserted signal feedback');
  }

  return mapSignalFeedback(row);
}

/**
 * 向 audit_log 表写入一条审计日志。
 * 用于记录系统关键操作，便于后续追溯。
 * @param actionType 操作类型标识字符串
 * @param details 可选的附加详情对象，序列化为 JSON 存储
 */
export function logAudit(actionType: string, details?: Record<string, unknown>): void {
  const db = getDb();
  db.prepare('INSERT INTO audit_log (action_type, details_json) VALUES (?, ?)').run(
    actionType,
    details ? JSON.stringify(details) : null
  );
}

// ── v5 Engine: insert signal from ProcessedSignal ──

/**
 * v5 引擎处理后信号的插入参数。
 * 字段语义与旧版 InsertSignalInput 不同：
 * - sourceName 对应 v5 的信号来源（mentions / ecosystem / narratives / crisis）
 * - alertLevel / suggestedAction / tones / replyAngle / judgeReasoning 均为 v5 新增
 */
export interface InsertV5SignalInput {
  tweetId: string;
  author: string;
  content: string;
  url?: string;
  resolvedChannels: string[];
  /** v5 信号来源名称，用于映射到 legacy pipeline */
  sourceName: string;
  /** 告警等级，如 high / medium / low */
  alertLevel: string;
  /** v5 引擎建议的处置动作 */
  suggestedAction: string;
  /** v5 引擎生成的语气选项数组 */
  tones: import('../types/index.js').ToneItem[];
  /** v5 引擎建议的回复角度 */
  replyAngle: string;
  /** v5 Judge 模型的推理说明 */
  judgeReasoning: string;
  rawJson?: string;
}

/**
 * v5 sourceName → legacy pipeline 映射表。
 * SQLite CHECK 约束只允许 mentions/network/trends/crisis，需在此层转换。
 */
const SOURCE_TO_PIPELINE: Record<string, Pipeline> = {
  mentions: 'mentions',
  'ecosystem-core': 'network',
  ecosystem: 'network',
  narratives: 'trends',
  crisis: 'crisis',
};

/**
 * v5 suggestedAction → legacy actionType 映射表。
 * 保持与旧版 CHECK 约束兼容。
 */
const ACTION_TO_LEGACY: Record<string, ActionType> = {
  reply_supportive: 'reply',
  qrt_positioning: 'qrt',
  collab_opportunity: 'monitor',
  like_only: 'like',
  explore_signal: 'monitor',
  escalate_internal: 'monitor',
  none: 'skip',
};

/**
 * 插入或更新一条 v5 引擎生成的信号记录。
 * 若相同 tweet_id 已存在则更新 v5 专属字段并重置 notified_at（触发重新通知）；
 * 否则插入新行，source_adapter 固定为 `v5-engine`。
 * @param input v5 信号输入参数
 * @returns 插入或更新后的 PipelineSignal 对象
 */
export function insertV5Signal(input: InsertV5SignalInput): PipelineSignal {
  const db = getDb();
  const pipeline = SOURCE_TO_PIPELINE[input.sourceName] ?? 'mentions';
  const actionType = ACTION_TO_LEGACY[input.suggestedAction] ?? 'monitor';

  const existing = db.prepare('SELECT id FROM signals WHERE tweet_id = ?').get(input.tweetId) as { id: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE signals SET
        source_name = @sourceName, alert_level = @alertLevel,
        suggested_action = @suggestedAction, tone = @tone, tones = @tones,
        reply_angle = @replyAngle, judge_reasoning = @judgeReasoning,
        pipeline = @pipeline, action_type = @actionType,
        raw_json = @rawJson, resolved_channels = @resolvedChannels, notified_at = NULL
       WHERE tweet_id = @tweetId`
    ).run({
      tweetId: input.tweetId,
      sourceName: input.sourceName,
      alertLevel: input.alertLevel,
      suggestedAction: input.suggestedAction,
      tone: input.tones[0]?.id ?? 'official',
      tones: JSON.stringify(input.tones),
      replyAngle: input.replyAngle,
      judgeReasoning: input.judgeReasoning,
      pipeline,
      actionType,
      rawJson: input.rawJson ?? null,
      resolvedChannels: JSON.stringify(input.resolvedChannels),
    });
  } else {
    db.prepare(
      `INSERT INTO signals
        (tweet_id, author, content, url, pipeline, pipelines, action_type,
         source_name, alert_level, suggested_action, tone, tones, reply_angle, judge_reasoning,
         source_adapter, raw_json, resolved_channels, created_at)
       VALUES
        (@tweetId, @author, @content, @url, @pipeline, @pipelines, @actionType,
         @sourceName, @alertLevel, @suggestedAction, @tone, @tones, @replyAngle, @judgeReasoning,
         @sourceAdapter, @rawJson, @resolvedChannels, @createdAt)`
    ).run({
      tweetId: input.tweetId,
      author: input.author,
      content: input.content,
      url: input.url ?? null,
      pipeline,
      pipelines: JSON.stringify([pipeline]),
      actionType,
      sourceName: input.sourceName,
      alertLevel: input.alertLevel,
      suggestedAction: input.suggestedAction,
      tone: input.tones[0]?.id ?? 'official',
      tones: JSON.stringify(input.tones),
      replyAngle: input.replyAngle,
      judgeReasoning: input.judgeReasoning,
      sourceAdapter: 'v5-engine',
      rawJson: input.rawJson ?? null,
      resolvedChannels: JSON.stringify(input.resolvedChannels),
      createdAt: Math.floor(Date.now() / 1000),
    });
  }

  const row = db.prepare('SELECT * FROM signals WHERE tweet_id = ?').get(input.tweetId) as SignalRow | undefined;
  if (!row) throw new Error('Failed to fetch inserted v5 signal');
  return mapSignal(row);
}

// ── Engine heartbeat ──

/**
 * 向 config_overrides 表写入引擎心跳数据。
 * 同时更新两条记录：
 * 1. `engine_heartbeat_{sourceName}` — 该信号源的详细统计（JSON）
 * 2. `engine_heartbeat_last` — 最近一次心跳的 Unix 时间戳
 * 使用 UPSERT 语义，key 冲突时仅更新 value 和 updated_at。
 * @param sourceName 信号源名称，如 mentions / ecosystem
 * @param stats 心跳统计数据对象
 */
export function writeHeartbeat(sourceName: string, stats: Record<string, unknown>): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO config_overrides (key, value, updated_at)
     VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(`engine_heartbeat_${sourceName}`, JSON.stringify(stats));
  // 单独维护全局最近心跳时间戳，便于监控系统快速判断引擎存活状态
  db.prepare(
    `INSERT INTO config_overrides (key, value, updated_at)
     VALUES ('engine_heartbeat_last', ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(String(Math.floor(Date.now() / 1000)));
}

/**
 * 从 config_overrides 表读取指定 key 的配置值。
 * @param key 配置键名
 * @returns 配置值字符串，不存在时返回 undefined
 */
export function getConfigOverride(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare('SELECT value FROM config_overrides WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

/**
 * 写入或更新 config_overrides 表中的配置项。
 * 使用 UPSERT 语义，key 冲突时覆盖 value 和 updated_at。
 * @param key 配置键名
 * @param value 配置值字符串
 */
export function setConfigOverride(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO config_overrides (key, value, updated_at)
     VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value);
}

/**
 * 查询指定时间窗口内某计数器的当前值。
 * @param counterType 计数器类型，如 `twitter_reply`
 * @param windowStart 时间窗口开始的 Unix 秒时间戳
 * @returns 当前计数，不存在时返回 0
 */
export function getRateLimit(counterType: string, windowStart: number): number {
  const db = getDb();
  const row = db
    .prepare('SELECT count FROM rate_limits WHERE counter_type = ? AND window_start = ?')
    .get(counterType, windowStart) as { count: number } | undefined;
  return row?.count ?? 0;
}

// ── Enrichment helpers ──

/**
 * 获取需要进行指标富化（enrichment）的信号列表。
 * 筛选条件：
 * - enriched_at 为 NULL（尚未富化）
 * - created_at 在 delayMinutes 分钟前之前（给信号一定沉淀时间）
 * - created_at 不超过 maxAgeHours 小时（过老的信号跳过）
 * - alert_level 不为 NULL（v5 引擎处理过的信号才有此字段）
 * @param delayMinutes 富化延迟分钟数（等待推文指标稳定）
 * @param maxAgeHours 最大信号年龄（小时），超过则不再富化
 * @param batchSize 单次批量处理条数
 * @returns 待富化信号列表
 */
export function getSignalsForEnrichment(delayMinutes: number, maxAgeHours: number, batchSize: number): PipelineSignal[] {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  // 只处理创建时间早于 delayMinutes 分钟前的信号，让推文指标有时间积累
  const readyBefore = now - delayMinutes * 60;
  // 超过 maxAgeHours 的信号已过时，跳过富化
  const notOlderThan = now - maxAgeHours * 3600;

  const rows = db
    .prepare(
      `SELECT * FROM signals
       WHERE enriched_at IS NULL
         AND created_at <= ?
         AND created_at >= ?
         AND alert_level IS NOT NULL
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(readyBefore, notOlderThan, batchSize) as SignalRow[];

  return rows.map(mapSignal);
}

/**
 * 将外部采集到的推文互动指标写入信号记录。
 * 同时将 enriched_at 设置为当前时间，标记富化完成。
 * @param signalId 信号主键
 * @param metrics 指标对象，序列化为 JSON 存储
 */
export function updateSignalMetrics(signalId: number, metrics: Record<string, unknown>): void {
  const db = getDb();
  db.prepare(
    `UPDATE signals SET enriched_at = unixepoch(), enriched_metrics = ? WHERE id = ?`
  ).run(JSON.stringify(metrics), signalId);
}

/**
 * 对指定时间窗口内的速率限制计数器原子性递增，并返回更新后的计数。
 * 使用 UPSERT 实现：首次写入时插入，已存在时累加 count。
 * @param counterType 计数器类型
 * @param windowStart 时间窗口开始 Unix 秒时间戳
 * @param windowEnd 时间窗口结束 Unix 秒时间戳
 * @param by 递增量，默认为 1
 * @returns 更新后的计数值
 */
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

  // 写入后立即查询最新值，确保返回的是数据库中实际存储的计数
  return getRateLimit(counterType, windowStart);
}
