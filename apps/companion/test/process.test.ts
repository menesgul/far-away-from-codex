import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { localEndpoint } from '../src/ipc-endpoint.js';
import { encodeIpcFrame, IpcFrameDecoder } from '../src/ipc-frame.js';
import { IPC_V1 } from '../src/ipc-protocol.js';
import { resolveCompanionPaths } from '../src/paths.js';

const WAIT_LIMIT_MS = 5_000;
const LIVENESS_WINDOW_MS = 750;
const executable = fileURLToPath(new URL('../src/index.js', import.meta.url));

function spawnCompanion(sharedDataRoot?: string) {
  const dataRoot = sharedDataRoot ?? mkdtempSync(join(tmpdir(), 'far-away-companion-process-'));
  const child = spawn(process.execPath, [executable], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAR_AWAY_COMPANION_TEST_DATA_ROOT: dataRoot },
  });
  let stdout = '';
  let stderr = '';
  let closed: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  const captureStdout = (chunk: Buffer) => { stdout += chunk.toString(); };
  const captureStderr = (chunk: Buffer) => { stderr += chunk.toString(); };
  const recordClose = (code: number | null, signal: NodeJS.Signals | null) => {
    closed = { code, signal };
  };
  child.stdout.on('data', captureStdout);
  child.stderr.on('data', captureStderr);
  child.once('close', recordClose);

  function details(): string {
    return `stdout: ${JSON.stringify(stdout)}; stderr: ${JSON.stringify(stderr)}`;
  }

  function waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.stdout.off('data', checkReady);
        child.off('close', onClose);
        child.off('error', onError);
        if (error) reject(error);
        else resolve();
      };
      const checkReady = () => {
        if (stdout.includes('Companion READY')) finish();
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(new Error(`Companion closed before READY (code=${code}, signal=${signal}); ${details()}`));
      };
      const onError = (error: Error) => finish(error);
      const timer = setTimeout(() => {
        finish(new Error(`Timed out waiting for Companion READY; ${details()}`));
      }, WAIT_LIMIT_MS);

      child.stdout.on('data', checkReady);
      child.once('close', onClose);
      child.once('error', onError);
      if (closed) onClose(closed.code, closed.signal);
      else checkReady();
    });
  }

  function waitForClose(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (closed) return Promise.resolve(closed);
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, result?: { code: number | null; signal: NodeJS.Signals | null }) => {
        clearTimeout(timer);
        child.off('close', onClose);
        child.off('error', onError);
        if (error) reject(error);
        else resolve(result!);
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(undefined, { code, signal });
      };
      const onError = (error: Error) => finish(error);
      const timer = setTimeout(() => {
        finish(new Error(`Timed out waiting for Companion exit; ${details()}`));
      }, WAIT_LIMIT_MS);

      child.once('close', onClose);
      child.once('error', onError);
    });
  }

  function observeSustainedLiveness(): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.off('exit', onExit);
        child.off('close', onClose);
        child.off('error', onError);
        if (error) reject(error);
        else resolve();
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(new Error(`Companion exited without shutdown (code=${code}, signal=${signal}); ${details()}`));
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => onExit(code, signal);
      const onError = (error: Error) => finish(error);
      // This interval proves continued liveness after READY; READY and shutdown
      // themselves remain event-driven and have separate failure bounds.
      const timer = setTimeout(() => {
        if (closed || child.exitCode !== null || child.signalCode !== null) {
          finish(new Error(`Companion stopped during liveness observation; ${details()}`));
        } else {
          finish();
        }
      }, LIVENESS_WINDOW_MS);

      child.once('exit', onExit);
      child.once('close', onClose);
      child.once('error', onError);
      if (closed || child.exitCode !== null || child.signalCode !== null) {
        finish(new Error(`Companion had already exited after READY; ${details()}`));
      }
    });
  }

  async function cleanup(): Promise<void> {
    try {
      if (!closed) {
        child.kill('SIGKILL');
        await waitForClose();
      }
    } finally {
      child.stdout.off('data', captureStdout);
      child.stderr.off('data', captureStderr);
      child.off('close', recordClose);
      if (!sharedDataRoot) rmSync(dataRoot, { recursive: true, force: true });
    }
  }

  return { child, dataRoot, waitForReady, observeSustainedLiveness, waitForClose, cleanup, output: () => stdout, errors: () => stderr };
}

async function handshake(path: string): Promise<void> {
  const socket = createConnection({ path });
  const frames = new IpcFrameDecoder();
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error('Companion handshake timed out')), WAIT_LIMIT_MS);
      socket.on('error', finish);
      socket.on('close', () => finish(new Error('Companion closed during handshake')));
      socket.on('data', (chunk: Buffer) => {
        try {
          for (const frame of frames.push(chunk) as Record<string, unknown>[]) {
            if (frame.type === 'hello.challenge') {
              socket.write(encodeIpcFrame({ type: 'hello', version: IPC_V1, requestId: 'owner-probe',
                supported: { min: IPC_V1, max: IPC_V1 }, challenge: frame.challenge }));
            } else if (frame.type === 'hello.ack' && frame.requestId === 'owner-probe') {
              finish();
            } else {
              finish(new Error(`Unexpected Companion handshake frame: ${String(frame.type)}`));
            }
          }
        } catch (error) { finish(error as Error); }
      });
    });
  } finally { socket.destroy(); }
}

test('built Companion launches without VS Code and remains alive at READY', async () => {
  const companion = spawnCompanion();
  try {
    await companion.waitForReady();
    assert.match(companion.output(), /Companion STARTING\s+Companion READY/);
    await companion.observeSustainedLiveness();
  } finally {
    await companion.cleanup();
  }
});

test('second executable cannot reach READY while the first owns the data root', async () => {
  const first = spawnCompanion();
  let second: ReturnType<typeof spawnCompanion> | undefined;
  try {
    await first.waitForReady();
    const paths = resolveCompanionPaths({ testDataRoot: first.dataRoot });
    const ownerBefore = new DatabaseSync(paths.ownership, { readOnly: true });
    const tokenBefore = (ownerBefore.prepare('SELECT token FROM companion_owner WHERE slot = 1').get() as
      { token: string }).token;
    ownerBefore.close();
    second = spawnCompanion(first.dataRoot);
    const exit = await second.waitForClose();
    assert.notEqual(exit.code, 0);
    assert.doesNotMatch(second.output(), /Companion READY/);
    assert.match(second.errors(), /owned or locked|owned or owner liveness is uncertain/);
    const ownerAfter = new DatabaseSync(paths.ownership, { readOnly: true });
    assert.equal((ownerAfter.prepare('SELECT token FROM companion_owner WHERE slot = 1').get() as
      { token: string }).token, tokenBefore);
    ownerAfter.close();
    await handshake(localEndpoint(first.dataRoot).path);
    await first.observeSustainedLiveness();
  } finally {
    await second?.cleanup();
    await first.cleanup();
  }
});

test('a killed Companion leaves recoverable ownership for a new process', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'far-away-companion-crash-'));
  const first = spawnCompanion(dataRoot);
  let second: ReturnType<typeof spawnCompanion> | undefined;
  try {
    await first.waitForReady();
    await first.cleanup(); // Forced termination, without graceful ownership release.
    second = spawnCompanion(dataRoot);
    await second.waitForReady();
    await second.observeSustainedLiveness();
  } finally {
    await second?.cleanup();
    await first.cleanup();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('two spawned reclaimers of a dead claim produce only one READY process', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'far-away-companion-reclaim-'));
  const ownership = new DatabaseSync(join(dataRoot, 'companion.owner'));
  ownership.exec(`CREATE TABLE companion_owner (
    slot INTEGER PRIMARY KEY CHECK (slot = 1), pid INTEGER NOT NULL, token TEXT NOT NULL
  )`);
  ownership.prepare('INSERT INTO companion_owner(slot, pid, token) VALUES (1, ?, ?)')
    .run(777777, 'dead-claimant');
  ownership.close();
  const first = spawnCompanion(dataRoot);
  const second = spawnCompanion(dataRoot);
  try {
    const results = await Promise.allSettled([first.waitForReady(), second.waitForReady()]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const loser = results[0]?.status === 'rejected' ? first : second;
    const exit = await loser.waitForClose();
    assert.notEqual(exit.code, 0);
    assert.doesNotMatch(loser.output(), /Companion READY/);
  } finally {
    await first.cleanup();
    await second.cleanup();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

// Node's child.kill(signal) forcibly terminates Windows children instead of
// reliably delivering SIGINT/SIGTERM to the child's JavaScript handlers.
const unsupportedSignalReason = process.platform === 'win32'
  ? 'Windows child.kill cannot reliably exercise the executable signal handler'
  : undefined;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`built Companion gracefully handles ${signal}`, { skip: unsupportedSignalReason }, async () => {
    const companion = spawnCompanion();
    try {
      await companion.waitForReady();
      assert.equal(companion.child.kill(signal), true);
      const exit = await companion.waitForClose();
      assert.deepEqual(exit, { code: 0, signal: null });
      assert.match(
        companion.output(),
        /Companion STARTING\s+Companion READY\s+Companion STOPPING\s+Companion STOPPED/,
      );
    } finally {
      await companion.cleanup();
    }
  });
}
