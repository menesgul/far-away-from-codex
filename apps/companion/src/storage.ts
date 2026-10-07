import { DatabaseSync } from 'node:sqlite';
import { CompanionOwnership, type ProbeLiveness } from './ownership.js';
import { createDataRoot, resolveCompanionPaths, type CompanionPaths, type PathEnvironment } from './paths.js';
import { runMigrations, type Migration } from './migrations.js';

export interface StorageOptions {
  paths?: PathEnvironment;
  probeLiveness?: ProbeLiveness;
  migrations?: readonly Migration[];
  onResourceEvent?: (event: 'ownership-acquired' | 'database-opened' | 'database-closed' | 'ownership-released') => void;
}

/** Owns the one canonical database connection for this Companion lifecycle. */
export class CompanionStorage {
  private ownership?: CompanionOwnership;
  private database?: DatabaseSync;
  private resolvedPaths?: CompanionPaths;
  private stopped = false;

  private constructor(private readonly options: StorageOptions) {}

  static async start(options: StorageOptions = {}): Promise<CompanionStorage> {
    const storage = new CompanionStorage(options);
    try {
      const paths = resolveCompanionPaths(options.paths);
      storage.resolvedPaths = paths;
      await createDataRoot(paths, options.paths?.platform);
      storage.ownership = await CompanionOwnership.acquire(paths, options.probeLiveness);
      options.onResourceEvent?.('ownership-acquired');
      await storage.ownership.assertHeld(paths.ownership);
      storage.database = new DatabaseSync(paths.database);
      options.onResourceEvent?.('database-opened');
      storage.database.exec('PRAGMA busy_timeout = 5000');
      storage.database.exec('PRAGMA journal_mode = WAL');
      storage.database.exec('PRAGMA foreign_keys = ON');
      const mode = storage.database.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      const foreignKeys = storage.database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      if (mode.journal_mode.toLowerCase() !== 'wal' || foreignKeys.foreign_keys !== 1) {
        throw new Error('Companion SQLite WAL or foreign key configuration failed');
      }
      runMigrations(storage.database, options.migrations ?? []);
      return storage;
    } catch (error) {
      try {
        await storage.stop();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Companion storage startup and cleanup failed');
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    if (this.database) {
      this.database.close();
      this.database = undefined;
      this.options.onResourceEvent?.('database-closed');
    }
    if (this.ownership) {
      await this.ownership.release();
      this.ownership = undefined;
      this.options.onResourceEvent?.('ownership-released');
    }
    this.stopped = true;
  }

  async assertOwnershipHeld(): Promise<void> {
    if (!this.database || !this.ownership || !this.resolvedPaths || this.stopped) {
      throw new Error('Companion storage is not bootstrapped and owned');
    }
    await this.ownership.assertHeld(this.resolvedPaths.ownership);
  }
}
