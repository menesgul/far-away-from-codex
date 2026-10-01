import {
	FakeCredentialStore,
	INSTALLATION_CREDENTIAL,
} from '../helpers/credentials';
import {
	type TelegramConnectionClient,
	resolveTelegramConnectionState,
	statusBarText,
	canEnableAlerts,
} from '../../state/TelegramConnectionState';
import * as assert from 'assert';
import {
	BackendClient,
	InstallationCredentialRejectedError,
	BackendClientError,
} from '../../backend/BackendClient';
import { telegramConnectionResponse } from '../helpers/backendResponses';

suite('TelegramConnectionState', () => {
	test('connection-state resolution uses no backend request without a credential', async () => {
		const store = new FakeCredentialStore();
		let calls = 0;
		const client: TelegramConnectionClient = {
			getTelegramConnection: async () => {
				calls += 1;
				return true;
			},
		};

		assert.strictEqual(await resolveTelegramConnectionState(store, client), 'disconnected');
		assert.strictEqual(calls, 0);
	});

	test('connection-state resolution makes one GET and maps connected and disconnected responses', async () => {
		for (const expected of [true, false]) {
			const store = new FakeCredentialStore(INSTALLATION_CREDENTIAL);
			let calls = 0;
			const client: TelegramConnectionClient = {
				getTelegramConnection: async (credential) => {
					calls += 1;
					assert.strictEqual(credential, INSTALLATION_CREDENTIAL);
					return expected;
				},
			};

			assert.strictEqual(
				await resolveTelegramConnectionState(store, client),
				expected ? 'connected' : 'disconnected'
			);
			assert.strictEqual(calls, 1);
		}
	});

	test('connection-state resolution performs only the authoritative GET and never registers', async () => {
		const store = new FakeCredentialStore(INSTALLATION_CREDENTIAL);
		const requests: Array<{ method: string; path: string }> = [];
		const client = new BackendClient('https://backend.example', 1_000, async (url, init) => {
			const requestUrl = typeof url === 'string' || url instanceof URL ? url : url.url;
			requests.push({ method: init?.method ?? 'GET', path: new URL(requestUrl).pathname });
			return telegramConnectionResponse(true);
		});

		assert.strictEqual(await resolveTelegramConnectionState(store, client), 'connected');
		assert.deepStrictEqual(requests, [{ method: 'GET', path: '/v1/telegram-connection' }]);
	});

	test('connection-state resolution clears only definitively rejected credentials', async () => {
		const rejectedStore = new FakeCredentialStore(INSTALLATION_CREDENTIAL);
		const rejectedClient: TelegramConnectionClient = {
			getTelegramConnection: async () => {
				throw new InstallationCredentialRejectedError('rejected');
			},
		};
		assert.strictEqual(await resolveTelegramConnectionState(rejectedStore, rejectedClient), 'disconnected');
		assert.strictEqual(rejectedStore.credential, undefined);

		const transientStore = new FakeCredentialStore(INSTALLATION_CREDENTIAL);
		const transientClient: TelegramConnectionClient = {
			getTelegramConnection: async () => { throw new BackendClientError('unavailable'); },
		};
		assert.strictEqual(await resolveTelegramConnectionState(transientStore, transientClient), 'unknown');
		assert.strictEqual(transientStore.credential, INSTALLATION_CREDENTIAL);
	});

	test('connection-state resolution clears a syntactically invalid stored credential without a request', async () => {
		const store = new FakeCredentialStore('invalid credential');
		let requests = 0;
		const client = new BackendClient('https://backend.example', 1_000, async () => {
			requests += 1;
			return telegramConnectionResponse(true);
		});

		assert.strictEqual(await resolveTelegramConnectionState(store, client), 'disconnected');
		assert.strictEqual(store.credential, undefined);
		assert.strictEqual(requests, 0);
	});

	test('connection-state presentation enforces canonical status text and ON invariants', () => {
		assert.strictEqual(statusBarText('connected', false), '$(bell-slash) Codex Alerts: OFF · $(send) ✓');
		assert.strictEqual(statusBarText('connected', true), '$(bell) Codex Alerts: ON · $(send) ✓');
		assert.strictEqual(statusBarText('disconnected', true), '$(bell-slash) Codex Alerts: OFF · $(send) ✕');
		assert.strictEqual(statusBarText('unknown', true), '$(bell-slash) Codex Alerts: OFF · $(send) ?');
		assert.strictEqual(canEnableAlerts('connected'), true);
		assert.strictEqual(canEnableAlerts('disconnected'), false);
		assert.strictEqual(canEnableAlerts('unknown'), false);
	});
});
