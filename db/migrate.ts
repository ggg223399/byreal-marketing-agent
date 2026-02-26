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
