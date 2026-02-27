import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const DEFAULT_DB_PATH = process.env.DB_PATH || 'data/signals.db';

function ensureDbParent(dbPath: string): void {
  if (dbPath === ':memory:') {
    return;
  }

  const parent = path.dirname(dbPath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function getSignalsTableSql(db: Database.Database): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='signals'")
    .get() as { sql?: string } | undefined;
  return row?.sql ?? '';
}

function recreateSignalsTableForCategoryRange(db: Database.Database): void {
  db.exec('BEGIN TRANSACTION');
  try {
    db.exec(`
      CREATE TABLE signals_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tweet_id TEXT NOT NULL UNIQUE,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        url TEXT,
        category INTEGER NOT NULL CHECK (category BETWEEN 0 AND 8),
        confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
        relevance INTEGER NOT NULL DEFAULT 50,
        sentiment TEXT,
        priority INTEGER,
        risk_level TEXT,
        suggested_action TEXT,
        alert_level TEXT NOT NULL CHECK (alert_level IN ('red', 'orange', 'yellow', 'none')),
        source_adapter TEXT NOT NULL,
        raw_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        notified_at INTEGER
      );
    `);

    const hasRelevance = hasColumn(db, 'signals', 'relevance');
    if (hasRelevance) {
      db.exec(`
        INSERT INTO signals_new (id, tweet_id, author, content, url, category, confidence, relevance, sentiment, priority, risk_level, suggested_action, alert_level, source_adapter, raw_json, created_at, notified_at)
        SELECT id, tweet_id, author, content, url, category, confidence, relevance, sentiment, priority, risk_level, suggested_action, alert_level, source_adapter, raw_json, created_at, notified_at
        FROM signals;
      `);
    } else {
      db.exec(`
        INSERT INTO signals_new (id, tweet_id, author, content, url, category, confidence, relevance, sentiment, priority, risk_level, suggested_action, alert_level, source_adapter, raw_json, created_at, notified_at)
        SELECT id, tweet_id, author, content, url, category, confidence, 50, sentiment, priority, risk_level, suggested_action, alert_level, source_adapter, raw_json, created_at, notified_at
        FROM signals;
      `);
    }

    db.exec('DROP TABLE signals');
    db.exec('ALTER TABLE signals_new RENAME TO signals');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_alert_level ON signals(alert_level)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_category ON signals(category)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_priority ON signals(priority)');

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateSignalsTable(db: Database.Database): void {
  const hasSignals = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='signals'")
    .get() as { name: string } | undefined;

  if (!hasSignals) {
    return;
  }

  const sql = getSignalsTableSql(db);
  const hasLegacyCategoryCheck = /category\s+between\s+1\s+and\s+8/i.test(sql);

  if (hasLegacyCategoryCheck) {
    console.log('Migrating signals table: expanding category range to 0-8 and ensuring relevance column');
    recreateSignalsTableForCategoryRange(db);
    return;
  }

  if (!hasColumn(db, 'signals', 'relevance')) {
    console.log('Migrating signals table: adding relevance column');
    db.exec('ALTER TABLE signals ADD COLUMN relevance INTEGER NOT NULL DEFAULT 50');
  }
}

export function runMigration(dbPath = DEFAULT_DB_PATH): void {
  const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf-8');

  console.log('Starting database migration...');
  console.log(`Database path: ${dbPath}`);
  console.log(`Loaded schema from: ${schemaPath}`);

  ensureDbParent(dbPath);
  const db = new Database(dbPath);

  try {
    console.log('Connected to database');
    db.exec(schemaSql);
    migrateSignalsTable(db);
    console.log('Schema executed successfully');

    const journalMode = db.prepare('PRAGMA journal_mode = WAL').pluck().get() as string;
    console.log(`Journal mode: ${journalMode}`);

    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    console.log(`Created ${tableRows.length} tables:`);
    for (const row of tableRows) {
      console.log(`  - ${row.name}`);
    }

    const indexRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    console.log(`Created ${indexRows.length} indexes:`);
    for (const row of indexRows) {
      console.log(`  - ${row.name}`);
    }

    console.log('\nMigration completed successfully!');
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigration();
}
