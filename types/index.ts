export type SignalClass = 'reply_needed' | 'watch_only' | 'ignore';

export type AlertLevel = 'red' | 'orange' | 'yellow' | 'none';

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
  signalClass: SignalClass;
  confidence: number;
  alertLevel: AlertLevel;
  sourceAdapter: string;
  rawJson?: string;
  createdAt: number;
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

export type DraftTone = 'professional' | 'friendly';

export interface DraftVariant {
  tone: DraftTone;
  text: string;
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
    urgentChannel?: string;
    digestChannel?: string;
    allChannel?: string;
    digestTime?: string;
    digestTimezone?: string;
    discordWebhookUrl?: string;
    urgentWebhookUrl?: string;
    digestWebhookUrl?: string;
  };
  governance: {
    maxRepliesPerHour: number;
    maxRepliesPerDay: number;
    blacklist: string[];
    riskKeywords: string[];
  };
}

export interface DataSourceAdapter {
  name: string;
  fetchTweets(config: CollectorConfig): Promise<RawTweet[]>;
}
