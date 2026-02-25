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
      urgentChannel: (notif.urgent_channel ?? notif.urgentChannel ?? 'urgent-signals') as string,
      digestChannel: (notif.digest_channel ?? notif.digestChannel ?? 'daily-digest') as string,
      allChannel: (notif.all_channel ?? notif.allChannel ?? 'all-signals') as string,
      digestTime: (notif.digest_time ?? notif.digestTime ?? '09:00') as string,
      digestTimezone: (notif.digest_timezone ?? notif.digestTimezone ?? 'Asia/Shanghai') as string,
      discordWebhookUrl: (notif.discord_webhook_url ?? notif.discordWebhookUrl ?? '') as string,
    },
    governance: {
      maxRepliesPerHour: (gov.max_replies_per_hour ?? gov.maxRepliesPerHour ?? 5) as number,
      maxRepliesPerDay: (gov.max_replies_per_day ?? gov.maxRepliesPerDay ?? 20) as number,
      blacklist: (gov.blacklist ?? []) as string[],
      riskKeywords: (gov.risk_keywords ?? gov.riskKeywords ?? []) as string[],
    },
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
