import {
	type PairingSessionTimers,
	TelegramPairingSession,
} from '../../telegram/TelegramPairingSession';
import {
	type PairingPanelMessage,
	type TelegramPairingPanel,
} from '../../ui/TelegramPairingPanel';
import {
	Deferred,
	settlePromises,
} from '../helpers/async';
import { INSTALLATION_CREDENTIAL } from '../helpers/credentials';
import { futurePairing } from '../helpers/pairing';
import * as assert from 'assert';
import { type PairingStatus } from '../../backend/BackendClient';

class FakeTimers implements PairingSessionTimers {
	private currentTime = 0;
	private nextId = 1;
	private readonly scheduled = new Map<number, { at: number; callback: () => void }>();

	public now(): number {
		return this.currentTime;
	}

	public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
		const id = this.nextId++;
		this.scheduled.set(id, { at: this.currentTime + delayMs, callback });
		return id as unknown as ReturnType<typeof setTimeout>;
	}

	public clearTimeout(timer: ReturnType<typeof setTimeout>): void {
		this.scheduled.delete(timer as unknown as number);
	}

	public advanceBy(delayMs: number): void {
		const target = this.currentTime + delayMs;
		while (true) {
			const due = [...this.scheduled.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
			if (due === undefined) {
				break;
			}
			const [id, timer] = due;
			this.scheduled.delete(id);
			this.currentTime = timer.at;
			timer.callback();
		}
		this.currentTime = target;
	}
}

class FakePairingPanel {
	public isDisposed = false;
	public showExpiredCalls = 0;
	public revealCalls = 0;
	public disposeCalls = 0;
	private readonly actionListeners = new Set<(message: PairingPanelMessage) => void>();
	private readonly disposeListeners = new Set<() => void>();

	public readonly onDidReceiveAction = (listener: (message: PairingPanelMessage) => void) => {
		this.actionListeners.add(listener);
		return { dispose: () => this.actionListeners.delete(listener) };
	};

	public readonly onDidDispose = (listener: () => void) => {
		this.disposeListeners.add(listener);
		return { dispose: () => this.disposeListeners.delete(listener) };
	};

	public showExpired(): void {
		this.showExpiredCalls += 1;
	}

	public reveal(): boolean {
		if (this.isDisposed) {
			return false;
		}
		this.revealCalls += 1;
		return true;
	}

	public dispose(): void {
		this.disposeCalls += 1;
		if (this.isDisposed) {
			return;
		}
		this.isDisposed = true;
		for (const listener of [...this.disposeListeners]) {
			listener();
		}
	}

	public emitAction(message: PairingPanelMessage): void {
		for (const listener of [...this.actionListeners]) {
			listener(message);
		}
	}
}

suite('TelegramPairingSession', () => {
	test('cancelling during asynchronous panel construction leaves the starting session terminal and disposes the late panel', async () => {
		const timers = new FakeTimers();
		const latePanel = new FakePairingPanel();
		const panelCreation = new Deferred<TelegramPairingPanel>();
		let terminalCalls = 0;
		const session = new TelegramPairingSession({
			client: { getPairingStatus: async () => 'pending' },
			createPanel: async () => panelCreation.promise,
			writeClipboard: async () => undefined,
			openExternal: async () => undefined,
			onConnected: () => undefined,
			onTerminal: () => { terminalCalls += 1; },
			timers,
			maxPollDurationMs: 100,
		});

		const start = session.start(INSTALLATION_CREDENTIAL, futurePairing(100));
		assert.strictEqual(session.state, 'starting');
		session.cancel();
		panelCreation.resolve(latePanel as unknown as TelegramPairingPanel);
		await start;
		assert.strictEqual(session.state, 'cancelled');
		assert.strictEqual(terminalCalls, 1);
		assert.strictEqual(latePanel.isDisposed, true);
	});

	test('pairing session serializes polling and does not overlap status GETs', async () => {
		const timers = new FakeTimers();
		const panel = new FakePairingPanel();
		const firstPoll = new Deferred<PairingStatus>();
		let requests = 0;
		const session = new TelegramPairingSession({
			client: {
				getPairingStatus: async () => {
					requests += 1;
					return firstPoll.promise;
				},
			},
			createPanel: async () => panel as unknown as TelegramPairingPanel,
			writeClipboard: async () => undefined,
			openExternal: async () => undefined,
			onConnected: () => undefined,
			timers,
			pollIntervalMs: 3,
			maxPollDurationMs: 100,
		});

		await session.start(INSTALLATION_CREDENTIAL, futurePairing(100));
		assert.strictEqual(requests, 1);
		timers.advanceBy(50);
		assert.strictEqual(requests, 1);
		firstPoll.resolve('pending');
		await settlePromises();
		timers.advanceBy(3);
		assert.strictEqual(requests, 2);
		session.cancel();
	});

	test('pairing session handles duplicate Cancel and Cancel plus panel X exactly once', async () => {
		const timers = new FakeTimers();
		const panel = new FakePairingPanel();
		let terminalCalls = 0;
		const session = new TelegramPairingSession({
			client: { getPairingStatus: async () => new Promise<PairingStatus>(() => undefined) },
			createPanel: async () => panel as unknown as TelegramPairingPanel,
			writeClipboard: async () => undefined,
			openExternal: async () => undefined,
			onConnected: () => undefined,
			onTerminal: () => { terminalCalls += 1; },
			timers,
			maxPollDurationMs: 100,
		});

		await session.start(INSTALLATION_CREDENTIAL, futurePairing(100));
		panel.emitAction({ type: 'cancel' });
		panel.emitAction({ type: 'cancel' });
		panel.dispose();
		assert.strictEqual(session.state, 'cancelled');
		assert.strictEqual(terminalCalls, 1);
		assert.strictEqual(panel.disposeCalls, 2);
	});

	test('panel X cancels locally and stops future polling', async () => {
		const timers = new FakeTimers();
		const panel = new FakePairingPanel();
		let requests = 0;
		const session = new TelegramPairingSession({
			client: { getPairingStatus: async () => { requests += 1; return 'pending'; } },
			createPanel: async () => panel as unknown as TelegramPairingPanel,
			writeClipboard: async () => undefined,
			openExternal: async () => undefined,
			onConnected: () => undefined,
			timers,
			pollIntervalMs: 3,
			maxPollDurationMs: 100,
		});

		await session.start(INSTALLATION_CREDENTIAL, futurePairing(100));
		await settlePromises();
		panel.dispose();
		timers.advanceBy(99);
		await settlePromises();
		assert.strictEqual(session.state, 'cancelled');
		assert.strictEqual(requests, 1);
	});

	test('a connected in-flight status response is observed after local Cancel without reviving the panel', async () => {
		const timers = new FakeTimers();
		const panel = new FakePairingPanel();
		const poll = new Deferred<PairingStatus>();
		let connectedCalls = 0;
		const session = new TelegramPairingSession({
			client: { getPairingStatus: async () => poll.promise },
			createPanel: async () => panel as unknown as TelegramPairingPanel,
			writeClipboard: async () => undefined,
			openExternal: async () => undefined,
			onConnected: () => { connectedCalls += 1; },
			timers,
			maxPollDurationMs: 100,
		});

		await session.start(INSTALLATION_CREDENTIAL, futurePairing(100));
		panel.emitAction({ type: 'cancel' });
		poll.resolve('connected');
		await settlePromises();
		assert.strictEqual(session.state, 'cancelled');
		assert.strictEqual(connectedCalls, 1);
		assert.strictEqual(panel.disposeCalls, 1);
	});

	test('a pre-deadline connected GET beats the local expiry boundary', async () => {
		const timers = new FakeTimers();
		const panel = new FakePairingPanel();
		const poll = new Deferred<PairingStatus>();
		let connectedCalls = 0;
		const session = new TelegramPairingSession({
			client: { getPairingStatus: async () => poll.promise },
			createPanel: async () => panel as unknown as TelegramPairingPanel,
			writeClipboard: async () => undefined,
			openExternal: async () => undefined,
			onConnected: () => { connectedCalls += 1; },
			timers,
			maxPollDurationMs: 10,
		});

		await session.start(INSTALLATION_CREDENTIAL, futurePairing(10));
		timers.advanceBy(10);
		assert.strictEqual(session.state, 'waiting');
		poll.resolve('connected');
		await settlePromises();
		assert.strictEqual(session.state, 'connected');
		assert.strictEqual(connectedCalls, 1);
		assert.strictEqual(panel.disposeCalls, 1);
	});

	test('expiry waits for an in-flight pending or failed GET then keeps the expired panel open', async () => {
		for (const outcome of ['pending', 'failure'] as const) {
			const timers = new FakeTimers();
			const panel = new FakePairingPanel();
			const poll = new Deferred<PairingStatus>();
			const session = new TelegramPairingSession({
				client: { getPairingStatus: async () => poll.promise },
				createPanel: async () => panel as unknown as TelegramPairingPanel,
				writeClipboard: async () => undefined,
				openExternal: async () => undefined,
				onConnected: () => undefined,
				timers,
				maxPollDurationMs: 10,
			});

			await session.start(INSTALLATION_CREDENTIAL, futurePairing(10));
			timers.advanceBy(10);
			if (outcome === 'pending') {
				poll.resolve('pending');
			} else {
				poll.reject(new Error('temporary backend failure'));
			}
			await settlePromises();
			assert.strictEqual(session.state, 'expired');
			assert.strictEqual(panel.showExpiredCalls, 1);
			assert.strictEqual(panel.isDisposed, false);
		}
	});

	test('Copy and Open are explicit-only and ignored after expiry or cancellation', async () => {
		const timers = new FakeTimers();
		const panel = new FakePairingPanel();
		const poll = new Deferred<PairingStatus>();
		let copied = 0;
		let opened = 0;
		const session = new TelegramPairingSession({
			client: { getPairingStatus: async () => poll.promise },
			createPanel: async () => panel as unknown as TelegramPairingPanel,
			writeClipboard: async () => { copied += 1; },
			openExternal: async () => { opened += 1; },
			onConnected: () => undefined,
			timers,
			maxPollDurationMs: 10,
		});

		await session.start(INSTALLATION_CREDENTIAL, futurePairing(10));
		assert.strictEqual(copied, 0);
		assert.strictEqual(opened, 0);
		panel.emitAction({ type: 'copy-link' });
		panel.emitAction({ type: 'open-on-this-device' });
		await settlePromises();
		assert.strictEqual(copied, 1);
		assert.strictEqual(opened, 1);
		timers.advanceBy(10);
		poll.resolve('pending');
		await settlePromises();
		panel.emitAction({ type: 'copy-link' });
		panel.emitAction({ type: 'open-on-this-device' });
		await settlePromises();
		assert.strictEqual(session.state, 'expired');
		assert.strictEqual(copied, 1);
		assert.strictEqual(opened, 1);
		panel.emitAction({ type: 'close' });
		assert.strictEqual(panel.isDisposed, true);
	});
});
