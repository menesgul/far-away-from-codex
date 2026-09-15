import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	BackendClient,
	BackendClientError,
	type InstallationCredentialStore,
} from '../backend/BackendClient';
import { SecretStore } from '../state/SecretStore';

const INSTALLATION_CREDENTIAL = 'abcdefghijklmnopqrstuvwxyz0123456789_ABCDEF';
const FRESH_INSTALLATION_CREDENTIAL = 'freshinstallationcredential0123456789_ABCDEF';

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
});
