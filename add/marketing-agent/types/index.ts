// ============================================
// 核心 Pipeline 类型（新架构）
// ============================================

/** 信号所属的处理流水线类型 */
export type Pipeline = 'mentions' | 'network' | 'trends' | 'crisis';

/** 对 tweet 的建议动作类型 */
export type ActionType = 'reply' | 'qrt' | 'like' | 'monitor' | 'skip' | 'statement';

/** 账号分级：O=官方自有, S=战略合作, A=生态重要, B=竞争对手, C=普通关注 */
export type AccountTier = 'O' | 'S' | 'A' | 'B' | 'C';

/** 账号分组：用于统一账号名单的业务语义选择 */
export type AccountGroup = 'core' | 'ecosystem' | 'competitor' | 'context';

/** 危机信号严重程度 */
export type CrisisSeverity = 'critical' | 'high' | 'medium';

/** 趋势信号与品牌的关联强度 */
export type ConnectionStrength = 'direct' | 'indirect' | 'stretch';

/** 各 Pipeline 的处理优先级（数字越小越高优先级） */
export const PIPELINE_PRIORITY: Record<Pipeline, number> = {
  mentions: 1,
  crisis: 2,
  network: 3,
  trends: 4,
};

// ============================================
// 语气项（用于 PipelineSignal.tones 和 LLM 输出）
// ============================================

/**
 * 单条语气推荐项，由 LLM 生成并附于信号中
 */
export interface ToneItem {
  id: string;
  label: string;
  description: string;
}

// ============================================
// 信号类型（基于 Pipeline，替代旧版 Signal）
// ============================================

/**
 * 经过分类处理后的 Pipeline 信号，存储于数据库并用于通知路由
 */
export interface PipelineSignal {
  id: number;
  tweetId: string;
  author: string;
  content: string;
  url?: string;
  /** 信号所属的主 pipeline */
  pipeline: Pipeline;
  /** 信号所属的所有 pipeline 列表（用于去重粒度控制） */
  pipelines: string[];
  actionType: ActionType;
  /** LLM 提供的参与切角 */
  angle: string;
  /** 1-3 条语气推荐 */
  tones: ToneItem[];
  /** 仅 trends pipeline 使用：关联强度 */
  connection?: ConnectionStrength;
  /** 仅 network pipeline 使用：账号等级 */
  accountTier?: AccountTier;
  /** 仅 crisis pipeline 使用：严重程度 */
  severity?: CrisisSeverity;
  reason: string;
  sourceAdapter: string;
  rawJson?: string;
  resolvedChannels: string[];
  createdAt: number;
  notifiedAt?: number;
  // v5 引擎扩展字段
  sourceName?: string;
  alertLevel?: string;
  suggestedAction?: string;
  v5Tone?: string;
  replyAngle?: string;
  judgeReasoning?: string;
}

/** LLM 分类器返回的每条 tweet 分类结果 */
export interface PipelineClassificationResult {
  tweetId: string;
  actionType: ActionType;
  angle: string;
  tones: ToneItem[];
  /** 仅 trends pipeline */
  connection?: ConnectionStrength;
  /** 仅 network pipeline */
  accountTier?: AccountTier;
  /** 仅 crisis pipeline */
  severity?: CrisisSeverity;
  reason: string;
}

// ============================================
// 原始数据类型
// ============================================

/**
 * 从各数据源适配器采集到的原始 tweet 数据
 */
export interface RawTweet {
  id: string;
  author: string;
  content: string;
  url: string;
  /** Unix 时间戳（秒） */
  created_at: number;
  metrics?: {
    likes?: number;
    retweets?: number;
    replies?: number;
    views?: number;
  };
  metadata?: Record<string, unknown>;
}

// ============================================
// 审批与审计类型
// ============================================

/** 审批操作类型 */
export type ApprovalAction = 'approve' | 'reject' | 'edit';

/** 对信号的审批记录 */
export interface Approval {
  id: number;
  signalId: number;
  action: ApprovalAction;
  draftText?: string;
  finalText?: string;
  approvedBy?: string;
  createdAt: number;
}

/** 系统操作审计日志条目 */
export interface AuditLog {
  id: number;
  actionType: string;
  detailsJson?: string;
  createdAt: number;
}

/** 信号反馈类型 */
export type SignalFeedbackType =
  | 'not_relevant'
  | 'wrong_category'
  | 'low_quality'
  | 'duplicate'
  | 'good_signal';

/** 针对信号的结构化反馈记录 */
export interface SignalFeedback {
  id: number;
  signalId: number;
  feedbackType: SignalFeedbackType;
  feedbackBy?: string;
  sourceName?: string;
  alertLevel?: string;
  suggestedAction?: string;
  resolvedChannels: string[];
  tweetId?: string;
  snapshotJson?: string;
  createdAt: number;
}

// ============================================
// 草稿与语气类型
// ============================================

/** 语气标识符（对应 ToneItem.id） */
export type DraftTone = string;

/** 单条语气对应的回复草稿 */
export interface DraftVariant {
  tone: DraftTone;
  text: string;
}

/** 配置文件中的语气定义（含 emoji） */
export interface ToneConfig {
  id: string;
  label: string;
  emoji: string;
  description: string;
}

/** 针对某个信号生成的多语气回复草稿集合 */
export interface DraftReply {
  signalId: number;
  variants: DraftVariant[];
  generatedAt: number;
}

// ============================================
// YAML 配置文件对应的类型
// ============================================

/** accounts.yaml 中的单个账号配置 */
export interface AccountConfig {
  handle: string;
  tier?: AccountTier;
  groups?: AccountGroup[];
  eventKeywords?: string[];
  keywords?: string[];
  notes?: string;
}

// ============================================
// 采集器配置（已适配 Pipeline 架构）
// ============================================

/**
 * 从 config.yaml 解析后的完整采集器配置对象
 */
export interface CollectorConfig {
  dataSource: {
    type: string;
    apiKey?: string;
    maxTweetsPerQuery?: number;
  };
  /**
   * @deprecated 请改用 pipelines 配置节
   */
  monitoring: {
    accountsTier1: string[];
    accountsPartners: string[];
    keywords: string[];
    pollingIntervalMinutes: number;
    lastSeenKeyPrefix?: string;
  };
  pipelines?: {
    mentions?: { adapter?: string; };
    network?: { adapter?: string; };
    trends?: { adapter?: string; alternateAdapter?: string; };
    crisis?: { adapter?: string; };
  };
  classification?: {
    model?: string;
    temperature?: number;
  };
  notifications: {
    riskChannel?: string;
    opportunitiesChannel?: string;
    ecosystemChannel?: string;
    digestWebhookUrl?: string;
    digestTime?: string;
    digestTimezone?: string;
    needsReplyChannel?: string;      // 默认: 'needs-reply'
    needsQrtChannel?: string;        // 默认: 'needs-qrt'
    escalationChannel?: string;      // 默认: 'escalation'
    engagementChannel?: string;      // 默认: 'engagement'
    trendingChannel?: string;        // 默认: 'trending'
    ownActivityChannel?: string;
    competitorIntelChannel?: string;
    noiseChannel?: string;           // 默认: 'noise'
    summaryChannel?: string;         // 默认: 'periodic-summary'
  };
  governance: {
    maxRepliesPerHour: number;
    maxRepliesPerDay: number;
    blacklist: string[];
    riskKeywords: string[];
  };
  /** 语气配置，默认使用内置 4 种语气 */
  tones?: ToneConfig[];
  /** 品牌上下文文档路径，默认: 'prompts/brand_context.md' */
  brandContextPath?: string;
}

// ============================================
// 数据源适配器接口（保持不变）
// ============================================

/**
 * 所有数据源适配器必须实现的接口
 */
export interface DataSourceAdapter {
  name: string;
  fetchTweets(config: CollectorConfig): Promise<RawTweet[]>;
}
