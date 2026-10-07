import { MessageChannel } from 'node:worker_threads';
import { CompanionApplication } from './application.js';

let shuttingDown = false;
// The lifetime hold also keeps the process alive during an IPC startup failure
// until all acquired resources have been unwound.
const lifetime = new MessageChannel();
lifetime.port1.ref();
let lifetimeReleased = false;
const runtime = new CompanionApplication({
  paths: process.env.FAR_AWAY_COMPANION_TEST_DATA_ROOT
    ? { testDataRoot: process.env.FAR_AWAY_COMPANION_TEST_DATA_ROOT }
    : undefined,
  onStateChange: (state) => console.log(`Companion ${state.toUpperCase()}`),
  onFatalIpc: () => { void shutdown(); },
});

function releaseLifetime(): void {
  if (lifetimeReleased) return;
  lifetimeReleased = true;
  process.off('SIGINT', requestShutdown);
  process.off('SIGTERM', requestShutdown);
  lifetime.port1.close();
  lifetime.port2.close();
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await runtime.stop();
  } catch (error) {
    console.error('Companion shutdown failed', error);
    process.exitCode = 1;
  } finally {
    releaseLifetime();
  }
}

function requestShutdown(): void {
  void shutdown();
}

process.on('SIGINT', requestShutdown);
process.on('SIGTERM', requestShutdown);

console.log('Companion STARTING');
try {
  await runtime.start();
  if (runtime.state !== 'ready') {
    await shutdown();
  }
} catch (error) {
  console.error('Companion startup failed', error);
  process.exitCode = 1;
  releaseLifetime();
}
