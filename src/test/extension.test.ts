import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { createTelegramPairingAndStartPolling } from '../extension';
import {
	BackendClient,
	BackendClientError,
	InstallationCredentialRejectedError,
	type InstallationCredentialStore,
} from '../backend/BackendClient';
import { SecretStore } from '../state/SecretStore';
import {
	canEnableAlerts,
	resolveTelegramConnectionState,
	statusBarText,
	type TelegramConnectionClient,
} from '../state/TelegramConnectionState';
import {
	generateTelegramPairingQrDataUri,
	renderTelegramPairingHtml,
} from '../ui/TelegramPairingPanel';

const INSTALLATION_CREDENTIAL = 'abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF';
const FRESH_INSTALLATION_CREDENTIAL = 'freshinstallationcredential0123456789_ABCDEF';
const PAIRING_ID = 'pairing_123';
const PAIRING_EXPIRES_AT = '2030-01-02T03:04:05.000Z';

class FakeCredentialStore implements InstallationCredentialStore {
	public constructor(public credential?: string) {}

	public async getInstallationCredential(): Promise<string | undefined> {
		return this.credential;
	}

	public async saveInstallationCredential(credential: string): Promise<void> {
		this.credential = credential;
	}

	public async deleteInstallationCredential(): Promise<void> {
		this.credential = undefined;
	}
}

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

function telegramConnectionResponse(connected: boolean, extra: Record<string, unknown> = {}): Response {
	return new Response(JSON.stringify({ connected, ...extra }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

function readTypeScriptFiles(directory: string): string[] {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'test') {
				return [];
			}

			return readTypeScriptFiles(entryPath);
		}

		return entry.name.endsWith('.ts') ? [entryPath] : [];
	});
}

suite('Extension Test Suite', () => {
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

	test('SecretStore persists only the anonymous installation credential key', async () => {
		const storedValues = new Map<string, string>();
		const storage = {
			get: async (key: string) => storedValues.get(key),
			store: async (key: string, value: string) => {
				storedValues.set(key, value);
			},
			delete: async (key: string) => {
				storedValues.delete(key);
			},
		} as unknown as vscode.SecretStorage;
		const store = new SecretStore(storage);

		await store.saveInstallationCredential(INSTALLATION_CREDENTIAL);

		assert.strictEqual(await store.getInstallationCredential(), INSTALLATION_CREDENTIAL);
		assert.deepStrictEqual([...storedValues.keys()], ['farAway.installationCredential']);
		assert.strictEqual(storedValues.has(['telegram', 'botToken'].join('.')), false);
		assert.strictEqual(storedValues.has(['telegram', 'chatId'].join('.')), false);
	});

	test('extension source contains no direct Telegram API or client credential path', () => {
		const sourceRoot = path.resolve(__dirname, '../../src');
		const sourceFiles = readTypeScriptFiles(sourceRoot);
		const combinedSource = sourceFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

		assert.strictEqual(sourceFiles.some((file) => file.endsWith(`Telegram${'Client.ts'}`)), false);
		assert.strictEqual(combinedSource.includes(['api', 'telegram', 'org'].join('.')), false);
		assert.strictEqual(combinedSource.includes(['telegram', 'botToken'].join('.')), false);
		assert.strictEqual(combinedSource.includes(['telegram', 'chatId'].join('.')), false);
	});

	test('Telegram pairing QR is generated locally as an SVG data URI', async () => {
		const telegramUrl = 'https://t.me/far_away_bot?start=opaque-token';
		const qrDataUri = await generateTelegramPairingQrDataUri(telegramUrl);

		assert.ok(qrDataUri.startsWith('data:image/svg+xml;base64,'));
		const svg = Buffer.from(qrDataUri.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
		assert.ok(svg.startsWith('<svg'));
		assert.ok(svg.includes('viewBox='));
	});

	test('Telegram pairing HTML safely renders a local QR image without exposing the pairing URL', async () => {
		const telegramUrl = 'https://t.me/far_away_bot?start=opaque-token';
		const html = renderTelegramPairingHtml(await generateTelegramPairingQrDataUri(telegramUrl), 'test-nonce');

		assert.ok(html.includes('<img class="qr-code"'));
		assert.strictEqual(html.includes('<svg'), false);
		assert.ok(html.includes("default-src 'none'"));
		assert.ok(html.includes('img-src data:'));
		assert.ok(html.includes("style-src 'nonce-test-nonce'"));
		assert.strictEqual(html.includes('http://'), false);
		assert.strictEqual(html.includes('https://'), false);
		assert.strictEqual(html.includes(telegramUrl), false);
		assert.strictEqual(html.includes('opaque-token'), false);
	});

	test('Connect creates a pairing, opens the local panel, and retains bounded polling without opening Telegram', async () => {
		const store = new FakeCredentialStore();
		const calls: string[] = [];
		const client = {
			ensureInstallation: async (currentStore: InstallationCredentialStore) => {
				calls.push('ensureInstallation');
				assert.strictEqual(currentStore, store);
				return INSTALLATION_CREDENTIAL;
			},
			createPairing: async (credential: string) => {
				calls.push('createPairing');
				assert.strictEqual(credential, INSTALLATION_CREDENTIAL);
				return {
					pairingId: PAIRING_ID,
					telegramUrl: 'https://t.me/far_away_bot?start=opaque-token',
					expiresAt: new Date('2030-01-02T03:04:05.000Z'),
				};
			},
		};

		const outcome = await createTelegramPairingAndStartPolling(
			client,
			store,
			async (telegramUrl) => {
				calls.push('showPanel');
				assert.strictEqual(telegramUrl, 'https://t.me/far_away_bot?start=opaque-token');
			},
			async (credential, pairing) => {
				calls.push('poll');
				assert.strictEqual(credential, INSTALLATION_CREDENTIAL);
				assert.strictEqual(pairing.pairingId, PAIRING_ID);
				return 'connected';
			}
		);

		assert.strictEqual(outcome, 'connected');
		assert.deepStrictEqual(calls, ['ensureInstallation', 'createPairing', 'showPanel', 'poll']);
	});

	test('extension contributes Telegram connection commands and uses bounded polling', () => {
		const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
			contributes?: {
				commands?: Array<{ command?: string }>;
				configuration?: { properties?: Record<string, unknown> };
			};
		};
		const commands = packageJson.contributes?.commands?.map((command) => command.command) ?? [];
		const extensionSource = fs.readFileSync(path.resolve(__dirname, '../../src/extension.ts'), 'utf8');

		assert.ok(commands.includes('far-away-from-codex.connectTelegram'));
		assert.ok(commands.includes('far-away-from-codex.disconnectTelegram'));
		assert.ok(extensionSource.includes('PAIRING_POLL_INTERVAL_MS = 3_000'));
		assert.ok(extensionSource.includes('MAX_PAIRING_POLL_DURATION_MS'));
		assert.strictEqual(extensionSource.includes('openExternal'), false);
		assert.ok(extensionSource.includes('createTelegramPairingAndStartPolling('));
		assert.ok(extensionSource.includes('pollForPairing(backendClient, credential, pairing)'));
		assert.ok(extensionSource.includes("let alertsEnabled = false"));
		assert.ok(extensionSource.includes("let connectionState: TelegramConnectionState = 'unknown'"));
		assert.ok(extensionSource.includes('let connectionStateRevision = 0'));
		assert.ok(extensionSource.includes('connectionRefreshInFlight'));
		assert.ok(extensionSource.includes('if (connectionRefreshInFlight !== undefined)'));
		assert.ok(extensionSource.includes('return connectionRefreshInFlight;'));
		assert.ok(extensionSource.includes('if (connectionStateRevision === refreshRevision)'));
		assert.ok(extensionSource.includes('void refreshConnectionState();'));
		assert.ok(extensionSource.includes("applyConnectionState('connected')"));
		assert.ok(extensionSource.includes("applyConnectionState('disconnected')"));
	});

	test('pairing material is not persisted by extension state', () => {
		const extensionSource = fs.readFileSync(path.resolve(__dirname, '../../src/extension.ts'), 'utf8');
		const secretStoreSource = fs.readFileSync(path.resolve(__dirname, '../../src/state/SecretStore.ts'), 'utf8');

		assert.strictEqual(extensionSource.includes('globalState'), false);
		assert.strictEqual(extensionSource.includes('workspaceState'), false);
		assert.strictEqual(secretStoreSource.includes('pairing'), false);
		assert.strictEqual(secretStoreSource.includes('telegramUrl'), false);
	});

	test('workspace configuration cannot select the backend for authenticated requests', () => {
		const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
			contributes?: { configuration?: { properties?: Record<string, unknown> } };
		};
		const extensionSource = fs.readFileSync(path.resolve(__dirname, '../../src/extension.ts'), 'utf8');

		assert.strictEqual(packageJson.contributes?.configuration?.properties?.['farAway.backendUrl'], undefined);
		assert.strictEqual(extensionSource.includes('workspace.getConfiguration'), false);
		assert.ok(extensionSource.includes('new BackendClient(PRODUCTION_BACKEND_URL)'));
	});
});
