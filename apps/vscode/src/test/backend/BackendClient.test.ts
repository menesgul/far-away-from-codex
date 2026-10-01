import {
	INSTALLATION_CREDENTIAL,
	FakeCredentialStore,
} from '../helpers/credentials';
import { PAIRING_ID } from '../helpers/pairing';
import {
	BackendClient,
	BackendClientError,
	TelegramAlreadyConnectedError,
	InstallationCredentialRejectedError,
} from '../../backend/BackendClient';
import * as assert from 'assert';
import { telegramConnectionResponse } from '../helpers/backendResponses';

const FRESH_INSTALLATION_CREDENTIAL = 'freshinstallationcredential0123456789_ABCDEF';

const PAIRING_EXPIRES_AT = '2030-01-02T03:04:05.000Z';

function registrationResponse(): Response {
	return new Response(JSON.stringify({ installationCredential: INSTALLATION_CREDENTIAL }), {
		status: 201,
		headers: { 'Content-Type': 'application/json' },
	});
}

function pairingResponse(): Response {
	return new Response(JSON.stringify({
		pairingId: PAIRING_ID,
		telegramUrl: 'https://t.me/far_away_bot?start=opaque-token',
		expiresAt: PAIRING_EXPIRES_AT,
	}), {
		status: 201,
		headers: { 'Content-Type': 'application/json' },
	});
}

suite('BackendClient', () => {
	test('constructing BackendClient does not register an installation', () => {
		let requestCount = 0;
		void new BackendClient('https://backend.example', 1_000, async () => {
			requestCount += 1;
			return registrationResponse();
		});

		assert.strictEqual(requestCount, 0);
	});

	test('lazy installation registration stores and reuses one credential', async () => {
		const store = new FakeCredentialStore();
		const requests: string[] = [];
		const request = (async (input: string | URL | Request) => {
			requests.push(input.toString());
			return registrationResponse();
		}) as typeof fetch;
		const client = new BackendClient('https://backend.example', 1_000, request);

		const firstCredential = await client.ensureInstallation(store);
		const secondCredential = await client.ensureInstallation(store);

		assert.strictEqual(firstCredential, INSTALLATION_CREDENTIAL);
		assert.strictEqual(secondCredential, INSTALLATION_CREDENTIAL);
		assert.strictEqual(store.credential, INSTALLATION_CREDENTIAL);
		assert.deepStrictEqual(requests, ['https://backend.example/v1/installations']);
	});

	test('an existing installation credential prevents registration', async () => {
		const store = new FakeCredentialStore(INSTALLATION_CREDENTIAL);
		let requestCount = 0;
		const client = new BackendClient('https://backend.example', 1_000, async () => {
			requestCount += 1;
			return registrationResponse();
		});

		assert.strictEqual(await client.ensureInstallation(store), INSTALLATION_CREDENTIAL);
		assert.strictEqual(requestCount, 0);
	});

	test('registration timeout is bounded and does not store a credential', async () => {
		const store = new FakeCredentialStore();
		const client = new BackendClient(
			'https://backend.example',
			5,
			async (_input, init) => new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
			})
		);

		await assert.rejects(
			client.ensureInstallation(store),
			(error: unknown) => error instanceof BackendClientError && /timed out/.test(error.message)
		);
		assert.strictEqual(store.credential, undefined);
	});

	test('reset authenticates through the backend and deletes the local credential after success', async () => {
		const store = new FakeCredentialStore(INSTALLATION_CREDENTIAL);
		let method: string | undefined;
		let authorization: string | undefined;
		const request = (async (_input: string | URL | Request, init?: RequestInit) => {
			method = init?.method;
			authorization = new Headers(init?.headers).get('Authorization') ?? undefined;
			return new Response(null, { status: 204 });
		}) as typeof fetch;
		const client = new BackendClient('https://backend.example', 1_000, request);

		await client.resetInstallation(store);

		assert.strictEqual(method, 'DELETE');
		assert.strictEqual(authorization, `Bearer ${INSTALLATION_CREDENTIAL}`);
		assert.strictEqual(store.credential, undefined);
	});

	test('a timed-out reset still clears the local credential', async () => {
		const store = new FakeCredentialStore(INSTALLATION_CREDENTIAL);
		const client = new BackendClient(
			'https://backend.example',
			5,
			async (_input, init) => new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new Error('lost response')));
			})
		);

		await assert.rejects(
			client.resetInstallation(store),
			(error: unknown) => error instanceof BackendClientError && /timed out/.test(error.message)
		);
		assert.strictEqual(store.credential, undefined);
	});

	test('a rejected reset response still clears the local credential', async () => {
		const store = new FakeCredentialStore(INSTALLATION_CREDENTIAL);
		const client = new BackendClient(
			'https://backend.example',
			1_000,
			async () => new Response(null, { status: 401 })
		);

		await assert.rejects(
			client.resetInstallation(store),
			(error: unknown) => error instanceof BackendClientError && /rejected/.test(error.message)
		);
		assert.strictEqual(store.credential, undefined);
	});

	test('an ambiguous reset allows the next installation registration to start fresh', async () => {
		const store = new FakeCredentialStore(INSTALLATION_CREDENTIAL);
		const methods: string[] = [];
		const request = (async (_input: string | URL | Request, init?: RequestInit) => {
			methods.push(init?.method ?? 'GET');
			if (init?.method === 'DELETE') {
				return new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener('abort', () => reject(new Error('lost response')));
				});
			}

			return new Response(JSON.stringify({ installationCredential: FRESH_INSTALLATION_CREDENTIAL }), {
				status: 201,
				headers: { 'Content-Type': 'application/json' },
			});
		}) as typeof fetch;
		const client = new BackendClient('https://backend.example', 5, request);

		await assert.rejects(client.resetInstallation(store), BackendClientError);
		assert.strictEqual(await client.ensureInstallation(store), FRESH_INSTALLATION_CREDENTIAL);
		assert.strictEqual(store.credential, FRESH_INSTALLATION_CREDENTIAL);
		assert.deepStrictEqual(methods, ['DELETE', 'POST']);
	});

	test('createPairing authenticates and validates the backend pairing response', async () => {
		let method: string | undefined;
		let authorization: string | undefined;
		let requestPath: string | undefined;
		const request = (async (input: string | URL | Request, init?: RequestInit) => {
			method = init?.method;
			authorization = new Headers(init?.headers).get('Authorization') ?? undefined;
			requestPath = new URL(input.toString()).pathname;
			return pairingResponse();
		}) as typeof fetch;
		const client = new BackendClient('https://backend.example', 1_000, request);

		const pairing = await client.createPairing(INSTALLATION_CREDENTIAL);

		assert.strictEqual(method, 'POST');
		assert.strictEqual(requestPath, '/v1/pairings');
		assert.strictEqual(authorization, `Bearer ${INSTALLATION_CREDENTIAL}`);
		assert.strictEqual(pairing.pairingId, PAIRING_ID);
		assert.strictEqual(pairing.telegramUrl, 'https://t.me/far_away_bot?start=opaque-token');
		assert.strictEqual(pairing.expiresAt.toISOString(), PAIRING_EXPIRES_AT);
	});

	test('createPairing rejects a backend response with a non-Telegram deep link', async () => {
		const client = new BackendClient(
			'https://backend.example',
			1_000,
			async () => new Response(JSON.stringify({
				pairingId: PAIRING_ID,
				telegramUrl: 'https://example.test/not-telegram',
				expiresAt: PAIRING_EXPIRES_AT,
			}), { status: 201 })
		);

		await assert.rejects(
			client.createPairing(INSTALLATION_CREDENTIAL),
			(error: unknown) => error instanceof BackendClientError && /invalid pairing response/.test(error.message)
		);
	});

	test('createPairing classifies the documented already-connected response', async () => {
		const client = new BackendClient(
			'https://backend.example',
			1_000,
			async () => new Response(JSON.stringify({ error: { code: 'ALREADY_CONNECTED' } }), { status: 409 })
		);

		await assert.rejects(
			client.createPairing(INSTALLATION_CREDENTIAL),
			TelegramAlreadyConnectedError
		);
	});

	test('getPairingStatus authenticates and accepts only documented statuses', async () => {
		let requestPath: string | undefined;
		let authorization: string | undefined;
		const client = new BackendClient(
			'https://backend.example',
			1_000,
			async (input, init) => {
				requestPath = new URL(input.toString()).pathname;
				authorization = new Headers(init?.headers).get('Authorization') ?? undefined;
				return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
			}
		);

		assert.strictEqual(await client.getPairingStatus(INSTALLATION_CREDENTIAL, PAIRING_ID), 'pending');
		assert.strictEqual(requestPath, `/v1/pairings/${PAIRING_ID}`);
		assert.strictEqual(authorization, `Bearer ${INSTALLATION_CREDENTIAL}`);
	});

	test('getPairingStatus rejects undocumented statuses', async () => {
		const client = new BackendClient(
			'https://backend.example',
			1_000,
			async () => new Response(JSON.stringify({ status: 'unknown' }), { status: 200 })
		);

		await assert.rejects(
			client.getPairingStatus(INSTALLATION_CREDENTIAL, PAIRING_ID),
			(error: unknown) => error instanceof BackendClientError && /invalid pairing status/.test(error.message)
		);
	});

	test('getTelegramConnection authenticates GET requests and accepts exact boolean responses', async () => {
		const paths: string[] = [];
		const authorizations: string[] = [];
		const client = new BackendClient(
			'https://backend.example',
			1_000,
			async (input, init) => {
				paths.push(new URL(input.toString()).pathname);
				authorizations.push(new Headers(init?.headers).get('Authorization') ?? '');
				return telegramConnectionResponse(paths.length === 1);
			}
		);

		assert.strictEqual(await client.getTelegramConnection(INSTALLATION_CREDENTIAL), true);
		assert.strictEqual(await client.getTelegramConnection(INSTALLATION_CREDENTIAL), false);
		assert.deepStrictEqual(paths, ['/v1/telegram-connection', '/v1/telegram-connection']);
		assert.deepStrictEqual(authorizations, [
			`Bearer ${INSTALLATION_CREDENTIAL}`,
			`Bearer ${INSTALLATION_CREDENTIAL}`,
		]);
	});

	test('getTelegramConnection rejects malformed and extra-field responses', async () => {
		for (const body of [{ connected: 'true' }, { connected: true, extra: 'unexpected' }]) {
			const client = new BackendClient(
				'https://backend.example',
				1_000,
				async () => new Response(JSON.stringify(body), { status: 200 })
			);

			await assert.rejects(
				client.getTelegramConnection(INSTALLATION_CREDENTIAL),
				(error: unknown) => error instanceof BackendClientError
					&& !(error instanceof InstallationCredentialRejectedError)
			);
		}
	});

	test('getTelegramConnection classifies backend 401 as a rejected installation credential', async () => {
		const client = new BackendClient(
			'https://backend.example',
			1_000,
			async () => new Response(null, { status: 401 })
		);

		await assert.rejects(
			client.getTelegramConnection(INSTALLATION_CREDENTIAL),
			InstallationCredentialRejectedError
		);
	});

	test('getTelegramConnection keeps timeout, network, and backend failures distinct from credential rejection', async () => {
		const failureRequests: Array<typeof fetch> = [
			async () => new Response(null, { status: 429 }),
			async () => new Response(null, { status: 503 }),
			async () => { throw new Error('network unavailable'); },
		];

		for (const request of failureRequests) {
			const client = new BackendClient('https://backend.example', 1_000, request);
			await assert.rejects(
				client.getTelegramConnection(INSTALLATION_CREDENTIAL),
				(error: unknown) => error instanceof BackendClientError
					&& !(error instanceof InstallationCredentialRejectedError)
			);
		}

		const timeoutClient = new BackendClient(
			'https://backend.example',
			5,
			async (_input, init) => new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
			})
		);
		await assert.rejects(
			timeoutClient.getTelegramConnection(INSTALLATION_CREDENTIAL),
			(error: unknown) => error instanceof BackendClientError
				&& !(error instanceof InstallationCredentialRejectedError)
		);
	});

	test('disconnectTelegram sends an authenticated delete without clearing the installation credential', async () => {
		let method: string | undefined;
		let authorization: string | undefined;
		const client = new BackendClient(
			'https://backend.example',
			1_000,
			async (_input, init) => {
				method = init?.method;
				authorization = new Headers(init?.headers).get('Authorization') ?? undefined;
				return new Response(null, { status: 204 });
			}
		);

		await client.disconnectTelegram(INSTALLATION_CREDENTIAL);

		assert.strictEqual(method, 'DELETE');
		assert.strictEqual(authorization, `Bearer ${INSTALLATION_CREDENTIAL}`);
	});
});
