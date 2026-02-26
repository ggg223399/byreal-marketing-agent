import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { CollectorConfig } from '../types/index.js';

function resolveConfigPath(explicitPath?: string): string {
  if (explicitPath) {
    return explicitPath;
  }

  const primary = path.resolve(process.cwd(), 'config.yaml');
  if (existsSync(primary)) {
    return primary;
  }

  const fallback = path.resolve(process.cwd(), 'config.yaml.example');
  if (existsSync(fallback)) {
    return fallback;
  }

  throw new Error('Missing config.yaml and config.yaml.example');
}

const DEFAULT_TONES = [
  { id: 'helpful_expert', label: 'Helpful Expert', emoji: '🧑‍💼', description: '专业权威，提供具体价值' },
  { id: 'friendly_peer', label: 'Friendly Peer', emoji: '👋', description: '轻松对等，亲切友好' },
  { id: 'humble_ack', label: 'Humble Ack', emoji: '🙏', description: '感恩致谢，不强推' },
  { id: 'direct_rebuttal', label: 'Direct Rebuttal', emoji: '💬', description: '正面回应关切，建设性反驳' },
];

function normalizeTones(rawTones: Array<Record<string, unknown>> | undefined): Array<{ id: string; label: string; emoji: string; description: string }> {
  const tones = rawTones ?? DEFAULT_TONES;
  
  if (tones.length > 5) {
    throw new Error('Config validation failed: tones array cannot have more than 5 items');
  }
  
  for (const tone of tones) {
    const id = (tone.id as string) || '';
    if (id.length > 20) {
      throw new Error(`Config validation failed: tone id "${id}" exceeds 20 characters`);
    }
  }
  
  return tones.map((t) => ({
    id: (t.id as string) || '',
    label: (t.label as string) || '',
    emoji: (t.emoji as string) || '',
    description: (t.description as string) || '',
  }));
}


function normalizeConfig(raw: Record<string, unknown>): CollectorConfig {
  const ds = (raw.data_source ?? raw.dataSource ?? {}) as Record<string, unknown>;
  const mon = (raw.monitoring ?? {}) as Record<string, unknown>;
  const cls = (raw.classification ?? {}) as Record<string, unknown>;
  const notif = (raw.notifications ?? {}) as Record<string, unknown>;
  const gov = (raw.governance ?? {}) as Record<string, unknown>;

  return {
    dataSource: {
      type: (ds.type as string) || 'mock',
      apiKey: (ds.api_key as string) ?? (ds.apiKey as string) ?? '',
      maxTweetsPerQuery: (ds.max_tweets_per_query ?? ds.maxTweetsPerQuery ?? 5) as number,
    },
    monitoring: {
      accountsTier1: (mon.accounts_tier1 ?? mon.accountsTier1 ?? []) as string[],
      accountsPartners: (mon.accounts_partners ?? mon.accountsPartners ?? []) as string[],
      keywords: (mon.keywords ?? []) as string[],
      pollingIntervalMinutes: (mon.polling_interval_minutes ?? mon.pollingIntervalMinutes ?? 30) as number,
    },
    classification: {
      model: (cls.model as string) || 'claude-3-5-haiku-20241022',
      temperature: (cls.temperature as number) ?? 0,
    },
    notifications: {
      riskChannel: (notif.risk_channel ?? notif.riskChannel ?? 'risk-alerts') as string,
      opportunitiesChannel: (notif.opportunities_channel ?? notif.opportunitiesChannel ?? 'opportunities') as string,
      ecosystemChannel: (notif.ecosystem_channel ?? notif.ecosystemChannel ?? 'ecosystem-feed') as string,
      digestWebhookUrl: (notif.digest_webhook_url ?? notif.digestWebhookUrl ?? '') as string,
      digestTime: (notif.digest_time ?? notif.digestTime ?? '09:00') as string,
      digestTimezone: (notif.digest_timezone ?? notif.digestTimezone ?? 'Asia/Shanghai') as string,
      needsReplyChannel: (notif.needs_reply_channel ?? notif.needsReplyChannel ?? 'needs-reply') as string,
      needsInteractionChannel: (notif.needs_interaction_channel ?? notif.needsInteractionChannel ?? 'needs-interaction') as string,
      tier1Channel: (notif.tier1_channel ?? notif.tier1Channel ?? 'tier1-signals') as string,
      tier2Channel: (notif.tier2_channel ?? notif.tier2Channel ?? 'tier2-signals') as string,
      tier3Channel: (notif.tier3_channel ?? notif.tier3Channel ?? 'tier3-signals') as string,
      noiseChannel: (notif.noise_channel ?? notif.noiseChannel ?? 'noise') as string,
      summaryChannel: (notif.summary_channel ?? notif.summaryChannel ?? 'periodic-summary') as string,
    },
    governance: {
      maxRepliesPerHour: (gov.max_replies_per_hour ?? gov.maxRepliesPerHour ?? 5) as number,
      maxRepliesPerDay: (gov.max_replies_per_day ?? gov.maxRepliesPerDay ?? 20) as number,
      blacklist: (gov.blacklist ?? []) as string[],
      riskKeywords: (gov.risk_keywords ?? gov.riskKeywords ?? []) as string[],
    },
    tones: normalizeTones(raw.tones as Array<Record<string, unknown>> | undefined),
    brandContextPath: (raw.brand_context_path ?? raw.brandContextPath ?? 'prompts/brand_context.md') as string,
  };
}



export function loadConfig(explicitPath?: string): CollectorConfig {
  const configPath = resolveConfigPath(explicitPath);
  const text = readFileSync(configPath, 'utf-8');
  const parsed = parse(text) as Record<string, unknown>;
  const config = normalizeConfig(parsed);

  const envApiKey = process.env.DATA_SOURCE_API_KEY;
  if (envApiKey) {
    config.dataSource.apiKey = envApiKey;
  }

  return config;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  console.log('Config loaded successfully:');
  console.log(JSON.stringify(config, null, 2));
}
