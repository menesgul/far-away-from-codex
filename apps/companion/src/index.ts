import { MessageChannel } from 'node:worker_threads';
import { CompanionRuntime } from './runtime.js';
import { CompanionStorage } from './storage.js';

let shuttingDown = false;
// No M0.5 service owns an event-loop handle yet. This in-process hold keeps the
// standalone executable alive without polling or opening a transport.
const lifetime = new MessageChannel();
lifetime.port1.ref();
let lifetimeReleased = false;
let storage: CompanionStorage | undefined;
const runtime = new CompanionRuntime({
  initialize: async () => {
    storage = await CompanionStorage.start({
      paths: process.env.FAR_AWAY_COMPANION_TEST_DATA_ROOT
        ? { testDataRoot: process.env.FAR_AWAY_COMPANION_TEST_DATA_ROOT }
        : undefined,
    });
  },
  dispose: async () => { await storage?.stop(); },
  onStateChange: (state) => console.log(`Companion ${state.toUpperCase()}`),
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
