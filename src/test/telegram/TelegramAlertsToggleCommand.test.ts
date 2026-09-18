import { createTelegramAlertsToggleCommand } from '../../telegram/TelegramAlertsToggleCommand';
import * as assert from 'assert';

function createToggleCommandHarness(options: {
	connectionState: 'connected' | 'disconnected' | 'unknown';
	alertsEnabled?: boolean;
	refreshResult?: 'connected' | 'disconnected' | 'unknown';
	promptResult?: 'connect' | 'cancel' | undefined;
}): {
	command: () => Promise<void>;
	getConnectionState(): 'connected' | 'disconnected' | 'unknown';
	getAlertsEnabled(): boolean;
	readonly refreshCalls: number;
	readonly promptCalls: number;
	readonly connectIntents: string[];
} {
	let connectionState = options.connectionState;
	let alertsEnabled = options.alertsEnabled ?? false;
	let refreshCalls = 0;
	let promptCalls = 0;
	const connectIntents: string[] = [];
	const command = createTelegramAlertsToggleCommand({
		getConnectionState: () => connectionState,
		getAlertsEnabled: () => alertsEnabled,
		setAlertsEnabled: (enabled) => { alertsEnabled = enabled; },
		refreshConnectionState: async () => {
			refreshCalls += 1;
			connectionState = options.refreshResult ?? connectionState;
		},
		showDisconnectedPrompt: async () => {
			promptCalls += 1;
			return options.promptResult;
		},
		connectTelegram: async (intent) => { connectIntents.push(intent); },
	});

	return {
		command,
		getConnectionState: () => connectionState,
		getAlertsEnabled: () => alertsEnabled,
		get refreshCalls() { return refreshCalls; },
		get promptCalls() { return promptCalls; },
		get connectIntents() { return connectIntents; },
	};
}

suite('TelegramAlertsToggleCommand', () => {
	test('OFF connected status-bar click enables alerts', async () => {
		const harness = createToggleCommandHarness({ connectionState: 'connected' });

		await harness.command();

		assert.strictEqual(harness.getConnectionState(), 'connected');
		assert.strictEqual(harness.getAlertsEnabled(), true);
		assert.strictEqual(harness.refreshCalls, 0);
		assert.strictEqual(harness.promptCalls, 0);
		assert.deepStrictEqual(harness.connectIntents, []);
	});

	test('ON connected status-bar click disables alerts', async () => {
		const harness = createToggleCommandHarness({ connectionState: 'connected', alertsEnabled: true });

		await harness.command();

		assert.strictEqual(harness.getConnectionState(), 'connected');
		assert.strictEqual(harness.getAlertsEnabled(), false);
		assert.strictEqual(harness.refreshCalls, 0);
		assert.strictEqual(harness.promptCalls, 0);
		assert.deepStrictEqual(harness.connectIntents, []);
	});

	test('OFF disconnected status-bar click only offers Connect and performs no backend or pairing work', async () => {
		const harness = createToggleCommandHarness({ connectionState: 'disconnected' });

		await harness.command();

		assert.strictEqual(harness.getConnectionState(), 'disconnected');
		assert.strictEqual(harness.getAlertsEnabled(), false);
		assert.strictEqual(harness.refreshCalls, 0);
		assert.strictEqual(harness.promptCalls, 1);
		assert.deepStrictEqual(harness.connectIntents, []);
	});

	test('dismissing the OFF disconnected prompt is a local no-op and preserves lazy registration', async () => {
		const harness = createToggleCommandHarness({
			connectionState: 'disconnected',
			promptResult: 'cancel',
		});

		await harness.command();

		assert.strictEqual(harness.getConnectionState(), 'disconnected');
		assert.strictEqual(harness.getAlertsEnabled(), false);
		assert.strictEqual(harness.refreshCalls, 0);
		assert.strictEqual(harness.promptCalls, 1);
		assert.deepStrictEqual(harness.connectIntents, []);
	});

	test('OFF disconnected Connect CTA routes to the existing flow with enable-after-connect intent', async () => {
		const harness = createToggleCommandHarness({
			connectionState: 'disconnected',
			promptResult: 'connect',
		});

		await harness.command();

		assert.strictEqual(harness.refreshCalls, 0);
		assert.strictEqual(harness.promptCalls, 1);
		assert.deepStrictEqual(harness.connectIntents, ['enable-alerts-after-connect']);
	});

	test('OFF unknown status-bar retry renders connected but leaves alerts OFF until a second click', async () => {
		const harness = createToggleCommandHarness({
			connectionState: 'unknown',
			refreshResult: 'connected',
		});

		await harness.command();

		assert.strictEqual(harness.refreshCalls, 1);
		assert.strictEqual(harness.getConnectionState(), 'connected');
		assert.strictEqual(harness.getAlertsEnabled(), false);
		assert.strictEqual(harness.promptCalls, 0);
		assert.deepStrictEqual(harness.connectIntents, []);

		await harness.command();

		assert.strictEqual(harness.getAlertsEnabled(), true);
		assert.strictEqual(harness.refreshCalls, 1);
		assert.strictEqual(harness.promptCalls, 0);
	});

	test('OFF unknown status-bar retry renders disconnected without a same-click Connect prompt', async () => {
		const harness = createToggleCommandHarness({
			connectionState: 'unknown',
			refreshResult: 'disconnected',
			promptResult: 'cancel',
		});

		await harness.command();

		assert.strictEqual(harness.refreshCalls, 1);
		assert.strictEqual(harness.getConnectionState(), 'disconnected');
		assert.strictEqual(harness.getAlertsEnabled(), false);
		assert.strictEqual(harness.promptCalls, 0);
		assert.deepStrictEqual(harness.connectIntents, []);

		await harness.command();

		assert.strictEqual(harness.promptCalls, 1);
		assert.deepStrictEqual(harness.connectIntents, []);
	});

	test('OFF unknown status-bar retry stays unknown after a transient outcome and never creates pairing material', async () => {
		const harness = createToggleCommandHarness({
			connectionState: 'unknown',
			refreshResult: 'unknown',
		});

		await harness.command();

		assert.strictEqual(harness.refreshCalls, 1);
		assert.strictEqual(harness.getConnectionState(), 'unknown');
		assert.strictEqual(harness.getAlertsEnabled(), false);
		assert.strictEqual(harness.promptCalls, 0);
		assert.deepStrictEqual(harness.connectIntents, []);
	});

	test('OFF unknown rejected-credential recovery renders disconnected without a same-click Connect prompt', async () => {
		const harness = createToggleCommandHarness({
			connectionState: 'unknown',
			// resolveTelegramConnectionState maps a definitive credential rejection to disconnected.
			refreshResult: 'disconnected',
			promptResult: 'connect',
		});

		await harness.command();

		assert.strictEqual(harness.getConnectionState(), 'disconnected');
		assert.strictEqual(harness.getAlertsEnabled(), false);
		assert.strictEqual(harness.promptCalls, 0);
		assert.deepStrictEqual(harness.connectIntents, []);
	});
});
