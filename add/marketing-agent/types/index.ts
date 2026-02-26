export const SIGNAL_CATEGORIES = {
  1: 'solana_growth_milestone',
  2: 'institutional_adoption',
  3: 'rwa_signal',
  4: 'liquidity_signal',
  5: 'market_structure_insight',
  6: 'byreal_ranking_mention',
  7: 'partner_momentum',
  8: 'risk_event',
} as const;

export type SignalCategory = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type SignalClass = typeof SIGNAL_CATEGORIES[SignalCategory];

export const CATEGORY_BY_NAME: Record<SignalClass, SignalCategory> = {
  solana_growth_milestone: 1,
  institutional_adoption: 2,
  rwa_signal: 3,
  liquidity_signal: 4,
  market_structure_insight: 5,
  byreal_ranking_mention: 6,
  partner_momentum: 7,
  risk_event: 8,
};

export function categoryName(category: SignalCategory): SignalClass {
  return SIGNAL_CATEGORIES[category];
}

export type AlertLevel = 'red' | 'orange' | 'yellow' | 'none';
export type Sentiment = 'positive' | 'neutral' | 'negative';
export type SuggestedAction = 'qrt_positioning' | 'reply_supportive' | 'like_only' | 'monitor' | 'escalate_internal';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface RawTweet {
  id: string;
  author: string;
  content: string;
  url: string;
  created_at: number;
  metadata?: Record<string, unknown>;
}

export interface Signal {
  id: number;
  tweetId: string;
  author: string;
  content: string;
  url?: string;
  category: SignalCategory;
  confidence: number;
  sentiment: Sentiment;
  priority: number;
  riskLevel: RiskLevel;
  suggestedAction: SuggestedAction;
  alertLevel: AlertLevel;
  sourceAdapter: string;
  rawJson?: string;
  createdAt: number;
  notifiedAt?: number;
}

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

export type DraftTone = string;

export interface DraftVariant {
  tone: DraftTone;
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

export interface CollectorConfig {
  dataSource: {
    type: string;
    apiKey?: string;
    maxTweetsPerQuery?: number;
  };
  monitoring: {
    accountsTier1: string[];
    accountsPartners: string[];
    keywords: string[];
    pollingIntervalMinutes: number;
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



export interface DataSourceAdapter {
  name: string;
  fetchTweets(config: CollectorConfig): Promise<RawTweet[]>;
}
