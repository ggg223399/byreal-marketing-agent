import { getDb } from '../db/index.js';
import type { CollectorConfig, RawTweet } from '../types/index.js';

export interface FilterResult {
  allowed: boolean;
  reason?: string;
  flagged?: boolean;
  flagReason?: string;
}

export function filterByBlacklist(tweet: RawTweet, config: CollectorConfig): FilterResult {
  const blacklist = new Set(config.governance.blacklist.map((item) => item.toLowerCase()));
  if (blacklist.has(tweet.author.toLowerCase())) {
    return {
      allowed: false,
      reason: `Author ${tweet.author} is blacklisted`,
    };
  }

  return { allowed: true };
}

export function flagRiskKeywords(tweet: RawTweet, config: CollectorConfig): FilterResult {
  const contentLower = tweet.content.toLowerCase();
  for (const keyword of config.governance.riskKeywords) {
    if (contentLower.includes(keyword.toLowerCase())) {
      return {
        allowed: true,
        flagged: true,
        flagReason: `Contains risk keyword: '${keyword}'`,
      };
    }
  }

  return { allowed: true, flagged: false };
}

export function isAlreadyApproved(signalId: number): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT id FROM approvals WHERE signal_id = ? AND action IN ('approve', 'edit') LIMIT 1")
    .get(signalId) as { id: number } | undefined;
  return Boolean(row);
}

export function applyGovernanceFilters(
  tweets: RawTweet[],
  config: CollectorConfig
): { filtered: RawTweet[]; flagged: RawTweet[]; blocked: number } {
  const filtered: RawTweet[] = [];
  const flagged: RawTweet[] = [];
  let blocked = 0;

  for (const tweet of tweets) {
    const blacklistResult = filterByBlacklist(tweet, config);
    if (!blacklistResult.allowed) {
      blocked += 1;
      continue;
    }

    filtered.push(tweet);
    const riskResult = flagRiskKeywords(tweet, config);
    if (riskResult.flagged) {
      flagged.push(tweet);
    }
  }

  return { filtered, flagged, blocked };
}
