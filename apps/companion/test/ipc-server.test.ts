import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection, createServer, type Socket } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { CompanionApplication } from '../src/application.js';
import { LocalIpcServer } from '../src/ipc-server.js';
import { localEndpoint } from '../src/ipc-endpoint.js';
import { encodeIpcFrame, IpcFrameDecoder } from '../src/ipc-frame.js';
import { IPC_V1 } from '../src/ipc-protocol.js';
import { resolveCompanionPaths } from '../src/paths.js';
import { CompanionStorage } from '../src/storage.js';

const require = createRequire(import.meta.url);

async function root() { return mkdtemp(join(tmpdir(), 'far-away-ipc-')); }

function frameClient(path: string) {
  const socket = createConnection({ path });
  // A fail-closed server can race a queued client write on Windows.
  socket.on('error', () => undefined);
  const decoder = new IpcFrameDecoder();
  const queued: Record<string, unknown>[] = [];
  const waiting: Array<(value: Record<string, unknown>) => void> = [];
  socket.on('data', (chunk: Buffer) => {
    for (const value of decoder.push(chunk) as Record<string, unknown>[]) {
      const resolve = waiting.shift();
      if (resolve) resolve(value);
      else queued.push(value);
    }
  });
  return {
    socket,
    send: (message: object) => socket.write(encodeIpcFrame(message)),
    raw: (bytes: Buffer) => socket.write(bytes),
    next: async (): Promise<Record<string, unknown>> => {
      if (queued.length) return queued.shift()!;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const receive = (value: Record<string, unknown>) => { clearTimeout(timer); resolve(value); };
        const timer = setTimeout(() => {
          const index = waiting.indexOf(receive);
          if (index >= 0) waiting.splice(index, 1);
          reject(new Error('IPC frame timed out'));
        }, 3000);
        waiting.push(receive);
      });
    },
    close: () => socket.destroy(),
  };
}

async function establish(client: ReturnType<typeof frameClient>) {
  const challenge = await client.next();
  assert.equal(challenge.type, 'hello.challenge');
  client.send({ type: 'hello', version: IPC_V1, requestId: 'hello',
    supported: { min: IPC_V1, max: IPC_V1 }, challenge: challenge.challenge });
  const ack = await client.next();
  assert.equal(ack.type, 'hello.ack');
  return { challenge: challenge.challenge, sessionId: ack.sessionId };
}

function windowsStats(app: CompanionApplication) {
  const service = (app as unknown as { ipc?: { nativeId?: number } }).ipc;
  assert.ok(service?.nativeId !== undefined);
  const native = require('@far-away/windows-ipc-security') as typeof import('@far-away/windows-ipc-security');
  return native.stats(service.nativeId);
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('IPC condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('endpoint policy is deterministic Named Pipe or in-root UDS, never TCP', async () => {
  const directory = await root();
  try {
    const windows = localEndpoint(directory, 'win32');
    assert.equal(windows.transport, 'named-pipe');
    assert.match(windows.path, /^\\\\\.\\pipe\\far-away-[a-f0-9]{32}$/);
    assert.deepEqual(localEndpoint(directory, 'win32'), windows);
    const unixRoot = '/tmp/far-away-ipc-policy-test';
    const unix = localEndpoint(unixRoot, 'linux');
    assert.equal(unix.transport, 'unix-domain-socket');
    assert.equal(unix.path, '/tmp/far-away-ipc-policy-test/companion.sock');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Windows native pipe has an explicit protected current-user DACL',
  { skip: process.platform !== 'win32' ? 'Windows DACL requires Windows' : undefined }, async () => {
    const directory = await root();
    const native = require('@far-away/windows-ipc-security') as typeof import('@far-away/windows-ipc-security');
    const endpoint = localEndpoint(directory, 'win32');
    let id: number | undefined;
    try {
      id = native.start(endpoint.path, () => undefined);
      assert.deepEqual(native.security(id), {
        protectedDacl: true, currentUserOnly: true, aceCount: 1, rejectRemoteClients: true,
      });
    } finally {
      if (id !== undefined) native.stop(id);
      await rm(directory, { recursive: true, force: true });
    }
  });

test('real local transport serves two clients; malformed/disconnected peer is isolated and reads do not change SQLite', async () => {
  const directory = await root();
  const app = new CompanionApplication({ paths: { testDataRoot: directory } });
  const clients: ReturnType<typeof frameClient>[] = [];
  try {
    await app.start();
    assert.equal(app.state, 'ready');
    const endpoint = app.endpoint!;
    assert.equal(endpoint.transport, process.platform === 'win32' ? 'named-pipe' : 'unix-domain-socket');
    if (process.platform !== 'win32') {
      const socket = await stat(endpoint.path);
      assert.equal(socket.mode & 0o777, 0o600);
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
    }
    const paths = resolveCompanionPaths({ testDataRoot: directory });
    const before = new DatabaseSync(paths.database, { readOnly: true });
    const migrationCount = (before.prepare('SELECT count(*) AS count FROM companion_migrations').get() as { count: number }).count;
    const schemaVersion = (before.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    before.close();

    const first = frameClient(endpoint.path);
    const second = frameClient(endpoint.path);
    clients.push(first, second);
    const [a, b] = await Promise.all([establish(first), establish(second)]);
    assert.notEqual(a.challenge, b.challenge);
    assert.notEqual(a.sessionId, b.sessionId);
    first.send({ type: 'health.get', version: IPC_V1, requestId: 'a-health', sessionId: a.sessionId });
    second.send({ type: 'companion.status', version: IPC_V1, requestId: 'b-status', sessionId: b.sessionId });
    assert.equal((await first.next()).type, 'health.get.result');
    const status = await second.next();
    assert.deepEqual(status.status, { state: 'ready', transport: endpoint.transport, protocol: IPC_V1 });

    const malformed = frameClient(endpoint.path);
    clients.push(malformed);
    assert.equal((await malformed.next()).type, 'hello.challenge');
    malformed.raw(Buffer.alloc(4));
    await new Promise<void>((resolve) => malformed.socket.once('close', () => resolve()));
    const truncated = frameClient(endpoint.path);
    clients.push(truncated);
    assert.equal((await truncated.next()).type, 'hello.challenge');
    truncated.raw(Buffer.from([0, 0, 0, 20, 0x7b]));
    truncated.socket.end();
    await new Promise<void>((resolve) => truncated.socket.once('close', () => resolve()));
    assert.equal(app.state, 'ready');
    first.close();
    second.send({ type: 'health.get', version: IPC_V1, requestId: 'still-alive', sessionId: b.sessionId });
    assert.equal((await second.next()).type, 'health.get.result');

    const after = new DatabaseSync(paths.database, { readOnly: true });
    assert.equal((after.prepare('SELECT count(*) AS count FROM companion_migrations').get() as { count: number }).count,
      migrationCount);
    assert.equal((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      schemaVersion);
    after.close();
  } finally {
    for (const client of clients) client.close();
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('IPC binds after owned SQLite bootstrap and closes before database/ownership', async () => {
  const directory = await root();
  const events: string[] = [];
  const app = new CompanionApplication({ paths: { testDataRoot: directory },
    onResourceEvent: (event) => events.push(event) });
  try {
    await app.start();
    assert.deepEqual(events, ['ownership-acquired', 'database-opened', 'ipc-bound']);
    await Promise.all([app.stop(), app.stop()]);
    assert.deepEqual(events, ['ownership-acquired', 'database-opened', 'ipc-bound',
      'ipc-closed', 'database-closed', 'ownership-released']);
  } finally {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('failure immediately after IPC bind closes IPC before SQLite and permits restart', async () => {
  const directory = await root();
  const events: string[] = [];
  const app = new CompanionApplication({ paths: { testDataRoot: directory },
    onResourceEvent: (event) => {
      events.push(event);
      if (event === 'ipc-bound') throw new Error('injected post-bind failure');
    } });
  const endpoint = localEndpoint(directory);
  let restarted: CompanionApplication | undefined;
  let client: ReturnType<typeof frameClient> | undefined;
  try {
    await assert.rejects(app.start(), /injected post-bind failure/);
    assert.equal(app.state, 'stopped');
    assert.deepEqual(events, ['ownership-acquired', 'database-opened', 'ipc-bound',
      'ipc-closed', 'database-closed', 'ownership-released']);
    await assert.rejects(new Promise<void>((resolve, reject) => {
      const probe = createConnection({ path: endpoint.path });
      probe.once('connect', () => { probe.destroy(); resolve(); });
      probe.once('error', reject);
    }));
    restarted = new CompanionApplication({ paths: { testDataRoot: directory } });
    await restarted.start();
    assert.equal(restarted.state, 'ready');
    client = frameClient(restarted.endpoint!.path);
    await establish(client);
  } finally {
    client?.close();
    await restarted?.stop();
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Windows bounded queue pressure and malformed close leave another real client and shutdown responsive',
  { skip: process.platform !== 'win32' ? 'Windows pipe pressure requires Windows' : undefined,
    timeout: 15000 }, async () => {
    const directory = await root();
    const app = new CompanionApplication({ paths: { testDataRoot: directory } });
    let healthy: ReturnType<typeof frameClient> | undefined;
    let flood: ReturnType<typeof spawn> | undefined;
    try {
      await app.start();
      healthy = frameClient(app.endpoint!.path);
      const { sessionId } = await establish(healthy);
      const script = `
        const net = require('node:net');
        const socket = net.createConnection({ path: process.argv[1] });
        socket.on('error', () => {});
        socket.on('connect', () => {
          process.stdout.write('WRITING\\n');
          socket.write(Buffer.alloc(4));
          const chunk = Buffer.alloc(16384, 0x41);
          for (let i = 0; i < 1024; i++) socket.write(chunk);
        });
        socket.on('close', () => process.exit(0));
        setTimeout(() => socket.destroy(), 10000);
      `;
      flood = spawn(process.execPath, ['-e', script, app.endpoint!.path],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise<void>((resolve, reject) => {
        flood!.stdout!.once('data', () => resolve());
        flood!.once('error', reject);
        flood!.once('exit', () => reject(new Error('flood client exited before writing')));
      });
      // Native pipe readers keep running while JS is held here. More than 256
      // 16 KiB reads force the bounded TSFN queue into backpressure.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      assert.ok(windowsStats(app).queueFullCount > 0, 'bounded event queue reached capacity');
      healthy.send({ type: 'health.get', version: IPC_V1,
        requestId: 'after-pressure', sessionId });
      assert.equal((await healthy.next()).type, 'health.get.result');
      assert.equal(app.state, 'ready');
      await until(() => windowsStats(app).clientCount === 1);
      healthy.close();
      await until(() => windowsStats(app).clientCount === 0);
      await app.stop();
      assert.equal(app.state, 'stopped');
    } finally {
      healthy?.close();
      flood?.kill();
      await app.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

test('Windows clean disconnect reclaims native client without a later connection',
  { skip: process.platform !== 'win32' ? 'Windows native lifecycle requires Windows' : undefined }, async () => {
    const directory = await root();
    const app = new CompanionApplication({ paths: { testDataRoot: directory } });
    let client: ReturnType<typeof frameClient> | undefined;
    try {
      await app.start();
      client = frameClient(app.endpoint!.path);
      await establish(client);
      assert.equal(windowsStats(app).clientCount, 1);
      client.close();
      await until(() => windowsStats(app).clientCount === 0);
      assert.equal(app.state, 'ready');
    } finally {
      client?.close();
      await app.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

test('occupied IPC endpoint prevents READY and unwinds database then ownership', async () => {
  const directory = await root();
  const endpoint = localEndpoint(directory);
  const events: string[] = [];
  let nativeId: number | undefined;
  let native: typeof import('@far-away/windows-ipc-security') | undefined;
  let blocker: ReturnType<typeof createServer> | undefined;
  try {
    if (process.platform === 'win32') {
      native = require('@far-away/windows-ipc-security') as typeof import('@far-away/windows-ipc-security');
      nativeId = native.start(endpoint.path, () => undefined);
    } else {
      blocker = createServer();
      await new Promise<void>((resolve) => blocker!.listen(endpoint.path, resolve));
    }
    const app = new CompanionApplication({ paths: { testDataRoot: directory },
      onResourceEvent: (event) => events.push(event) });
    await assert.rejects(app.start());
    assert.equal(app.state, 'stopped');
    assert.deepEqual(events, ['ownership-acquired', 'database-opened', 'database-closed', 'ownership-released']);
    const owner = new DatabaseSync(resolveCompanionPaths({ testDataRoot: directory }).ownership);
    assert.equal(owner.prepare('SELECT * FROM companion_owner').get(), undefined);
    owner.close();
  } finally {
    if (nativeId !== undefined) native!.stop(nativeId);
    if (blocker) await new Promise<void>((resolve) => blocker!.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('Unix UDS mode 0600 and stale endpoint protection are exercised on Unix',
  { skip: process.platform === 'win32' ? 'Unix UDS requires Unix' : undefined }, async () => {
    const directory = await root();
    const endpoint = localEndpoint(directory);
    const app = new CompanionApplication({ paths: { testDataRoot: directory } });
    try {
      await app.start();
      assert.equal((await stat(endpoint.path)).mode & 0o777, 0o600);
      await app.stop();
      await assert.rejects(stat(endpoint.path), { code: 'ENOENT' });
    } finally {
      await app.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

test('Unix never removes a live endpoint or a stale endpoint before ownership is proven',
  { skip: process.platform === 'win32' ? 'Unix UDS requires Unix' : undefined }, async () => {
    const directory = await root();
    const endpoint = localEndpoint(directory);
    const storage = await CompanionStorage.start({ paths: { testDataRoot: directory } });
    let service: LocalIpcServer | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const blocker = createServer();
      await new Promise<void>((resolve) => blocker.listen(endpoint.path, resolve));
      await assert.rejects(LocalIpcServer.start({ dataRoot: directory,
        assertOwnershipHeld: () => storage.assertOwnershipHeld(), runtimeState: () => 'ready' }),
      /live process/);
      assert.equal((await stat(endpoint.path)).isSocket(), true);
      await new Promise<void>((resolve) => blocker.close(() => resolve()));

      const script = `const net=require('node:net');net.createServer().listen(${JSON.stringify(endpoint.path)},()=>console.log('READY'))`;
      child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise<void>((resolve, reject) => {
        child!.stdout!.once('data', () => resolve());
        child!.once('error', reject);
        child!.once('exit', () => reject(new Error('socket child exited before READY')));
      });
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      assert.equal((await stat(endpoint.path)).isSocket(), true);
      await assert.rejects(LocalIpcServer.start({ dataRoot: directory,
        assertOwnershipHeld: async () => { throw new Error('ownership missing'); },
        runtimeState: () => 'ready' }), /ownership missing/);
      assert.equal((await stat(endpoint.path)).isSocket(), true);
      service = await LocalIpcServer.start({ dataRoot: directory,
        assertOwnershipHeld: () => storage.assertOwnershipHeld(), runtimeState: () => 'ready' });
      assert.equal((await stat(endpoint.path)).mode & 0o777, 0o600);
    } finally {
      if (child && child.exitCode === null) child.kill('SIGKILL');
      await service?.stop();
      await storage.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
