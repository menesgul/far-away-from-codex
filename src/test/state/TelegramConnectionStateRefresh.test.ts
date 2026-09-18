import { createTelegramConnectCommand } from '../../telegram/TelegramConnectCommand';
import { Deferred } from '../helpers/async';
import {
	type TelegramConnectionState,
	canEnableAlerts,
	statusBarText,
} from '../../state/TelegramConnectionState';
import { FakeConnectSession } from '../helpers/FakeConnectSession';
import {
	INSTALLATION_CREDENTIAL,
	FakeCredentialStore,
} from '../helpers/credentials';
import { futurePairing } from '../helpers/pairing';
import { createTelegramConnectionStateRefresh } from '../../state/TelegramConnectionStateRefresh';
import * as assert from 'assert';

function createConnectionOrchestrationHarness(): {
	connect: ReturnType<typeof createTelegramConnectCommand>;
	refreshConnectionState(): Promise<void>;
	refreshResult: Deferred<TelegramConnectionState>;
	sessions: FakeConnectSession[];
	appliedStates: TelegramConnectionState[];
	getConnectionState(): TelegramConnectionState;
	getAlertsEnabled(): boolean;
	getConnectionStateRevision(): number;
	applyNewerState(state: TelegramConnectionState): void;
} {
	let connectionState: TelegramConnectionState = 'disconnected';
	let alertsEnabled = false;
	let connectionStateRevision = 0;
	const refreshResult = new Deferred<TelegramConnectionState>();
	const sessions: FakeConnectSession[] = [];
	const appliedStates: TelegramConnectionState[] = [];
	const applyConnectionState = (state: TelegramConnectionState) => {
		connectionStateRevision += 1;
		connectionState = state;
		appliedStates.push(state);
		if (!canEnableAlerts(state)) {
			alertsEnabled = false;
		}
	};
	const connect = createTelegramConnectCommand({
		client: {
			ensureInstallation: async () => INSTALLATION_CREDENTIAL,
			getTelegramConnection: async () => false,
			createPairing: async () => futurePairing(Date.now() + 60_000),
		},
		store: new FakeCredentialStore(),
		createSession: (callbacks) => {
			const session = new FakeConnectSession(callbacks);
			sessions.push(session);
			return session;
		},
		applyConnectionState,
		enableAlertsAfterConnect: () => {
			if (canEnableAlerts(connectionState)) {
				alertsEnabled = true;
			}
		},
		getConnectionStateRevision: () => connectionStateRevision,
		showConnected: () => undefined,
		showError: () => undefined,
		now: () => Date.now(),
	});
	const refreshConnectionState = createTelegramConnectionStateRefresh({
		resolveConnectionState: () => refreshResult.promise,
		beginAuthoritativeRefresh: () => {
			connectionStateRevision += 1;
			return connectionStateRevision;
		},
		getConnectionStateRevision: () => connectionStateRevision,
		applyConnectionState,
	});

	return {
		connect,
		refreshConnectionState,
		refreshResult,
		sessions,
		appliedStates,
		getConnectionState: () => connectionState,
		getAlertsEnabled: () => alertsEnabled,
		getConnectionStateRevision: () => connectionStateRevision,
		applyNewerState: applyConnectionState,
	};
}

suite('TelegramConnectionStateRefresh', () => {
	test('starting a newer authoritative refresh immediately fences an older enable pairing session', async () => {
		const harness = createConnectionOrchestrationHarness();
		await harness.connect.execute('enable-alerts-after-connect');
		const session = harness.sessions[0];
		const statesBeforeRefresh = [...harness.appliedStates];

		const refresh = harness.refreshConnectionState();
		const refreshRevision = harness.getConnectionStateRevision();
		session.emitConnected();
		session.emitTerminal('connected');

		assert.strictEqual(harness.getConnectionStateRevision(), refreshRevision);
		assert.deepStrictEqual(harness.appliedStates, statesBeforeRefresh);
		assert.strictEqual(harness.getConnectionState(), 'disconnected');
		assert.strictEqual(harness.getAlertsEnabled(), false);

		harness.refreshResult.resolve('connected');
		await refresh;
		assert.strictEqual(harness.getConnectionState(), 'connected');
		assert.strictEqual(harness.getAlertsEnabled(), false);
		harness.connect.dispose();
	});

	test('a newer refresh connected result controls state without stale-session auto-enable', async () => {
		const harness = createConnectionOrchestrationHarness();
		await harness.connect.execute('enable-alerts-after-connect');
		const refresh = harness.refreshConnectionState();

		harness.sessions[0].emitConnected();
		harness.sessions[0].emitTerminal('connected');
		harness.refreshResult.resolve('connected');
		await refresh;

		assert.strictEqual(harness.getConnectionState(), 'connected');
		assert.strictEqual(harness.getAlertsEnabled(), false);
		assert.strictEqual(statusBarText(harness.getConnectionState(), harness.getAlertsEnabled()),
			'$(bell-slash) Codex Alerts: OFF · $(send) ✓');
		harness.connect.dispose();
	});

	test('a newer refresh disconnected result cannot be overwritten by a stale pairing session', async () => {
		const harness = createConnectionOrchestrationHarness();
		await harness.connect.execute('enable-alerts-after-connect');
		const refresh = harness.refreshConnectionState();

		harness.sessions[0].emitConnected();
		harness.sessions[0].emitTerminal('connected');
		harness.refreshResult.resolve('disconnected');
		await refresh;

		assert.strictEqual(harness.getConnectionState(), 'disconnected');
		assert.strictEqual(harness.getAlertsEnabled(), false);
		assert.strictEqual(statusBarText(harness.getConnectionState(), harness.getAlertsEnabled()),
			'$(bell-slash) Codex Alerts: OFF · $(send) ✕');
		harness.connect.dispose();
	});

	test('a newer refresh unknown result keeps alerts OFF while a stale pairing settles', async () => {
		const harness = createConnectionOrchestrationHarness();
		await harness.connect.execute('enable-alerts-after-connect');
		const refresh = harness.refreshConnectionState();

		harness.sessions[0].emitConnected();
		harness.sessions[0].emitTerminal('connected');
		harness.refreshResult.resolve('unknown');
		await refresh;

		assert.strictEqual(harness.getConnectionState(), 'unknown');
		assert.strictEqual(harness.getAlertsEnabled(), false);
		assert.strictEqual(statusBarText(harness.getConnectionState(), harness.getAlertsEnabled()),
			'$(bell-slash) Codex Alerts: OFF · $(send) ?');
		harness.connect.dispose();
	});

	test('an old refresh result cannot overwrite a newer authoritative connection mutation', async () => {
		const harness = createConnectionOrchestrationHarness();
		const refresh = harness.refreshConnectionState();
		harness.applyNewerState('connected');

		harness.refreshResult.resolve('disconnected');
		await refresh;

		assert.strictEqual(harness.getConnectionState(), 'connected');
		assert.strictEqual(harness.getAlertsEnabled(), false);
	});
});
