import { type Pairing } from '../../backend/BackendClient';
import { FakeConnectSession } from '../helpers/FakeConnectSession';
import { createTelegramConnectCommand } from '../../telegram/TelegramConnectCommand';
import {
	INSTALLATION_CREDENTIAL,
	FakeCredentialStore,
} from '../helpers/credentials';
import { futurePairing } from '../helpers/pairing';
import {
	Deferred,
	settlePromises,
} from '../helpers/async';
import * as assert from 'assert';

function createConnectCommandHarness(options: {
	ensureInstallation?: () => Promise<string>;
	getTelegramConnection?: () => Promise<boolean>;
	createPairing?: () => Promise<Pairing>;
	now?: () => number;
} = {}) {
	const sessions: FakeConnectSession[] = [];
	const appliedStates: string[] = [];
	const messages: string[] = [];
	let enabledAfterConnectCalls = 0;
	let connectionStateRevision = 0;
	let ensureCalls = 0;
	let connectionCalls = 0;
	let pairingCalls = 0;
	const command = createTelegramConnectCommand({
		client: {
			ensureInstallation: async () => {
				ensureCalls += 1;
				return options.ensureInstallation?.() ?? INSTALLATION_CREDENTIAL;
			},
			getTelegramConnection: async () => {
				connectionCalls += 1;
				return options.getTelegramConnection?.() ?? false;
			},
			createPairing: async () => {
				pairingCalls += 1;
				return options.createPairing?.() ?? futurePairing(Date.now() + 60_000);
			},
		},
		store: new FakeCredentialStore(),
		createSession: (callbacks) => {
			const session = new FakeConnectSession(callbacks);
			sessions.push(session);
			return session;
		},
		applyConnectionState: (state) => {
			appliedStates.push(state);
			connectionStateRevision += 1;
		},
		enableAlertsAfterConnect: () => { enabledAfterConnectCalls += 1; },
		getConnectionStateRevision: () => connectionStateRevision,
		showConnected: () => messages.push('connected'),
		showError: (message) => messages.push(message),
		now: options.now ?? (() => Date.now()),
	});

	return {
		command,
		sessions,
		appliedStates,
		messages,
		get enabledAfterConnectCalls() { return enabledAfterConnectCalls; },
		get connectionStateRevision() { return connectionStateRevision; },
		get ensureCalls() { return ensureCalls; },
		get connectionCalls() { return connectionCalls; },
		get pairingCalls() { return pairingCalls; },
		applyExternalConnectionState: (state: string) => {
			appliedStates.push(state);
			connectionStateRevision += 1;
		},
	};
}

suite('TelegramConnectCommand', () => {
	test('Connect command keeps one starting session while installation startup is in flight', async () => {
		const installation = new Deferred<string>();
		const harness = createConnectCommandHarness({
			ensureInstallation: () => installation.promise,
		});

		const firstConnect = harness.command.execute();
		assert.strictEqual(harness.sessions.length, 1);
		assert.strictEqual(harness.command.getActiveSession(), harness.sessions[0]);
		assert.strictEqual(harness.ensureCalls, 1);
		assert.strictEqual(harness.sessions[0].state, 'starting');

		await harness.command.execute();
		assert.strictEqual(harness.sessions.length, 1);
		assert.strictEqual(harness.ensureCalls, 1);
		assert.strictEqual(harness.connectionCalls, 0);
		assert.strictEqual(harness.pairingCalls, 0);
		assert.strictEqual(harness.sessions[0].revealCalls, 1);

		installation.resolve(INSTALLATION_CREDENTIAL);
		await firstConnect;
		assert.strictEqual(harness.sessions.length, 1);
		assert.strictEqual(harness.pairingCalls, 1);
		harness.command.dispose();
	});

	test('Connect command reveals a waiting session without creating another pairing', async () => {
		const harness = createConnectCommandHarness();
		await harness.command.execute();
		const firstSession = harness.sessions[0];
		assert.strictEqual(firstSession.state, 'waiting');
		assert.strictEqual(harness.pairingCalls, 1);

		await harness.command.execute();
		assert.strictEqual(harness.sessions.length, 1);
		assert.strictEqual(harness.command.getActiveSession(), firstSession);
		assert.strictEqual(firstSession.revealCalls, 1);
		assert.strictEqual(harness.ensureCalls, 1);
		assert.strictEqual(harness.pairingCalls, 1);
		harness.command.dispose();
	});

	test('Command Palette Connect remains connect-only after a successful pairing', async () => {
		const harness = createConnectCommandHarness();
		await harness.command.execute();

		harness.sessions[0].emitConnected();
		harness.sessions[0].emitTerminal('connected');

		assert.strictEqual(harness.enabledAfterConnectCalls, 0);
		harness.command.dispose();
	});

	test('Command Palette Connect observes an already-connected Telegram without pairing or enabling alerts', async () => {
		const harness = createConnectCommandHarness({ getTelegramConnection: async () => true });

		await harness.command.execute();

		assert.strictEqual(harness.sessions.length, 1);
		assert.strictEqual(harness.pairingCalls, 0);
		assert.deepStrictEqual(harness.appliedStates, ['connected']);
		assert.strictEqual(harness.enabledAfterConnectCalls, 0);
		assert.deepStrictEqual(harness.messages, ['connected']);
		harness.command.dispose();
	});

	test('an enable-after-connect pairing enables alerts only after its normal connected terminal', async () => {
		const harness = createConnectCommandHarness();
		await harness.command.execute('enable-alerts-after-connect');

		const session = harness.sessions[0];
		session.emitConnected();
		assert.strictEqual(harness.enabledAfterConnectCalls, 0);
		session.emitTerminal('connected');

		assert.strictEqual(harness.enabledAfterConnectCalls, 1);
		harness.command.dispose();
	});

	test('an existing connect-only session upgrades monotonically to enable alerts', async () => {
		const harness = createConnectCommandHarness();
		await harness.command.execute();
		const session = harness.sessions[0];

		await harness.command.execute('enable-alerts-after-connect');
		await harness.command.execute('connect-only');
		assert.strictEqual(harness.sessions.length, 1);
		assert.strictEqual(harness.pairingCalls, 1);

		session.emitConnected();
		session.emitTerminal('connected');
		assert.strictEqual(harness.enabledAfterConnectCalls, 1);
		harness.command.dispose();
	});

	test('a status-bar enable request upgrades a starting session without duplicate registration or pairing', async () => {
		const installation = new Deferred<string>();
		const harness = createConnectCommandHarness({ ensureInstallation: () => installation.promise });
		const paletteConnect = harness.command.execute('connect-only');
		await settlePromises();

		await harness.command.execute('enable-alerts-after-connect');
		assert.strictEqual(harness.sessions.length, 1);
		assert.strictEqual(harness.ensureCalls, 1);
		assert.strictEqual(harness.connectionCalls, 0);
		assert.strictEqual(harness.pairingCalls, 0);

		installation.resolve(INSTALLATION_CREDENTIAL);
		await paletteConnect;
		assert.strictEqual(harness.pairingCalls, 1);
		harness.sessions[0].emitConnected();
		harness.sessions[0].emitTerminal('connected');
		assert.strictEqual(harness.enabledAfterConnectCalls, 1);
		harness.command.dispose();
	});

	test('a cancelled session can report late connection state without enabling alerts', async () => {
		const harness = createConnectCommandHarness();
		await harness.command.execute('enable-alerts-after-connect');
		const session = harness.sessions[0];

		session.emitTerminal('cancelled');
		session.emitConnected();

		assert.deepStrictEqual(harness.appliedStates, ['disconnected', 'connected']);
		assert.strictEqual(harness.enabledAfterConnectCalls, 0);
		harness.command.dispose();
	});

	test('Cancel preserves a late in-flight connection GET without enabling alerts', async () => {
		const lookup = new Deferred<boolean>();
		const harness = createConnectCommandHarness({ getTelegramConnection: () => lookup.promise });
		const connect = harness.command.execute('enable-alerts-after-connect');
		await settlePromises();
		const session = harness.sessions[0];

		session.emitTerminal('cancelled');
		lookup.resolve(true);
		await connect;

		assert.deepStrictEqual(harness.appliedStates, ['connected']);
		assert.strictEqual(harness.enabledAfterConnectCalls, 0);
		harness.command.dispose();
	});

	test('a newer connection-state owner prevents a stale connected terminal from enabling alerts', async () => {
		const harness = createConnectCommandHarness();
		await harness.command.execute('enable-alerts-after-connect');
		const session = harness.sessions[0];

		session.emitConnected();
		harness.applyExternalConnectionState('connected');
		session.emitTerminal('connected');

		assert.strictEqual(harness.enabledAfterConnectCalls, 0);
		harness.command.dispose();
	});

	test('an expired pairing never enables alerts', async () => {
		const harness = createConnectCommandHarness({
			createPairing: async () => futurePairing(99),
			now: () => 100,
		});

		await harness.command.execute('enable-alerts-after-connect');

		assert.strictEqual(harness.sessions.length, 1);
		assert.strictEqual(harness.sessions[0].state, 'cancelled');
		assert.strictEqual(harness.enabledAfterConnectCalls, 0);
		assert.strictEqual(harness.command.getActiveSession(), undefined);
		harness.command.dispose();
	});

	test('a stale old connected terminal cannot enable alerts after a newer Connect generation', async () => {
		const harness = createConnectCommandHarness();
		await harness.command.execute('enable-alerts-after-connect');
		const firstSession = harness.sessions[0];
		firstSession.emitTerminal('cancelled');

		await harness.command.execute('connect-only');
		const secondSession = harness.sessions[1];
		firstSession.emitConnected();
		firstSession.emitTerminal('connected');

		assert.strictEqual(harness.command.getActiveSession(), secondSession);
		assert.strictEqual(harness.enabledAfterConnectCalls, 0);
		harness.command.dispose();
	});

	test('stale connected observations cannot overwrite a newer Connect generation', async () => {
		const harness = createConnectCommandHarness();
		await harness.command.execute();
		const firstSession = harness.sessions[0];
		firstSession.emitTerminal('cancelled');

		await harness.command.execute();
		const secondSession = harness.sessions[1];
		assert.strictEqual(harness.command.getActiveSession(), secondSession);
		const statesBeforeStaleObservation = [...harness.appliedStates];
		const messagesBeforeStaleObservation = [...harness.messages];

		firstSession.emitConnected();
		assert.deepStrictEqual(harness.appliedStates, statesBeforeStaleObservation);
		assert.deepStrictEqual(harness.messages, messagesBeforeStaleObservation);
		assert.strictEqual(harness.command.getActiveSession(), secondSession);
		harness.command.dispose();
	});

	test('old terminal and disposal callbacks cannot clear or dispose a newer active session', async () => {
		const harness = createConnectCommandHarness();
		await harness.command.execute();
		const firstSession = harness.sessions[0];
		firstSession.emitTerminal('cancelled');

		await harness.command.execute();
		const secondSession = harness.sessions[1];
		assert.strictEqual(harness.command.getActiveSession(), secondSession);

		firstSession.emitTerminal('cancelled');
		firstSession.emitDisposed();
		assert.strictEqual(harness.command.getActiveSession(), secondSession);
		assert.strictEqual(secondSession.disposeCalls, 0);
		assert.strictEqual(secondSession.revealCalls, 0);
		harness.command.dispose();
	});
});
