import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompanionRuntime, type CompanionRuntimeState } from '../src/runtime.js';

test('runtime starts in STARTING, reaches READY, then stops once', async () => {
  const states: CompanionRuntimeState[] = [];
  let disposals = 0;
  const runtime = new CompanionRuntime({
    onStateChange: (state) => states.push(state),
    dispose: () => { disposals += 1; },
  });

  assert.equal(runtime.state, 'starting');
  await runtime.start();
  assert.equal(runtime.state, 'ready');
  await Promise.all([runtime.stop(), runtime.stop()]);
  await runtime.stop();
  assert.equal(runtime.state, 'stopped');
  assert.equal(disposals, 1);
  assert.deepEqual(states, ['ready', 'stopping', 'stopped']);
});

test('failed initialization never reports READY', async () => {
  const states: CompanionRuntimeState[] = [];
  const runtime = new CompanionRuntime({
    initialize: () => { throw new Error('initialization failed'); },
    onStateChange: (state) => states.push(state),
  });

  await assert.rejects(runtime.start(), /initialization failed/);
  assert.equal(runtime.state, 'stopped');
  assert.deepEqual(states, ['stopped']);
  await runtime.stop();
});

test('shutdown requested during initialization cannot report READY', async () => {
  let finishInitialization!: () => void;
  const initialization = new Promise<void>((resolve) => { finishInitialization = resolve; });
  const states: CompanionRuntimeState[] = [];
  const runtime = new CompanionRuntime({
    initialize: () => initialization,
    onStateChange: (state) => states.push(state),
  });

  const start = runtime.start();
  const stop = runtime.stop();
  finishInitialization();
  await Promise.all([start, stop]);
  assert.equal(runtime.state, 'stopped');
  assert.deepEqual(states, ['stopping', 'stopped']);
});
