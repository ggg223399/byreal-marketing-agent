import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

describe('v5 migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Create base schema (pre-v5)
    db.exec(`
      CREATE TABLE signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tweet_id TEXT NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        url TEXT,
        pipeline TEXT NOT NULL,
        pipelines TEXT,
        action_type TEXT NOT NULL,
        angle TEXT,
        tones TEXT,
        connection TEXT,
        account_tier TEXT,
        severity TEXT,
        reason TEXT,
        source_adapter TEXT NOT NULL,
        raw_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        notified_at INTEGER
      );
    `);
    // Insert test data
    db.prepare(`INSERT INTO signals (tweet_id, author, content, pipeline, action_type, source_adapter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('t1', '@test', 'hello', 'network', 'reply', 'xai', 1000);
    db.prepare(`INSERT INTO signals (tweet_id, author, content, pipeline, action_type, source_adapter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('t2', '@foo', 'crisis!', 'crisis', 'monitor', 'xai', 1001);
    db.prepare(`INSERT INTO signals (tweet_id, author, content, pipeline, action_type, source_adapter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('t3', '@bar', 'trend', 'trends', 'like', 'xai', 1002);
  });

  afterEach(() => {
    db.close();
  });

  it('adds v5 columns and backfills source_name', () => {
    // Simulate migration
    db.exec(`
      ALTER TABLE signals ADD COLUMN source_name TEXT;
      ALTER TABLE signals ADD COLUMN alert_level TEXT;
      ALTER TABLE signals ADD COLUMN suggested_action TEXT;
      ALTER TABLE signals ADD COLUMN tone TEXT;
      ALTER TABLE signals ADD COLUMN reply_angle TEXT;
      ALTER TABLE signals ADD COLUMN judge_reasoning TEXT;
      UPDATE signals SET source_name = CASE pipeline
        WHEN 'mentions' THEN 'mentions'
        WHEN 'network' THEN 'ecosystem'
        WHEN 'trends' THEN 'narratives'
        WHEN 'crisis' THEN 'crisis'
        ELSE pipeline
      END WHERE source_name IS NULL;
    `);

    const rows = db.prepare('SELECT tweet_id, pipeline, source_name, alert_level FROM signals ORDER BY created_at').all() as any[];

    expect(rows[0].source_name).toBe('ecosystem');   // network -> ecosystem
    expect(rows[1].source_name).toBe('crisis');       // crisis -> crisis
    expect(rows[2].source_name).toBe('narratives');   // trends -> narratives

    // New columns should be null for existing data
    expect(rows[0].alert_level).toBeNull();
    expect(rows[0].tweet_id).toBe('t1');
  });

  it('new v5 columns can store values', () => {
    db.exec(`
      ALTER TABLE signals ADD COLUMN source_name TEXT;
      ALTER TABLE signals ADD COLUMN alert_level TEXT;
      ALTER TABLE signals ADD COLUMN suggested_action TEXT;
      ALTER TABLE signals ADD COLUMN tone TEXT;
      ALTER TABLE signals ADD COLUMN reply_angle TEXT;
      ALTER TABLE signals ADD COLUMN judge_reasoning TEXT;
    `);

    db.prepare(`INSERT INTO signals (tweet_id, author, content, pipeline, action_type, source_adapter, source_name, alert_level, suggested_action, tone, reply_angle, judge_reasoning, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('t4', '@new', 'v5 signal', 'mentions', 'reply', 'xai', 'mentions', 'orange', 'reply_supportive', 'casual', 'Be friendly about CLMM', 'Positive KOL mention', 2000);

    const row = db.prepare('SELECT * FROM signals WHERE tweet_id = ?').get('t4') as any;
    expect(row.source_name).toBe('mentions');
    expect(row.alert_level).toBe('orange');
    expect(row.suggested_action).toBe('reply_supportive');
    expect(row.tone).toBe('casual');
    expect(row.reply_angle).toBe('Be friendly about CLMM');
    expect(row.judge_reasoning).toBe('Positive KOL mention');
  });
});
