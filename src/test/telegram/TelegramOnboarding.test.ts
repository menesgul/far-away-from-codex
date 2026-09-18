import {
	type TelegramOnboardingState,
	createTelegramOnboarding,
	type TelegramOnboarding,
	runTelegramActivationOnboarding,
	TELEGRAM_ONBOARDING_SHOWN_KEY,
} from '../../telegram/TelegramOnboarding';
import {
	Deferred,
	settlePromises,
} from '../helpers/async';
import {
	type TelegramConnectIntent,
	createTelegramConnectCommand,
} from '../../telegram/TelegramConnectCommand';
import { FakeConnectSession } from '../helpers/FakeConnectSession';
import {
	INSTALLATION_CREDENTIAL,
	FakeCredentialStore,
} from '../helpers/credentials';
import { futurePairing } from '../helpers/pairing';
import {
	type InstallationCredentialStore,
	BackendClientError,
	InstallationCredentialRejectedError,
	BackendClient,
} from '../../backend/BackendClient';
import {
	type TelegramConnectionClient,
	type TelegramConnectionState,
	resolveTelegramConnectionState,
} from '../../state/TelegramConnectionState';
import * as assert from 'assert';
import { createDisconnectCommandHarness } from '../helpers/createDisconnectCommandHarness';

class FakeOnboardingState implements TelegramOnboardingState {
	public readonly values = new Map<string, unknown>();
	public readonly updates: Array<{ section: string; value: unknown }> = [];
	public updateGate: Deferred<void> | undefined;

	public get<T>(section: string): T | undefined {
		return this.values.get(section) as T | undefined;
	}

	public async update(section: string, value: unknown): Promise<void> {
		this.updates.push({ section, value });
		await this.updateGate?.promise;
		this.values.set(section, value);
	}
}

function createOnboardingHarness(options: {
	selection?: string | undefined | Deferred<string | undefined>;
	globalState?: FakeOnboardingState;
} = {}) {
	const globalState = options.globalState ?? new FakeOnboardingState();
	let promptCalls = 0;
	const promptArguments: Array<[string, string, string]> = [];
	const connectIntents: TelegramConnectIntent[] = [];
	let connectDelegations = 0;
	let ensureCalls = 0;
	let connectionCalls = 0;
	let pairingCalls = 0;
	let alertsEnabled = false;
	let connectionStateRevision = 0;
	const sessions: FakeConnectSession[] = [];
	const connectFlow = createTelegramConnectCommand({
		client: {
			ensureInstallation: async () => {
				ensureCalls += 1;
				return INSTALLATION_CREDENTIAL;
			},
			getTelegramConnection: async () => {
				connectionCalls += 1;
				return false;
			},
			createPairing: async () => {
				pairingCalls += 1;
				return futurePairing(Date.now() + 60_000);
			},
		},
		store: new FakeCredentialStore(),
		createSession: (callbacks) => {
			const session = new FakeConnectSession(callbacks);
			sessions.push(session);
			return session;
		},
		applyConnectionState: () => { connectionStateRevision += 1; },
		enableAlertsAfterConnect: () => { alertsEnabled = true; },
		getConnectionStateRevision: () => connectionStateRevision,
		showConnected: () => undefined,
		showError: () => undefined,
		now: () => Date.now(),
	});
	const onboarding = createTelegramOnboarding({
		globalState,
		showPrompt: async (message, firstButton, secondButton) => {
			promptCalls += 1;
			promptArguments.push([message, firstButton, secondButton]);
			return options.selection instanceof Deferred
				? options.selection.promise
				: options.selection;
		},
		connectTelegram: async (intent) => {
				connectDelegations += 1;
				connectIntents.push(intent);
				await connectFlow.execute(intent);
			},
	});

	return {
		onboarding,
		globalState,
		get promptCalls() { return promptCalls; },
		get promptArguments() { return promptArguments; },
		get connectIntents() { return connectIntents; },
		get connectDelegations() { return connectDelegations; },
		get ensureCalls() { return ensureCalls; },
		get connectionCalls() { return connectionCalls; },
		get pairingCalls() { return pairingCalls; },
		get alertsEnabled() { return alertsEnabled; },
		sessions,
	};
}

async function runActivationOnboarding(
	store: InstallationCredentialStore,
	client: TelegramConnectionClient,
	onboarding: TelegramOnboarding,
): Promise<TelegramConnectionState> {
	let connectionState: TelegramConnectionState = 'unknown';
	await runTelegramActivationOnboarding({
		refreshConnectionState: async () => {
			connectionState = await resolveTelegramConnectionState(store, client);
		},
		getConnectionState: () => connectionState,
		onboarding,
	});
	return connectionState;
}

suite('TelegramOnboarding', () => {
	test('first activation without a credential shows the exact local prompt without invoking Connect', async () => {
		const harness = createOnboardingHarness();
		let lookupCalls = 0;
		const state = await runActivationOnboarding(new FakeCredentialStore(), {
			getTelegramConnection: async () => {
				lookupCalls += 1;
				return false;
			},
		}, harness.onboarding);

		assert.strictEqual(state, 'disconnected');
		assert.strictEqual(lookupCalls, 0);
		assert.strictEqual(harness.promptCalls, 1);
		assert.deepStrictEqual(harness.promptArguments, [[
			'Connect Telegram to receive Codex alerts on your phone.',
			'Connect Telegram',
			'Not now',
		]]);
		assert.deepStrictEqual(harness.globalState.updates, [{
			section: TELEGRAM_ONBOARDING_SHOWN_KEY,
			value: true,
		}]);
		assert.strictEqual(harness.connectDelegations, 0);
		assert.strictEqual(harness.ensureCalls, 0);
		assert.strictEqual(harness.connectionCalls, 0);
		assert.strictEqual(harness.pairingCalls, 0);
	});

	test('connected and unknown activation outcomes suppress onboarding', async () => {
		for (const lookup of [
			async () => true,
			async () => { throw new BackendClientError('unavailable'); },
		]) {
			const harness = createOnboardingHarness();
			const state = await runActivationOnboarding(
				new FakeCredentialStore(INSTALLATION_CREDENTIAL),
				{ getTelegramConnection: lookup },
				harness.onboarding
			);
			assert.ok(state === 'connected' || state === 'unknown');
			assert.strictEqual(harness.promptCalls, 0);
			assert.strictEqual(harness.connectDelegations, 0);
		}
	});

	test('activation shows onboarding only after its authoritative disconnected lookup', async () => {
		const lookup = new Deferred<boolean>();
		const harness = createOnboardingHarness();
		const activation = runActivationOnboarding(new FakeCredentialStore(INSTALLATION_CREDENTIAL), {
			getTelegramConnection: () => lookup.promise,
		}, harness.onboarding);

		await settlePromises();
		assert.strictEqual(harness.promptCalls, 0);
		lookup.resolve(false);
		assert.strictEqual(await activation, 'disconnected');
		assert.strictEqual(harness.promptCalls, 1);
	});

	test('rejected activation credential is recovered and may show onboarding with no extra GET', async () => {
		const store = new FakeCredentialStore(INSTALLATION_CREDENTIAL);
		const harness = createOnboardingHarness();
		let lookupCalls = 0;
		const state = await runActivationOnboarding(store, {
			getTelegramConnection: async () => {
				lookupCalls += 1;
				throw new InstallationCredentialRejectedError('rejected');
			},
		}, harness.onboarding);

		assert.strictEqual(state, 'disconnected');
		assert.strictEqual(store.credential, undefined);
		assert.strictEqual(lookupCalls, 1);
		assert.strictEqual(harness.promptCalls, 1);
	});

	test('Not now and dismissal do not invoke the production Connect flow', async () => {
		for (const selection of ['Not now', undefined]) {
			const harness = createOnboardingHarness({ selection });
			await harness.onboarding.maybeShow('disconnected');
			assert.strictEqual(harness.promptCalls, 1);
			assert.strictEqual(harness.connectDelegations, 0);
			assert.strictEqual(harness.ensureCalls, 0);
			assert.strictEqual(harness.connectionCalls, 0);
			assert.strictEqual(harness.pairingCalls, 0);
			assert.strictEqual(harness.globalState.get<boolean>(TELEGRAM_ONBOARDING_SHOWN_KEY), true);
		}
	});

	test('onboarding Connect Telegram invokes the production Connect seam once with connect-only intent', async () => {
		const harness = createOnboardingHarness({ selection: 'Connect Telegram' });

		await harness.onboarding.maybeShow('disconnected');

		assert.strictEqual(harness.connectDelegations, 1);
		assert.deepStrictEqual(harness.connectIntents, ['connect-only']);
		assert.strictEqual(harness.ensureCalls, 1);
		assert.strictEqual(harness.connectionCalls, 1);
		assert.strictEqual(harness.pairingCalls, 1);
		assert.strictEqual(harness.alertsEnabled, false);
		harness.sessions[0].emitConnected();
		harness.sessions[0].emitTerminal('connected');
		assert.strictEqual(harness.alertsEnabled, false);
	});

	test('a rejected onboarding dependency clears in-flight work so a later eligible attempt can proceed', async () => {
		const globalState = new FakeOnboardingState();
		let updateCalls = 0;
		let promptCalls = 0;
		const onboarding = createTelegramOnboarding({
			globalState: {
				get: <T>(section: string) => globalState.get<T>(section),
				update: async (section, value) => {
					updateCalls += 1;
					if (updateCalls === 1) {
						throw new Error('global state unavailable');
					}
					await globalState.update(section, value);
				},
			},
			showPrompt: async () => {
				promptCalls += 1;
				return undefined;
			},
			connectTelegram: async () => undefined,
		});

		await assert.rejects(onboarding.maybeShow('disconnected'), /global state unavailable/);
		await onboarding.maybeShow('disconnected');

		assert.strictEqual(updateCalls, 2);
		assert.strictEqual(promptCalls, 1);
		assert.strictEqual(globalState.get<boolean>(TELEGRAM_ONBOARDING_SHOWN_KEY), true);
	});

	test('concurrent onboarding checks share one prompt and never duplicate the Connect flow', async () => {
		const selection = new Deferred<string | undefined>();
		const harness = createOnboardingHarness({ selection });
		const first = harness.onboarding.maybeShow('disconnected');
		const second = harness.onboarding.maybeShow('disconnected');

		assert.strictEqual(first, second);
		await settlePromises();
		assert.strictEqual(harness.promptCalls, 1);
		selection.resolve('Connect Telegram');
		await first;
		assert.strictEqual(harness.connectDelegations, 1);
		assert.strictEqual(harness.ensureCalls, 1);
	});

	test('disposal during pending flag persistence prevents a stale prompt', async () => {
		const globalState = new FakeOnboardingState();
		const update = new Deferred<void>();
		globalState.updateGate = update;
		const harness = createOnboardingHarness({ globalState });
		const attempt = harness.onboarding.maybeShow('disconnected');

		assert.deepStrictEqual(globalState.updates, [{
			section: TELEGRAM_ONBOARDING_SHOWN_KEY,
			value: true,
		}]);
		assert.strictEqual(harness.promptCalls, 0);
		harness.onboarding.dispose();
		update.resolve();
		await attempt;
		assert.strictEqual(harness.promptCalls, 0);
		assert.strictEqual(harness.connectDelegations, 0);
	});

	test('disposal after prompt display prevents a late Connect Telegram result', async () => {
		const selection = new Deferred<string | undefined>();
		const harness = createOnboardingHarness({ selection });
		const attempt = harness.onboarding.maybeShow('disconnected');

		await settlePromises();
		assert.strictEqual(harness.promptCalls, 1);
		harness.onboarding.dispose();
		selection.resolve('Connect Telegram');
		await attempt;
		assert.strictEqual(harness.connectDelegations, 0);
		assert.strictEqual(harness.ensureCalls, 0);
	});

	test('shared globalState survives reload and Disconnect, reset, and revocation do not clear it', async () => {
		const globalState = new FakeOnboardingState();
		const first = createOnboardingHarness({ globalState });
		await runActivationOnboarding(new FakeCredentialStore(), {
			getTelegramConnection: async () => false,
		}, first.onboarding);
		assert.strictEqual(first.promptCalls, 1);

		const disconnect = createDisconnectCommandHarness({ connectionState: 'connected' });
		await disconnect.command.execute();
		const afterDisconnect = createOnboardingHarness({ globalState });
		await runActivationOnboarding(disconnect.store, {
			getTelegramConnection: async () => false,
		}, afterDisconnect.onboarding);
		assert.strictEqual(afterDisconnect.promptCalls, 0);

		const resetStore = new FakeCredentialStore(INSTALLATION_CREDENTIAL);
		const resetClient = new BackendClient(
			'https://backend.example',
			1_000,
			async () => new Response(null, { status: 204 })
		);
		await resetClient.resetInstallation(resetStore);
		const afterReset = createOnboardingHarness({ globalState });
		await runActivationOnboarding(resetStore, {
			getTelegramConnection: async () => false,
		}, afterReset.onboarding);
		assert.strictEqual(afterReset.promptCalls, 0);

		const revokedStore = new FakeCredentialStore(INSTALLATION_CREDENTIAL);
		const afterRevocation = createOnboardingHarness({ globalState });
		assert.strictEqual(await runActivationOnboarding(revokedStore, {
			getTelegramConnection: async () => { throw new InstallationCredentialRejectedError('revoked'); },
		}, afterRevocation.onboarding), 'disconnected');
		assert.strictEqual(afterRevocation.promptCalls, 0);

		const reload = createOnboardingHarness({ globalState });
		await runActivationOnboarding(new FakeCredentialStore(), {
			getTelegramConnection: async () => false,
		}, reload.onboarding);
		assert.strictEqual(globalState.get<boolean>(TELEGRAM_ONBOARDING_SHOWN_KEY), true);
		assert.strictEqual(reload.promptCalls, 0);
	});
});
