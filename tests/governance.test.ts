import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyGovernanceFilters, filterByBlacklist, flagRiskKeywords } from '../governance/filters.js';
import type { CollectorConfig, RawTweet } from '../types/index.js';

const config: CollectorConfig = {
  dataSource: { type: 'mock', apiKey: '' },
  monitoring: { accountsTier1: [], accountsPartners: [], keywords: [], pollingIntervalMinutes: 30 },
  classification: { model: 'claude-haiku-4-5', temperature: 0 },
  notifications: {},
  governance: {
    maxRepliesPerHour: 5,
    maxRepliesPerDay: 20,
    blacklist: ['@spam_account'],
    riskKeywords: ['hack', 'lawsuit'],
  },
};

const baseTweet: RawTweet = {
  id: 't1',
  author: '@normal',
  content: 'hello world',
  url: 'u',
  created_at: 0,
};

afterEach(() => {
  vi.resetModules();
});

describe('filterByBlacklist', () => {
  it('blocks blacklisted author', () => {
    const result = filterByBlacklist({ ...baseTweet, author: '@spam_account' }, config);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blacklisted');
  });

  it('is case-insensitive for blacklist', () => {
    const result = filterByBlacklist({ ...baseTweet, author: '@SPAM_ACCOUNT' }, config);
    expect(result.allowed).toBe(false);
  });

  it('allows non-blacklisted author', () => {
    const result = filterByBlacklist(baseTweet, config);
    expect(result.allowed).toBe(true);
  });
});

describe('flagRiskKeywords', () => {
  it('flags matching keyword', () => {
    const result = flagRiskKeywords({ ...baseTweet, content: 'possible hack detected' }, config);
    expect(result.flagged).toBe(true);
    expect(result.flagReason).toContain('hack');
  });

  it('is case-insensitive for risk keywords', () => {
    const result = flagRiskKeywords({ ...baseTweet, content: 'Potential LaWsUiT here' }, config);
    expect(result.flagged).toBe(true);
  });

  it('does not flag normal content', () => {
    const result = flagRiskKeywords({ ...baseTweet, content: 'all good' }, config);
    expect(result.flagged).toBe(false);
  });
});

describe('applyGovernanceFilters', () => {
  it('blocks blacklisted tweets from filtered list', () => {
    const tweets = [
      { ...baseTweet, id: 'a', author: '@spam_account' },
      { ...baseTweet, id: 'b', author: '@ok' },
    ];
    const out = applyGovernanceFilters(tweets, config);
    expect(out.blocked).toBe(1);
    expect(out.filtered.map((t) => t.id)).toEqual(['b']);
  });

  it('includes risk tweets in flagged output', () => {
    const tweets = [
      { ...baseTweet, id: 'a', content: 'hack happened' },
      { ...baseTweet, id: 'b', content: 'all fine' },
    ];
    const out = applyGovernanceFilters(tweets, config);
    expect(out.flagged.map((t) => t.id)).toEqual(['a']);
  });

  it('keeps flagged tweets in filtered output', () => {
    const tweets = [{ ...baseTweet, id: 'a', content: 'hack happened' }];
    const out = applyGovernanceFilters(tweets, config);
    expect(out.filtered).toHaveLength(1);
    expect(out.flagged).toHaveLength(1);
  });

  it('handles empty input', () => {
    const out = applyGovernanceFilters([], config);
    expect(out.filtered).toEqual([]);
    expect(out.flagged).toEqual([]);
    expect(out.blocked).toBe(0);
  });
});

describe('isAlreadyApproved', () => {
  it('returns true when approval exists', async () => {
    vi.doMock('../db/index.js', () => ({
      getDb: () => ({
        prepare: () => ({
          get: () => ({ id: 1 }),
        }),
      }),
    }));
    const mod = await import('../governance/filters.js');
    expect(mod.isAlreadyApproved(1)).toBe(true);
  });

  it('returns false when approval missing', async () => {
    vi.doMock('../db/index.js', () => ({
      getDb: () => ({
        prepare: () => ({
          get: () => undefined,
        }),
      }),
    }));
    const mod = await import('../governance/filters.js');
    expect(mod.isAlreadyApproved(1)).toBe(false);
  });
});
