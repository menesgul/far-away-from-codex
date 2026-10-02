import { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  up: (database: DatabaseSync) => void;
}

export function runMigrations(database: DatabaseSync, migrations: readonly Migration[]): void {
  let previous = 0;
  const names = new Set<string>();
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previous ||
        !/^[a-z][a-z0-9_]*$/.test(migration.name) || names.has(migration.name) ||
        typeof migration.up !== 'function') {
      throw new Error(`Invalid, duplicate, or unordered Companion migration: ${migration.version} ${migration.name}`);
    }
    previous = migration.version;
    names.add(migration.name);
  }

  database.exec(`CREATE TABLE IF NOT EXISTS companion_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  )`);
  const applied = database.prepare('SELECT version, name FROM companion_migrations ORDER BY version').all() as
    Array<{ version: number; name: string }>;
  for (const [index, row] of applied.entries()) {
    const definition = migrations[index];
    if (!definition || definition.version !== row.version || definition.name !== row.name) {
      throw new Error(`Companion migration history is not a prefix at ${row.version} ${row.name}`);
    }
  }
  for (const migration of migrations.slice(applied.length)) {
    database.exec('BEGIN IMMEDIATE');
    try {
      migration.up(database);
      database.prepare('INSERT INTO companion_migrations(version, name) VALUES (?, ?)')
        .run(migration.version, migration.name);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw new Error(`Companion migration ${migration.version} ${migration.name} failed`, { cause: error });
    }
  }
}
