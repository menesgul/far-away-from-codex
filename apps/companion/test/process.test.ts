import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const WAIT_LIMIT_MS = 5_000;
const LIVENESS_WINDOW_MS = 750;
const executable = fileURLToPath(new URL('../src/index.js', import.meta.url));

function spawnCompanion() {
  const child = spawn(process.execPath, [executable], {
    stdio: ['ignore', 'pipe', 'pipe'],
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
    }
  }

  return { child, waitForReady, observeSustainedLiveness, waitForClose, cleanup, output: () => stdout };
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
