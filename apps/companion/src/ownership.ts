import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { CompanionPaths } from './paths.js';

interface OwnerRecord { pid: number; token: string }
export type Liveness = 'alive' | 'dead' | 'ambiguous';
export type ProbeLiveness = (pid: number) => Liveness;

export function probeProcess(pid: number): Liveness {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'ambiguous';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'ambiguous';
  }
}

function readOwner(database: DatabaseSync): OwnerRecord | undefined {
  const row = database.prepare('SELECT pid, token FROM companion_owner WHERE slot = 1').get() as
    OwnerRecord | undefined;
  if (row && (!Number.isSafeInteger(row.pid) || row.pid <= 0 ||
      typeof row.token !== 'string' || !row.token)) {
    throw new Error('Invalid Companion owner record; refusing to take ownership');
  }
  return row;
}

/**
 * The ownership artifact is a separate, disk-backed SQLite lock file. Its
 * process-held write transaction serializes all claim/reclaim/release steps.
 * SQLite releases that lock on a process crash, including a crash mid-reclaim.
 * The canonical WAL database is opened only after this transaction is held.
 */
export class CompanionOwnership {
  private released = false;

  private constructor(
    private readonly path: string,
    private readonly database: DatabaseSync,
    readonly token: string,
  ) {}

  static async acquire(paths: CompanionPaths, probe: ProbeLiveness = probeProcess): Promise<CompanionOwnership> {
    const database = new DatabaseSync(paths.ownership);
    const token = randomUUID();
    let transaction = false;
    let claimed = false;
    try {
      // A bounded wait lets an in-flight claimant finish its short transaction.
      // Expiry is never evidence that the recorded process is dead.
      database.exec('PRAGMA busy_timeout = 1000');
      database.exec(`CREATE TABLE IF NOT EXISTS companion_owner (
        slot INTEGER PRIMARY KEY CHECK (slot = 1),
        pid INTEGER NOT NULL,
        token TEXT NOT NULL
      )`);
      database.exec('BEGIN IMMEDIATE');
      transaction = true;
      const existing = readOwner(database);
      if (existing && probe(existing.pid) !== 'dead') {
        throw new Error(`Companion data is owned or owner liveness is uncertain (PID ${existing.pid})`);
      }
      database.prepare(`INSERT INTO companion_owner(slot, pid, token) VALUES (1, ?, ?)
        ON CONFLICT(slot) DO UPDATE SET pid = excluded.pid, token = excluded.token`)
        .run(process.pid, token);
      database.exec('COMMIT');
      transaction = false;
      claimed = true;

      // Between publication and the held write lock, our live PID blocks
      // replacement. The lock then prevents another writer until release.
      database.exec('BEGIN IMMEDIATE');
      transaction = true;
      if (readOwner(database)?.token !== token) {
        throw new Error('Companion owner changed while acquiring its process lock');
      }
      return new CompanionOwnership(paths.ownership, database, token);
    } catch (error) {
      try {
        if (transaction) database.exec('ROLLBACK');
        if (claimed) {
          // Remove only this claim. After a crash, its dead PID is reclaimable.
          database.exec('BEGIN IMMEDIATE');
          try {
            database.prepare('DELETE FROM companion_owner WHERE slot = 1 AND token = ?').run(token);
            database.exec('COMMIT');
          } catch (cleanupError) {
            database.exec('ROLLBACK');
            throw cleanupError;
          }
        }
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Companion ownership claim cleanup failed');
      } finally {
        database.close();
      }
      const code = (error as { code?: string }).code;
      if (code === 'ERR_SQLITE_ERROR' && /database is locked/i.test(String(error))) {
        throw new Error('Companion data is already owned or locked', { cause: error });
      }
      throw error;
    }
  }

  async release(token = this.token): Promise<void> {
    if (this.released) return;
    if (token !== this.token || readOwner(this.database)?.token !== token) {
      throw new Error('Companion owner token mismatch; refusing to release');
    }
    this.database.prepare('DELETE FROM companion_owner WHERE slot = 1 AND token = ?').run(token);
    this.database.exec('COMMIT');
    this.database.close();
    this.released = true;
  }

  async assertHeld(path: string): Promise<void> {
    if (this.released || path !== this.path || readOwner(this.database)?.token !== this.token) {
      throw new Error('Companion database requires current ownership');
    }
  }
}
