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

function hasLegacyAccountTierConstraint(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='signals'")
    .get() as { sql: string } | undefined;

  return Boolean(row?.sql?.includes("account_tier IN ('S', 'A', 'B')"));
}

function recreateSignalsTableForPipelines(db: Database.Database): void {
  db.exec('BEGIN TRANSACTION');
  try {
    db.exec(`
      CREATE TABLE signals_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tweet_id TEXT NOT NULL UNIQUE,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        url TEXT,
        pipeline TEXT NOT NULL CHECK (pipeline IN ('mentions', 'network', 'trends', 'crisis')),
        pipelines TEXT,
        action_type TEXT NOT NULL CHECK (action_type IN ('reply', 'qrt', 'like', 'monitor', 'skip', 'statement')),
        angle TEXT,
        tones TEXT,
        connection TEXT CHECK (connection IN ('direct', 'indirect', 'stretch') OR connection IS NULL),
        account_tier TEXT CHECK (account_tier IN ('O', 'S', 'A', 'B', 'C') OR account_tier IS NULL),
        severity TEXT CHECK (severity IN ('critical', 'high', 'medium') OR severity IS NULL),
        reason TEXT,
        source_adapter TEXT NOT NULL,
        raw_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        notified_at INTEGER
      );
    `);

    db.exec('DROP TABLE signals');
    db.exec('ALTER TABLE signals_new RENAME TO signals');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_pipeline ON signals(pipeline)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_action_type ON signals(action_type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_pipeline_created ON signals(pipeline, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at)');

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateSignalsForDedupGranularity(db: Database.Database): void {
  db.exec('BEGIN TRANSACTION');
  try {
    // Create new table without UNIQUE on tweet_id and with pipelines column
    db.exec(`
      CREATE TABLE signals_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tweet_id TEXT NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        url TEXT,
        pipeline TEXT NOT NULL CHECK (pipeline IN ('mentions', 'network', 'trends', 'crisis')),
        pipelines TEXT,
        action_type TEXT NOT NULL CHECK (action_type IN ('reply', 'qrt', 'like', 'monitor', 'skip', 'statement')),
        angle TEXT,
        tones TEXT,
        connection TEXT CHECK (connection IN ('direct', 'indirect', 'stretch') OR connection IS NULL),
        account_tier TEXT CHECK (account_tier IN ('O', 'S', 'A', 'B', 'C') OR account_tier IS NULL),
        severity TEXT CHECK (severity IN ('critical', 'high', 'medium') OR severity IS NULL),
        reason TEXT,
        source_adapter TEXT NOT NULL,
        raw_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        notified_at INTEGER
      );
    `);

    // Copy data from old table, convert pipeline to pipelines array
    db.exec(`
      INSERT INTO signals_new (id, tweet_id, author, content, url, pipeline, pipelines, action_type, angle, tones, connection, account_tier, severity, reason, source_adapter, raw_json, created_at, notified_at)
      SELECT id, tweet_id, author, content, url, pipeline, json_array(pipeline), action_type, angle, tones, connection, account_tier, severity, reason, source_adapter, raw_json, created_at, notified_at
      FROM signals;
    `);

    db.exec('DROP TABLE signals');
    db.exec('ALTER TABLE signals_new RENAME TO signals');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_pipeline ON signals(pipeline)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_action_type ON signals(action_type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_pipeline_created ON signals(pipeline, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_tweet_id ON signals(tweet_id)');

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function ensureUniqueTweetIdIndex(db: Database.Database): void {
  // Check if unique index already exists
  const hasUniqueIndex = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='uq_signals_tweet_id'")
    .get() as { name: string } | undefined;

  if (hasUniqueIndex) return;

  console.log('Adding UNIQUE index on tweet_id (deduplicating first)...');

  db.exec('BEGIN TRANSACTION');
  try {
    // Delete duplicate tweet_ids, keep the row with highest id (most recent)
    db.exec(`
      DELETE FROM signals WHERE id NOT IN (
        SELECT MAX(id) FROM signals GROUP BY tweet_id
      )
    `);

    // Now create the unique index
    db.exec('CREATE UNIQUE INDEX uq_signals_tweet_id ON signals(tweet_id)');

    db.exec('COMMIT');
    console.log('UNIQUE index on tweet_id created successfully');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrateSignalsAccountTierConstraint(db: Database.Database): void {
  db.exec('BEGIN TRANSACTION');
  try {
    db.exec(`
      CREATE TABLE signals_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tweet_id TEXT NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        url TEXT,
        pipeline TEXT NOT NULL CHECK (pipeline IN ('mentions', 'network', 'trends', 'crisis')),
        pipelines TEXT,
        action_type TEXT NOT NULL CHECK (action_type IN ('reply', 'qrt', 'like', 'monitor', 'skip', 'statement')),
        angle TEXT,
        tones TEXT,
        connection TEXT CHECK (connection IN ('direct', 'indirect', 'stretch') OR connection IS NULL),
        account_tier TEXT CHECK (account_tier IN ('O', 'S', 'A', 'B', 'C') OR account_tier IS NULL),
        severity TEXT CHECK (severity IN ('critical', 'high', 'medium') OR severity IS NULL),
        reason TEXT,
        source_adapter TEXT NOT NULL,
        raw_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        notified_at INTEGER
      );
    `);

    db.exec(`
      INSERT INTO signals_new (id, tweet_id, author, content, url, pipeline, pipelines, action_type, angle, tones, connection, account_tier, severity, reason, source_adapter, raw_json, created_at, notified_at)
      SELECT id, tweet_id, author, content, url, pipeline, pipelines, action_type, angle, tones, connection, account_tier, severity, reason, source_adapter, raw_json, created_at, notified_at
      FROM signals;
    `);

    db.exec('DROP TABLE signals');
    db.exec('ALTER TABLE signals_new RENAME TO signals');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_pipeline ON signals(pipeline)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_action_type ON signals(action_type)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_pipeline_created ON signals(pipeline, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_signals_tweet_id ON signals(tweet_id)');

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

  const hasCategory = hasColumn(db, 'signals', 'category');
  const hasPipeline = hasColumn(db, 'signals', 'pipeline');

  if (hasCategory && !hasPipeline) {
    console.log('Migrating signals table: replacing legacy category schema with pipeline schema');
    recreateSignalsTableForPipelines(db);
  }

  // Migration: Remove UNIQUE constraint from tweet_id and add pipelines column
  const hasPipelines = hasColumn(db, 'signals', 'pipelines');
  if (!hasPipelines) {
    console.log('Migrating signals table: removing UNIQUE from tweet_id, adding pipelines column');
    migrateSignalsForDedupGranularity(db);
  }

  if (hasLegacyAccountTierConstraint(db)) {
    console.log('Migrating signals table: expanding account_tier constraint to O/S/A/B/C');
    migrateSignalsAccountTierConstraint(db);
  }

  // Add unique index on tweet_id for ON CONFLICT to work
  ensureUniqueTweetIdIndex(db);
}


export function runMigration(dbPath = DEFAULT_DB_PATH): void {
  const distSchemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');
  const sourceSchemaPath = path.resolve(process.cwd(), 'marketing-agent/db/schema.sql');
  const schemaPath = existsSync(distSchemaPath) ? distSchemaPath : sourceSchemaPath;
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
