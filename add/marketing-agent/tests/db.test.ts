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
  getSignalsByPipeline,
  incrementRateLimit,
  insertSignal,
  logAudit,
  recordApproval,
  setConfigOverride,
} from '../db/index.js';
import type { ActionType, ConnectionStrength, CrisisSeverity, Pipeline, ToneItem } from '../types/index.js';

function mkSignal(tweetId: string, pipeline: Pipeline = 'mentions', actionType: ActionType = 'reply') {
  const tones: ToneItem[] = [
    { id: 'friendly_peer', label: 'Friendly Peer', description: '轻松对等，亲切友好' }
  ];

  return {
    tweetId,
    author: '@a',
    content: `content ${tweetId}`,
    url: `https://x.com/${tweetId}`,
    pipeline,
    actionType,
    angle: 'Test angle',
    tones,
    reason: 'Test reason',
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

  it('insertSignal persists a row with pipeline schema', () => {
    const out = insertSignal(mkSignal('t1'));
    expect(out.id).toBeGreaterThan(0);
    expect(out.tweetId).toBe('t1');
    expect(out.pipeline).toBe('mentions');
    expect(out.actionType).toBe('reply');
    expect(out.angle).toBe('Test angle');
    expect(out.tones).toHaveLength(1);
    expect(out.reason).toBe('Test reason');
  });

  it('getSignalById returns null when not found', () => {
    expect(getSignalById(999)).toBeNull();
  });

  it('getSignalById returns inserted row with new fields', () => {
    const out = insertSignal(mkSignal('t2', 'crisis', 'statement'));
    const fetched = getSignalById(out.id);
    expect(fetched?.tweetId).toBe('t2');
    expect(fetched?.pipeline).toBe('crisis');
    expect(fetched?.actionType).toBe('statement');
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

  it('stores and retrieves network pipeline with accountTier', () => {
    const out = insertSignal({
      ...mkSignal('net1', 'network', 'reply'),
      accountTier: 'S',
    });
    const fetched = getSignalById(out.id);
    expect(fetched?.pipeline).toBe('network');
    expect(fetched?.accountTier).toBe('S');
  });

  it('stores and retrieves trends pipeline with connection', () => {
    const out = insertSignal({
      ...mkSignal('trend1', 'trends', 'qrt'),
      connection: 'direct' as ConnectionStrength,
    });
    const fetched = getSignalById(out.id);
    expect(fetched?.pipeline).toBe('trends');
    expect(fetched?.connection).toBe('direct');
  });

  it('stores and retrieves crisis pipeline with severity', () => {
    const out = insertSignal({
      ...mkSignal('crisis1', 'crisis', 'statement'),
      severity: 'high' as CrisisSeverity,
    });
    const fetched = getSignalById(out.id);
    expect(fetched?.pipeline).toBe('crisis');
    expect(fetched?.severity).toBe('high');
  });

  it('stores tones as JSON and parses them back', () => {
    const tones: ToneItem[] = [
      { id: 'helpful_expert', label: 'Helpful Expert', description: '专业权威' },
      { id: 'friendly_peer', label: 'Friendly Peer', description: '轻松对等' },
    ];
    const out = insertSignal({
      ...mkSignal('tones1'),
      tones,
    });
    const fetched = getSignalById(out.id);
    expect(fetched?.tones).toHaveLength(2);
    expect(fetched?.tones[0].id).toBe('helpful_expert');
    expect(fetched?.tones[1].label).toBe('Friendly Peer');
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

  it('getSignalsByPipeline returns signals filtered by pipeline', () => {
    insertSignal(mkSignal('sig1', 'mentions'));
    insertSignal(mkSignal('sig2', 'crisis'));
    insertSignal(mkSignal('sig3', 'mentions'));
    insertSignal(mkSignal('sig4', 'network'));

    const mentionsSignals = getSignalsByPipeline('mentions', 10);
    expect(mentionsSignals).toHaveLength(2);
    expect(mentionsSignals.every(s => s.pipeline === 'mentions')).toBe(true);

    const crisisSignals = getSignalsByPipeline('crisis', 10);
    expect(crisisSignals).toHaveLength(1);
    expect(crisisSignals[0].pipeline).toBe('crisis');
  });

  it('getSignalsByPipeline honors limit', () => {
    insertSignal(mkSignal('pl1', 'mentions'));
    insertSignal(mkSignal('pl2', 'mentions'));
    insertSignal(mkSignal('pl3', 'mentions'));

    const limited = getSignalsByPipeline('mentions', 2);
    expect(limited).toHaveLength(2);
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

  it('pending signals return new pipeline fields', () => {
    insertSignal(mkSignal('map1', 'crisis', 'statement'));
    const pending = getPendingSignals(1)[0];
    expect(pending.pipeline).toBe('crisis');
    expect(pending.actionType).toBe('statement');
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
