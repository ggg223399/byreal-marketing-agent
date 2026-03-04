// ============================================
// Core Pipeline Types (New Architecture)
// ============================================

export type Pipeline = 'mentions' | 'network' | 'trends' | 'crisis';
export type ActionType = 'reply' | 'qrt' | 'like' | 'monitor' | 'skip' | 'statement';
export type AccountTier = 'O' | 'S' | 'A' | 'B' | 'C';
export type CrisisSeverity = 'critical' | 'high' | 'medium';
export type ConnectionStrength = 'direct' | 'indirect' | 'stretch';

export const PIPELINE_PRIORITY: Record<Pipeline, number> = {
  mentions: 1,
  crisis: 2,
  network: 3,
  trends: 4,
};

// ============================================
// Tone Item (used in PipelineSignal.tones and LLM output)
// ============================================

export interface ToneItem {
  id: string;
  label: string;
  description: string;
}

// ============================================
// Signal Types (Pipeline-based, replaces old Signal)
// ============================================

export interface PipelineSignal {
  id: number;
  tweetId: string;
  author: string;
  content: string;
  url?: string;
  pipeline: Pipeline;
  pipelines: string[];  // Array of pipelines this signal belongs to (for dedup granularity)
  actionType: ActionType;
  angle: string;  // LLM-provided participation angle
  tones: ToneItem[];  // 1-3 tone recommendations
  connection?: ConnectionStrength;  // only for trends pipeline
  accountTier?: AccountTier;  // only for network pipeline
  severity?: CrisisSeverity;  // only for crisis pipeline
  reason: string;
  sourceAdapter: string;
  rawJson?: string;
  createdAt: number;
  notifiedAt?: number;
}

// LLM output type per pipeline (what the classifier returns)
export interface PipelineClassificationResult {
  tweetId: string;
  actionType: ActionType;
  angle: string;
  tones: ToneItem[];
  connection?: ConnectionStrength;  // trends
  accountTier?: AccountTier;  // network
  severity?: CrisisSeverity;  // crisis
  reason: string;
}

// ============================================
// Raw Data Types
// ============================================

export interface RawTweet {
  id: string;
  author: string;
  content: string;
  url: string;
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
// Approval & Audit Types
// ============================================

export type ApprovalAction = 'approve' | 'reject' | 'edit';

export interface Approval {
  id: number;
  signalId: number;
  action: ApprovalAction;
  draftText?: string;
  finalText?: string;
  approvedBy?: string;
  createdAt: number;
}

export interface AuditLog {
  id: number;
  actionType: string;
  detailsJson?: string;
  createdAt: number;
}

// ============================================
// Draft & Tone Types
// ============================================

export type DraftTone = string;

export interface DraftVariant {
  tone: DraftTone;
  text: string;
}

export interface ToneConfig {
  id: string;
  label: string;
  emoji: string;
  description: string;
}

export interface DraftReply {
  signalId: number;
  variants: DraftVariant[];
  generatedAt: number;
}

// ============================================
// Config Types for YAML files
// ============================================

export interface AccountConfig {
  handle: string;
  tier: AccountTier;
  eventKeywords?: string[];
  notes?: string;
}

export interface NarrativeConfig {
  tag: string;
  keywords: string[];
  description: string;
  active: boolean;
}

// ============================================
// Collector Config (Updated for Pipeline Architecture)
// ============================================

export interface CollectorConfig {
  dataSource: {
    type: string;
    apiKey?: string;
    maxTweetsPerQuery?: number;
  };
  /**
   * @deprecated Use pipelines section instead
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
    needsReplyChannel?: string;      // default: 'needs-reply'
    needsInteractionChannel?: string; // default: 'needs-interaction'
    tier1Channel?: string;           // default: 'tier1-signals'
    tier2Channel?: string;           // default: 'tier2-signals'
    tier3Channel?: string;           // default: 'tier3-signals'
    ownActivityChannel?: string;
    competitorIntelChannel?: string;
    noiseChannel?: string;           // default: 'noise'
    summaryChannel?: string;         // default: 'periodic-summary'
  };
  governance: {
    maxRepliesPerHour: number;
    maxRepliesPerDay: number;
    blacklist: string[];
    riskKeywords: string[];
  };
  tones?: ToneConfig[];  // default: original 4 tones
  brandContextPath?: string;  // default: 'prompts/brand_context.md'
}

// ============================================
// Data Source Adapter (UNCHANGED)
// ============================================

export interface DataSourceAdapter {
  name: string;
  fetchTweets(config: CollectorConfig): Promise<RawTweet[]>;
}
