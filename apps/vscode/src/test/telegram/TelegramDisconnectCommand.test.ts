import {
	type TelegramConnectionState,
	canEnableAlerts,
} from '../../state/TelegramConnectionState';
import { FakeConnectSession } from '../helpers/FakeConnectSession';
import {
	FakeCredentialStore,
	INSTALLATION_CREDENTIAL,
} from '../helpers/credentials';
import { createTelegramConnectCommand } from '../../telegram/TelegramConnectCommand';
import { futurePairing } from '../helpers/pairing';
import { createTelegramDisconnectCommand } from '../../telegram/TelegramDisconnectCommand';
import {
	InstallationCredentialRejectedError,
	BackendClientError,
	BackendClient,
} from '../../backend/BackendClient';
import {
	Deferred,
	settlePromises,
} from '../helpers/async';
import { createDisconnectCommandHarness } from '../helpers/createDisconnectCommandHarness';
import * as assert from 'assert';
import { createTelegramConnectionStateRefresh } from '../../state/TelegramConnectionStateRefresh';

function createDisconnectPairingRaceHarness(disconnectTelegram: () => Promise<void>) {
	let connectionState: TelegramConnectionState = 'connected';
	let alertsEnabled = true;
	let connectionStateRevision = 0;
	const sessions: FakeConnectSession[] = [];
	const store = new FakeCredentialStore(INSTALLATION_CREDENTIAL);
	const applyConnectionState = (state: TelegramConnectionState) => {
		connectionStateRevision += 1;
		connectionState = state;
		if (!canEnableAlerts(state)) {
			alertsEnabled = false;
		}
	};
	const connectFlow = createTelegramConnectCommand({
		client: {
			ensureInstallation: async () => INSTALLATION_CREDENTIAL,
			getTelegramConnection: async () => false,
			createPairing: async () => futurePairing(Date.now() + 60_000),
		},
		store,
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
	const disconnect = createTelegramDisconnectCommand({
		client: { disconnectTelegram: async () => disconnectTelegram() },
		store,
		getConnectionState: () => connectionState,
		beginAuthoritativeDisconnect: () => ++connectionStateRevision,
		getConnectionStateRevision: () => connectionStateRevision,
		applyConnectionState,
		forceAlertsOff: () => { alertsEnabled = false; },
		cancelActivePairingSession: () => connectFlow.cancelActiveSession(),
		isCredentialRejected: (error) => error instanceof InstallationCredentialRejectedError,
		recoverRejectedCredential: () => store.deleteInstallationCredential(),
		showDisconnected: () => undefined,
		showAlreadyDisconnected: () => undefined,
		showError: () => undefined,
	});

	return {
		connectFlow,
		disconnect,
		sessions,
		markConnectedWithAlerts: () => {
			applyConnectionState('connected');
			alertsEnabled = true;
		},
		beginAuthoritativeMutation: () => ++connectionStateRevision,
		getConnectionStateRevision: () => connectionStateRevision,
		applyConnectionState,
		getConnectionState: () => connectionState,
		getAlertsEnabled: () => alertsEnabled,
	};
}

suite('TelegramDisconnectCommand', () => {
	test('Disconnect immediately fences pairing authority, cancels it, forces alerts OFF, and renders unknown in flight', async () => {
		const deleteResult = new Deferred<void>();
		const harness = createDisconnectCommandHarness({
			disconnectTelegram: () => deleteResult.promise,
		});

		const disconnect = harness.command.execute();
		await settlePromises();

		assert.strictEqual(harness.getConnectionState(), 'unknown');
		assert.strictEqual(harness.getAlertsEnabled(), false);
		assert.strictEqual(harness.cancelActivePairingSessionCalls, 1);
		assert.strictEqual(harness.disconnectCalls, 1);
		assert.ok(harness.snapshots.every(({ state, alertsEnabled }) =>
			!alertsEnabled || state === 'connected'
		));

		deleteResult.resolve();
		await disconnect;
	});

	test('Disconnect success is confirmed OFF disconnected, retains the installation credential, and reports it once', async () => {
		const harness = createDisconnectCommandHarness();

		await harness.command.execute();

		assert.strictEqual(harness.getConnectionState(), 'disconnected');
		assert.strictEqual(harness.getAlertsEnabled(), false);
		assert.strictEqual(harness.store.credential, INSTALLATION_CREDENTIAL);
		assert.deepStrictEqual(harness.appliedStates, ['unknown', 'disconnected']);
		assert.deepStrictEqual(harness.messages, ['disconnected']);
	});

	test('Disconnect timeout, network, and 5xx outcomes stay unknown and retain the installation credential', async () => {
		for (const failure of [
			new BackendClientError('The backend request timed out.'),
			new BackendClientError('Could not reach the Far Away From Codex backend.'),
			new BackendClientError('The backend responded with status 503.'),
		]) {
			const harness = createDisconnectCommandHarness({
				disconnectTelegram: async () => { throw failure; },
			});

			await harness.command.execute();

			assert.strictEqual(harness.getConnectionState(), 'unknown');
			assert.strictEqual(harness.getAlertsEnabled(), false);
			assert.strictEqual(harness.store.credential, INSTALLATION_CREDENTIAL);
			assert.deepStrictEqual(harness.appliedStates, ['unknown']);
			assert.deepStrictEqual(harness.messages, ['Could not confirm whether Telegram was disconnected.']);
		}
	});

	test('Disconnect definitively rejected credential clears stale local identity without claiming Telegram was disconnected', async () => {
		const harness = createDisconnectCommandHarness({
			disconnectTelegram: async () => {
				throw new InstallationCredentialRejectedError('The anonymous installation credential was rejected.');
			},
		});

		await harness.command.execute();

		assert.strictEqual(harness.getConnectionState(), 'disconnected');
		assert.strictEqual(harness.getAlertsEnabled(), false);
		assert.strictEqual(harness.store.credential, undefined);
		assert.strictEqual(harness.recoverRejectedCredentialCalls, 1);
		assert.deepStrictEqual(harness.messages, ['The anonymous installation credential was rejected.']);
		assert.strictEqual(harness.messages.includes('disconnected'), false);
	});

	test('Disconnect treats a syntactically invalid stored credential as rejected without sending DELETE', async () => {
		let deleteRequests = 0;
		const backendClient = new BackendClient(
			'https://backend.example',
			1_000,
			async () => {
				deleteRequests += 1;
				return new Response(null, { status: 204 });
			}
		);
		const harness = createDisconnectCommandHarness({
			credential: 'invalid credential',
			disconnectTelegram: (credential) => backendClient.disconnectTelegram(credential),
		});

		await harness.command.execute();

		assert.strictEqual(deleteRequests, 0);
		assert.strictEqual(harness.store.credential, undefined);
		assert.strictEqual(harness.getConnectionState(), 'disconnected');
		assert.strictEqual(harness.getAlertsEnabled(), false);
		assert.deepStrictEqual(harness.appliedStates, ['unknown', 'disconnected']);
		assert.deepStrictEqual(harness.messages, ['The anonymous installation credential was rejected.']);
		assert.strictEqual(harness.messages.includes('Could not confirm whether Telegram was disconnected.'), false);
	});

	test('double Disconnect shares one DELETE, one authority fence, and one terminal message', async () => {
		const deleteResult = new Deferred<void>();
		const harness = createDisconnectCommandHarness({ disconnectTelegram: () => deleteResult.promise });

		const first = harness.command.execute();
		const second = harness.command.execute();
		assert.strictEqual(first, second);
		await settlePromises();
		assert.strictEqual(harness.disconnectCalls, 1);
		assert.strictEqual(harness.cancelActivePairingSessionCalls, 1);
		assert.strictEqual(harness.getConnectionStateRevision(), 2);

		deleteResult.resolve();
		await first;
		assert.deepStrictEqual(harness.messages, ['disconnected']);
	});

	test('Disconnect is a zero-DELETE safe informational local no-op when already verified disconnected', async () => {
		const harness = createDisconnectCommandHarness({
			connectionState: 'disconnected',
			alertsEnabled: false,
		});

		await harness.command.execute();

		assert.strictEqual(harness.disconnectCalls, 0);
		assert.strictEqual(harness.getConnectionState(), 'disconnected');
		assert.deepStrictEqual(harness.messages, ['already-disconnected']);
	});

	test('Disconnect from unknown state is allowed to issue a new DELETE', async () => {
		const harness = createDisconnectCommandHarness({
			connectionState: 'unknown',
			alertsEnabled: false,
		});

		await harness.command.execute();

		assert.strictEqual(harness.disconnectCalls, 1);
		assert.strictEqual(harness.getConnectionState(), 'disconnected');
	});

	test('an old refresh cannot overwrite a successful Disconnect', async () => {
		const refreshResult = new Deferred<TelegramConnectionState>();
		const harness = createDisconnectCommandHarness();
		const refresh = createTelegramConnectionStateRefresh({
			resolveConnectionState: () => refreshResult.promise,
			beginAuthoritativeRefresh: harness.beginAuthoritativeMutation,
			getConnectionStateRevision: harness.getConnectionStateRevision,
			applyConnectionState: harness.applyConnectionState,
		})();

		await harness.command.execute();
		refreshResult.resolve('connected');
		await refresh;

		assert.strictEqual(harness.getConnectionState(), 'disconnected');
		assert.strictEqual(harness.getAlertsEnabled(), false);
	});

	test('Disconnect cancels an active pairing and stale connected callbacks cannot overwrite its success', async () => {
		const harness = createDisconnectPairingRaceHarness(async () => undefined);
		await harness.connectFlow.execute('enable-alerts-after-connect');
		harness.markConnectedWithAlerts();

		await harness.disconnect.execute();
		harness.sessions[0].emitConnected();
		harness.sessions[0].emitTerminal('connected');
		harness.sessions[0].emitDisposed();

		assert.strictEqual(harness.connectFlow.getActiveSession(), undefined);
		assert.strictEqual(harness.sessions[0].cancelCalls, 1);
		assert.strictEqual(harness.getConnectionState(), 'disconnected');
		assert.strictEqual(harness.getAlertsEnabled(), false);
	});

	test('uncertain Disconnect cannot be overwritten by a stale callback, and a later authoritative GET may resolve it', async () => {
		const deleteResult = new Deferred<void>();
		const pairingHarness = createDisconnectPairingRaceHarness(() => deleteResult.promise);
		await pairingHarness.connectFlow.execute('enable-alerts-after-connect');
		pairingHarness.markConnectedWithAlerts();
		const disconnect = pairingHarness.disconnect.execute();
		await settlePromises();
		deleteResult.reject(new BackendClientError('lost response'));
		await disconnect;
		pairingHarness.sessions[0].emitConnected();
		pairingHarness.sessions[0].emitTerminal('connected');
		pairingHarness.sessions[0].emitDisposed();
		assert.strictEqual(pairingHarness.getConnectionState(), 'unknown');
		assert.strictEqual(pairingHarness.getAlertsEnabled(), false);

		const resolveResult = new Deferred<TelegramConnectionState>();
		const refresh = createTelegramConnectionStateRefresh({
			resolveConnectionState: () => resolveResult.promise,
			beginAuthoritativeRefresh: pairingHarness.beginAuthoritativeMutation,
			getConnectionStateRevision: pairingHarness.getConnectionStateRevision,
			applyConnectionState: pairingHarness.applyConnectionState,
		})();
		resolveResult.resolve('connected');
		await refresh;
		assert.strictEqual(pairingHarness.getConnectionState(), 'connected');
		assert.strictEqual(pairingHarness.getAlertsEnabled(), false);
	});

	test('a retry after uncertain Disconnect issues a new DELETE and can confirm disconnected', async () => {
		let attempts = 0;
		const harness = createDisconnectCommandHarness({
			disconnectTelegram: async () => {
				attempts += 1;
				if (attempts === 1) {
					throw new BackendClientError('lost response');
				}
			},
		});

		await harness.command.execute();
		assert.strictEqual(harness.getConnectionState(), 'unknown');
		await harness.command.execute();

		assert.strictEqual(harness.disconnectCalls, 2);
		assert.strictEqual(harness.getConnectionState(), 'disconnected');
		assert.strictEqual(harness.getAlertsEnabled(), false);
		assert.ok(harness.snapshots.every(({ state, alertsEnabled }) =>
			!alertsEnabled || state === 'connected'
		));
	});
});
