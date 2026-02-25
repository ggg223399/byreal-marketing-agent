import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DB_PATH = ':memory:';
});

import {
  closeDb,
  getConfigOverride,
  getDb,
  getPendingSignals,
  getRateLimit,
  getSignalById,
  incrementRateLimit,
  insertSignal,
  logAudit,
  recordApproval,
  setConfigOverride,
} from '../db/index.js';

function mkSignal(tweetId: string, alertLevel: 'red' | 'orange' | 'yellow' | 'none' = 'none') {
  return {
    tweetId,
    author: '@a',
    content: `content ${tweetId}`,
    url: `https://x.com/${tweetId}`,
    signalClass: alertLevel === 'yellow' ? ('watch_only' as const) : ('reply_needed' as const),
    confidence: 0.7,
    alertLevel,
    sourceAdapter: 'mock',
    rawJson: '{}',
  };
}

beforeEach(() => {
  closeDb();
  getDb();
});

describe('db/index', () => {
  it('creates singleton connection per lifecycle', () => {
    const a = getDb();
    const b = getDb();
    expect(a).toBe(b);
  });

  it('insertSignal persists a row', () => {
    const out = insertSignal(mkSignal('t1'));
    expect(out.id).toBeGreaterThan(0);
    expect(out.tweetId).toBe('t1');
  });

  it('getSignalById returns null when not found', () => {
    expect(getSignalById(999)).toBeNull();
  });

  it('getSignalById returns inserted row', () => {
    const out = insertSignal(mkSignal('t2'));
    const fetched = getSignalById(out.id);
    expect(fetched?.tweetId).toBe('t2');
  });

  it('enforces unique tweet_id', () => {
    insertSignal(mkSignal('dup'));
    expect(() => insertSignal(mkSignal('dup'))).toThrow('UNIQUE constraint failed');
  });

  it('stores nullable url/rawJson as undefined on read', () => {
    const out = insertSignal({ ...mkSignal('t3'), url: undefined, rawJson: undefined });
    expect(out.url).toBeUndefined();
    expect(out.rawJson).toBeUndefined();
  });

  it('getPendingSignals returns only unapproved rows', () => {
    const s1 = insertSignal(mkSignal('p1'));
    insertSignal(mkSignal('p2'));
    recordApproval({ signalId: s1.id, action: 'reject', approvedBy: 'u' });
    const pending = getPendingSignals(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].tweetId).toBe('p2');
  });

  it('getPendingSignals honors limit', () => {
    insertSignal(mkSignal('l1'));
    insertSignal(mkSignal('l2'));
    insertSignal(mkSignal('l3'));
    expect(getPendingSignals(2)).toHaveLength(2);
  });

  it('recordApproval stores approve action', () => {
    const s = insertSignal(mkSignal('a1'));
    const approval = recordApproval({ signalId: s.id, action: 'approve', finalText: 'ok', approvedBy: 'me' });
    expect(approval.action).toBe('approve');
    expect(approval.finalText).toBe('ok');
  });

  it('recordApproval stores edit action', () => {
    const s = insertSignal(mkSignal('a2'));
    const approval = recordApproval({ signalId: s.id, action: 'edit', draftText: 'a', finalText: 'b', approvedBy: 'me' });
    expect(approval.action).toBe('edit');
  });

  it('recordApproval stores reject action', () => {
    const s = insertSignal(mkSignal('a3'));
    const approval = recordApproval({ signalId: s.id, action: 'reject', approvedBy: 'me' });
    expect(approval.action).toBe('reject');
  });

  it('logAudit inserts action row', () => {
    logAudit('signal_approved', { signalId: 1 });
    const row = getDb().prepare('SELECT action_type, details_json FROM audit_log').get() as { action_type: string; details_json: string };
    expect(row.action_type).toBe('signal_approved');
    expect(row.details_json).toContain('signalId');
  });

  it('logAudit supports empty details', () => {
    logAudit('noop');
    const row = getDb().prepare('SELECT details_json FROM audit_log').get() as { details_json: string | null };
    expect(row.details_json).toBeNull();
  });

  it('setConfigOverride writes key/value', () => {
    setConfigOverride('k1', 'v1');
    expect(getConfigOverride('k1')).toBe('v1');
  });

  it('setConfigOverride upserts existing key', () => {
    setConfigOverride('k2', 'v1');
    setConfigOverride('k2', 'v2');
    expect(getConfigOverride('k2')).toBe('v2');
  });

  it('getConfigOverride returns undefined for missing key', () => {
    expect(getConfigOverride('missing')).toBeUndefined();
  });

  it('incrementRateLimit inserts first row', () => {
    const count = incrementRateLimit('c1', 100, 200, 1);
    expect(count).toBe(1);
  });

  it('incrementRateLimit updates existing row', () => {
    incrementRateLimit('c2', 100, 200, 1);
    const count = incrementRateLimit('c2', 100, 200, 2);
    expect(count).toBe(3);
  });

  it('getRateLimit returns zero if missing', () => {
    expect(getRateLimit('none', 0)).toBe(0);
  });

  it('getRateLimit returns saved count', () => {
    incrementRateLimit('c3', 1, 2, 5);
    expect(getRateLimit('c3', 1)).toBe(5);
  });

  it('supports multiple windows for same counter', () => {
    incrementRateLimit('c4', 1, 2, 1);
    incrementRateLimit('c4', 3, 4, 2);
    expect(getRateLimit('c4', 1)).toBe(1);
    expect(getRateLimit('c4', 3)).toBe(2);
  });

  it('supports multiple counter types', () => {
    incrementRateLimit('hour', 1, 2, 1);
    incrementRateLimit('day', 1, 2, 10);
    expect(getRateLimit('hour', 1)).toBe(1);
    expect(getRateLimit('day', 1)).toBe(10);
  });

  it('pending signals return mapped field names', () => {
    insertSignal(mkSignal('map1', 'yellow'));
    const pending = getPendingSignals(1)[0];
    expect(pending.signalClass).toBe('watch_only');
    expect(pending.alertLevel).toBe('yellow');
    expect(pending.sourceAdapter).toBe('mock');
  });

  it('closeDb resets singleton', () => {
    const a = getDb();
    closeDb();
    const b = getDb();
    expect(a).not.toBe(b);
  });

  it('schema includes expected core tables', () => {
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['signals', 'approvals', 'audit_log', 'rate_limits', 'config_overrides']));
  });
});
