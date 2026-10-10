import * as assert from 'assert';
import { CompanionClientError } from '../../companion/CompanionClient';
import {
	createCompanionStatusProjection,
	type CompanionStatusClient,
	type CompanionStatusText,
} from '../../companion/CompanionStatusProjection';
import { Deferred, settlePromises } from '../helpers/async';

function harness(connect: () => Promise<void>, status: CompanionStatusClient['companionStatus']) {
	const rendered: CompanionStatusText[] = [];
	let connections = 0;
	let reads = 0;
	let disconnects = 0;
	let disposals = 0;
	const projection = createCompanionStatusProjection({
		connect: () => { connections += 1; return connect(); },
		companionStatus: () => { reads += 1; return status(); },
		disconnect: () => { disconnects += 1; },
		dispose: () => { disposals += 1; },
	}, (text) => rendered.push(text));
	return {
		projection, rendered,
		get connections() { return connections; },
		get reads() { return reads; },
		get disconnects() { return disconnects; },
		get disposals() { return disposals; },
	};
}

suite('Companion status projection', () => {
	test('one bounded connect then status read yields a diagnostic connected snapshot', async () => {
		const h = harness(async () => undefined, async () => ({
			state: 'ready', transport: process.platform === 'win32' ? 'named-pipe' : 'unix-domain-socket',
			protocol: { major: 1, minor: 0 },
		}));
		await h.projection.probe();
		assert.deepStrictEqual(h.rendered, ['Companion: Checking', 'Companion: Checking', 'Companion: Connected (last check)']);
		assert.strictEqual(h.connections, 1);
		assert.strictEqual(h.reads, 1);
		assert.strictEqual(h.disconnects, 0);
		h.projection.dispose();
		assert.strictEqual(h.disposals, 1);
	});

	test('successful status remains explicitly a last-check snapshot after transport loss', async () => {
		const h = harness(async () => undefined, async () => ({
			state: 'ready', transport: process.platform === 'win32' ? 'named-pipe' : 'unix-domain-socket',
			protocol: { major: 1, minor: 0 },
		}));
		await h.projection.probe();
		// A client can lose its socket without an explicit refresh. The projection must
		// never claim that its prior response proves current liveness.
		assert.strictEqual(h.rendered.at(-1), 'Companion: Connected (last check)');
		h.projection.dispose();
	});

	test('missing Companion is non-fatal and only explicit refresh reconnects', async () => {
		const h = harness(async () => { throw new CompanionClientError('unavailable'); },
			async () => { throw new Error('status must not be read'); });
		await h.projection.probe();
		assert.strictEqual(h.rendered.at(-1), 'Companion: Not running');
		assert.strictEqual(h.connections, 1);
		assert.strictEqual(h.reads, 0);
		await settlePromises();
		assert.strictEqual(h.connections, 1);
		await h.projection.probe();
		assert.strictEqual(h.connections, 2);
		assert.strictEqual(h.disconnects, 2);
		h.projection.dispose();
	});

	test('incompatible and malformed protocol fail closed, distinct from connected', async () => {
		for (const code of ['incompatible_protocol', 'protocol_violation', 'remote_protocol_error'] as const) {
			const h = harness(async () => undefined, async () => { throw new CompanionClientError(code); });
			await h.projection.probe();
			assert.strictEqual(h.rendered.at(-1), 'Companion: Incompatible');
			assert.strictEqual(h.disconnects, 1);
			h.projection.dispose();
		}
	});

	test('concurrent refresh shares one attempt, and disposal fences a late result', async () => {
		const gate = new Deferred<void>();
		const h = harness(() => gate.promise, async () => ({
			state: 'ready', transport: process.platform === 'win32' ? 'named-pipe' : 'unix-domain-socket',
			protocol: { major: 1, minor: 0 },
		}));
		const first = h.projection.probe();
		const second = h.projection.probe();
		assert.strictEqual(first, second);
		assert.strictEqual(h.connections, 1);
		h.projection.dispose();
		gate.resolve();
		await first;
		assert.notStrictEqual(h.rendered.at(-1), 'Companion: Connected (last check)');
		assert.strictEqual(h.disposals, 1);
		await h.projection.probe();
		assert.strictEqual(h.connections, 1);
	});
});
