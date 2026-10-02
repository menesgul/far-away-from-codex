import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { CompanionOwnership } from '../src/ownership.js';
import { resolveCompanionPaths, createDataRoot } from '../src/paths.js';
import { CompanionStorage } from '../src/storage.js';
import type { Migration } from '../src/migrations.js';

function seedOwner(path: string, pid: number, token: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS companion_owner (
      slot INTEGER PRIMARY KEY CHECK (slot = 1), pid INTEGER NOT NULL, token TEXT NOT NULL
    )`);
    database.prepare(`INSERT INTO companion_owner(slot, pid, token) VALUES (1, ?, ?)
      ON CONFLICT(slot) DO UPDATE SET pid = excluded.pid, token = excluded.token`).run(pid, token);
  } finally {
    database.close();
  }
}

function ownerRecord(path: string): { pid: number; token: string } | undefined {
  const database = new DatabaseSync(path);
  try {
    return database.prepare('SELECT pid, token FROM companion_owner WHERE slot = 1').get() as
      { pid: number; token: string } | undefined;
  } finally {
    database.close();
  }
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'far-away-companion-storage-'));
  let failure: unknown;
  try { await run(root); } catch (error) { failure = error; }
  try { await rm(root, { recursive: true, force: true }); } catch (error) { if (!failure) failure = error; }
  if (failure) throw failure;
}

test('resolves platform paths without writing to user data', () => {
  assert.equal(resolveCompanionPaths({ platform: 'win32', localAppData: 'C:\\Users\\test\\AppData\\Local' }).dataRoot,
    'C:\\Users\\test\\AppData\\Local\\Far Away');
  assert.equal(resolveCompanionPaths({ platform: 'darwin', home: '/Users/test' }).dataRoot,
    '/Users/test/Library/Application Support/Far Away');
  assert.equal(resolveCompanionPaths({ platform: 'linux', home: '/home/test', xdgDataHome: '/data/test' }).dataRoot,
    '/data/test/far-away');
  assert.equal(resolveCompanionPaths({ platform: 'linux', home: '/home/test', xdgDataHome: '' }).dataRoot,
    '/home/test/.local/share/far-away');
  assert.throws(() => resolveCompanionPaths({ platform: 'win32', localAppData: '' }), /LOCALAPPDATA/);
  assert.throws(() => resolveCompanionPaths({ testDataRoot: 'relative' }), /absolute/);
});

test('creates a data root only at the supplied temporary path', async () => withRoot(async (root) => {
  const paths = resolveCompanionPaths({ testDataRoot: join(root, 'nested', 'data') });
  await createDataRoot(paths);
  assert.equal((await stat(paths.dataRoot)).isDirectory(), true);
  assert.match(paths.database, /companion\.sqlite$/);
}));

test('data-root creation fails with a useful error when the path is blocked', async () => withRoot(async (root) => {
  const blocked = join(root, 'file');
  await writeFile(blocked, 'occupied');
  await assert.rejects(createDataRoot(resolveCompanionPaths({ testDataRoot: join(blocked, 'child') })),
    /Cannot create Companion data directory/);
}));

test('owner rejects competitors and release checks the token', async () => withRoot(async (root) => {
  const paths = resolveCompanionPaths({ testDataRoot: root });
  const first = await CompanionOwnership.acquire(paths);
  await assert.rejects(CompanionOwnership.acquire(paths), /owned or locked|owned or owner liveness is uncertain/);
  await assert.rejects(first.release('different'), /token mismatch/);
  await first.assertHeld(paths.ownership);
  await first.release();
  await first.release();
  assert.equal(ownerRecord(paths.ownership), undefined);
  const next = await CompanionOwnership.acquire(paths);
  await next.release();
}));

test('dead committed recovery claimant is reclaimed without displacing live or ambiguous claimants', async () => withRoot(async (root) => {
  const paths = resolveCompanionPaths({ testDataRoot: root });
  seedOwner(paths.ownership, 777777, 'crashed-claimant');
  await assert.rejects(CompanionOwnership.acquire(paths, () => 'ambiguous'), /uncertain/);
  await assert.rejects(CompanionOwnership.acquire(paths, () => 'alive'), /uncertain/);
  assert.equal(ownerRecord(paths.ownership)?.token, 'crashed-claimant');
  const recovered = await CompanionOwnership.acquire(paths, () => 'dead');
  await recovered.assertHeld(paths.ownership);
  await recovered.release();
  assert.equal(ownerRecord(paths.ownership), undefined);
}));

test('crash during recovery transaction rolls back and remains recoverable', async () => withRoot(async (root) => {
  const paths = resolveCompanionPaths({ testDataRoot: root });
  seedOwner(paths.ownership, 777777, 'original-dead-owner');
  const interrupted = new DatabaseSync(paths.ownership);
  interrupted.exec('BEGIN IMMEDIATE');
  interrupted.prepare('UPDATE companion_owner SET pid = ?, token = ? WHERE slot = 1')
    .run(888888, 'uncommitted-claimant');
  interrupted.close(); // Simulates process death before the recovery transaction commits.
  assert.equal(ownerRecord(paths.ownership)?.token, 'original-dead-owner');
  const recovered = await CompanionOwnership.acquire(paths, () => 'dead');
  await recovered.release();
}));

test('competing stale reclaimers yield one owner', async () => withRoot(async (root) => {
  const paths = resolveCompanionPaths({ testDataRoot: root });
  seedOwner(paths.ownership, 777777, 'stale');
  const probe = (pid: number) => pid === 777777 ? 'dead' as const : 'alive' as const;
  const results = await Promise.allSettled([
    CompanionOwnership.acquire(paths, probe), CompanionOwnership.acquire(paths, probe),
  ]);
  const winners = results.filter((result): result is PromiseFulfilledResult<CompanionOwnership> => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  await winners[0]!.value.release();
}));

test('root, Companion, and lockfile require the same SQLite-capable Node baseline', async () => {
  const root = JSON.parse(await readFile(new URL('../../../../package.json', import.meta.url), 'utf8')) as
    { engines: { node: string } };
  const companion = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as
    { engines: { node: string } };
  const lock = JSON.parse(await readFile(new URL('../../../../package-lock.json', import.meta.url), 'utf8')) as
    { packages: Record<string, { engines?: { node?: string } }> };
  assert.equal(root.engines.node, '>=22.17.0');
  assert.equal(companion.engines.node, root.engines.node);
  assert.equal(lock.packages['']?.engines?.node, root.engines.node);
  assert.equal(lock.packages['apps/companion']?.engines?.node, root.engines.node);
});

test('SQLite enables WAL and foreign keys; migrations persist and do not rerun', async () => withRoot(async (root) => {
  let runs = 0;
  const migrations: Migration[] = [{ version: 1, name: 'sample', up: (db) => {
    runs += 1;
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
  } }];
  const events: string[] = [];
  const options = { paths: { testDataRoot: root }, migrations, onResourceEvent: (event: string) => events.push(event) };
  const first = await CompanionStorage.start(options);
  const paths = resolveCompanionPaths({ testDataRoot: root });
  const reader = new DatabaseSync(paths.database, { readOnly: true });
  assert.equal((reader.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  assert.deepEqual(reader.prepare('SELECT version, name FROM companion_migrations').all().map((row) => ({ ...row })),
    [{ version: 1, name: 'sample' }]);
  assert.equal((reader.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
  reader.close();
  await first.stop();
  assert.deepEqual(events, ['ownership-acquired', 'database-opened', 'database-closed', 'ownership-released']);
  const second = await CompanionStorage.start(options);
  assert.equal(runs, 1);
  await second.stop();
}));

test('invalid migration definitions fail before applying and failed migration rolls back', async () => withRoot(async (root) => {
  const paths = resolveCompanionPaths({ testDataRoot: root });
  const events: string[] = [];
  await assert.rejects(CompanionStorage.start({ paths: { testDataRoot: root }, migrations: [
    { version: 2, name: 'second', up: (db) => db.exec('CREATE TABLE should_not_exist (id INTEGER)') },
    { version: 1, name: 'first', up: () => undefined },
  ] }), /Invalid, duplicate, or unordered/);
  assert.equal(ownerRecord(paths.ownership), undefined);
  await assert.rejects(CompanionStorage.start({ paths: { testDataRoot: root }, migrations: [
    { version: 1, name: 'fails', up: (db) => {
      db.exec('CREATE TABLE rolled_back (id INTEGER)');
      throw new Error('deliberate');
    } },
  ], onResourceEvent: (event) => events.push(event) }), /migration 1 fails failed/);
  assert.deepEqual(events, ['ownership-acquired', 'database-opened', 'database-closed', 'ownership-released']);
  const db = new DatabaseSync(paths.database);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'rolled_back'").get(), undefined);
  assert.equal(db.prepare('SELECT * FROM companion_migrations').all().length, 0);
  db.close();
  const recovered = await CompanionStorage.start({ paths: { testDataRoot: root } });
  await recovered.stop();
}));

test('valid migration-history prefix continues without rerunning prior work', async () => withRoot(async (root) => {
  let firstRuns = 0;
  let secondRuns = 0;
  const first: Migration = { version: 1, name: 'first', up: (db) => {
    firstRuns += 1;
    db.exec('CREATE TABLE first_table (id INTEGER)');
  } };
  const second: Migration = { version: 2, name: 'second', up: (db) => {
    secondRuns += 1;
    db.exec('CREATE TABLE second_table (id INTEGER)');
  } };
  await (await CompanionStorage.start({ paths: { testDataRoot: root }, migrations: [first] })).stop();
  await (await CompanionStorage.start({ paths: { testDataRoot: root }, migrations: [first, second] })).stop();
  assert.equal(firstRuns, 1);
  assert.equal(secondRuns, 1);
  const db = new DatabaseSync(resolveCompanionPaths({ testDataRoot: root }).database);
  assert.deepEqual(db.prepare('SELECT version, name FROM companion_migrations ORDER BY version').all()
    .map((row) => ({ ...row })), [{ version: 1, name: 'first' }, { version: 2, name: 'second' }]);
  db.close();
}));

test('applied version 2 rejects retroactively inserted version 1 before any work', async () => withRoot(async (root) => {
  const paths = resolveCompanionPaths({ testDataRoot: root });
  const second: Migration = { version: 2, name: 'second', up: (db) => db.exec('CREATE TABLE second_table (id INTEGER)') };
  await (await CompanionStorage.start({ paths: { testDataRoot: root }, migrations: [second] })).stop();
  let firstRuns = 0;
  const inserted: Migration = { version: 1, name: 'inserted', up: (db) => {
    firstRuns += 1;
    db.exec('CREATE TABLE forbidden_table (id INTEGER)');
  } };
  await assert.rejects(CompanionStorage.start({ paths: { testDataRoot: root }, migrations: [inserted, second] }),
    /history is not a prefix/);
  assert.equal(firstRuns, 0);
  const db = new DatabaseSync(paths.database);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'forbidden_table'").get(), undefined);
  assert.deepEqual(db.prepare('SELECT version, name FROM companion_migrations').all().map((row) => ({ ...row })),
    [{ version: 2, name: 'second' }]);
  db.close();
}));

test('renamed and reordered applied history is rejected', async () => withRoot(async (root) => {
  const first: Migration = { version: 1, name: 'first', up: () => undefined };
  const second: Migration = { version: 2, name: 'second', up: () => undefined };
  await (await CompanionStorage.start({ paths: { testDataRoot: root }, migrations: [first, second] })).stop();
  await assert.rejects(CompanionStorage.start({ paths: { testDataRoot: root }, migrations: [
    { ...first, name: 'renamed' }, second,
  ] }), /history is not a prefix/);
  await assert.rejects(CompanionStorage.start({ paths: { testDataRoot: root }, migrations: [
    { ...first, name: 'second' }, { ...second, name: 'first' },
  ] }), /history is not a prefix/);
}));

test('unknown applied version is rejected before a new migration can run', async () => withRoot(async (root) => {
  const old: Migration = { version: 7, name: 'old', up: () => undefined };
  await (await CompanionStorage.start({ paths: { testDataRoot: root }, migrations: [old] })).stop();
  let newRuns = 0;
  await assert.rejects(CompanionStorage.start({ paths: { testDataRoot: root }, migrations: [
    { version: 1, name: 'new', up: () => { newRuns += 1; } },
  ] }), /history is not a prefix/);
  assert.equal(newRuns, 0);
}));
