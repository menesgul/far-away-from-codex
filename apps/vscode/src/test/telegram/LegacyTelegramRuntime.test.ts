import * as assert from 'assert';
import * as vscode from 'vscode';
import { BackendClient } from '../../backend/BackendClient';
import { activate, createLegacyTelegramRuntime } from '../../extension';
import { SecretStore } from '../../state/SecretStore';
import { statusBarText } from '../../state/TelegramConnectionState';
import { TELEGRAM_ONBOARDING_SHOWN_KEY } from '../../telegram/TelegramOnboarding';
import { FakeConnectSession } from '../helpers/FakeConnectSession';
import { Deferred, settlePromises } from '../helpers/async';

const CREDENTIAL = 'a'.repeat(32);

function legacyHarness(options: {
	credential?: string;
	connected?: boolean;
	onboarded?: boolean;
	selection?: string;
	connectionResult?: Promise<boolean>;
	connectionStatus?: number;
	firstCredentialRead?: Promise<string | undefined>;
	credentialDeleteGate?: Promise<void>;
	credentialDeleteGates?: Promise<void>[];
	onCredentialDelete?: () => void;
	registrationCredential?: string;
	promptFailure?: Error;
	promptSelection?: Promise<string | undefined>;
	disconnectedPromptSelections?: Promise<string | undefined>[];
	respond?: (route: string) => Promise<Response> | undefined;
} = {}) {
	let credential = options.credential;
	let credentialReads = 0;
	let credentialDeletes = 0;
	let disconnectedPromptCalls = 0;
	let onboarded = options.onboarded ?? false;
	const messages: string[] = [];
	const errors: string[] = [];
	const requests: string[] = [];
	const sessions: FakeConnectSession[] = [];
	const status = { text: '', command: '', tooltip: '', show() {}, dispose() {} } as unknown as vscode.StatusBarItem;
	const context = {
		secrets: {
			get: () => {
				credentialReads += 1;
				return credentialReads === 1 && options.firstCredentialRead
					? options.firstCredentialRead : Promise.resolve(credential);
			},
			store: async (_key: string, value: string) => { credential = value; },
			delete: async () => {
				const index = credentialDeletes++;
				options.onCredentialDelete?.();
				await (options.credentialDeleteGates?.[index] ?? options.credentialDeleteGate);
				credential = undefined;
			},
		},
		globalState: {
			get: () => onboarded,
			update: async (key: string, value: unknown) => {
				assert.strictEqual(key, TELEGRAM_ONBOARDING_SHOWN_KEY);
				onboarded = value === true;
			},
		},
	} as unknown as vscode.ExtensionContext;
	const request: typeof fetch = async (url, init) => {
		const route = `${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`;
		requests.push(route);
		const overridden = options.respond?.(route);
		if (overridden) { return overridden; }
		if (route === 'GET /v1/telegram-connection') {
			if (options.connectionStatus !== undefined && options.connectionStatus !== 200) {
				return new Response(null, { status: options.connectionStatus });
			}
			const connected = await (options.connectionResult ?? Promise.resolve(options.connected ?? false));
			return new Response(JSON.stringify({ connected }), { status: 200 });
		}
		if (route === 'DELETE /v1/telegram-connection') { return new Response(null, { status: 204 }); }
		if (route === 'POST /v1/installations') {
			return new Response(JSON.stringify({ installationCredential: options.registrationCredential ?? CREDENTIAL }), { status: 201 });
		}
		if (route === 'POST /v1/pairings') {
			return new Response(JSON.stringify({
				pairingId: 'pairing', telegramUrl: 'https://t.me/test_bot?start=abc',
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			}), { status: 201 });
		}
		throw new Error(`Unexpected backend call: ${route}`);
	};
	const runtime = createLegacyTelegramRuntime(context, {
		backendClient: new BackendClient('https://example.test', 1000, request),
		secretStore: new SecretStore(context.secrets),
		statusBarItem: status,
		createSession: (callbacks) => {
			const session = new FakeConnectSession(callbacks);
			sessions.push(session);
			return session;
		},
		showInformationMessage: async (message) => {
			messages.push(message);
			if (message === 'Telegram is not connected.' && options.promptFailure) {
				throw options.promptFailure;
			}
			if (message === 'Telegram is not connected.' && options.disconnectedPromptSelections) {
				const selection = options.disconnectedPromptSelections[disconnectedPromptCalls++];
				if (selection) { return selection; }
			}
			if (message === 'Connect Telegram to receive Codex alerts on your phone.'
				&& options.promptSelection) { return options.promptSelection; }
			return options.selection;
		},
		showErrorMessage: (message) => { errors.push(message); },
	});
	return {
		runtime, status, messages, errors, requests, sessions,
		get credential() { return credential; },
		setCredential: (value: string | undefined) => { credential = value; },
		get onboarded() { return onboarded; },
	};
}

suite('cold legacy Telegram runtime dispatch', () => {
	test('a cold unknown Toggle only refreshes even when the Worker reports connected', async () => {
		const h = legacyHarness({ credential: CREDENTIAL, connected: true, onboarded: true });
		try {
			await h.runtime.toggleAlerts();
			assert.strictEqual(h.status.text, statusBarText('connected', false));
			assert.deepStrictEqual(h.requests, ['GET /v1/telegram-connection']);
			await h.runtime.toggleAlerts();
			assert.strictEqual(h.status.text, statusBarText('connected', true));
			assert.deepStrictEqual(h.requests, ['GET /v1/telegram-connection']);
		} finally { h.runtime.dispose(); }
	});

	test('already-connected user first Toggle refreshes without enabling alerts', async () => {
		const h = legacyHarness({ credential: CREDENTIAL, connected: true, onboarded: true });
		try {
			await h.runtime.toggleAlerts();
			assert.strictEqual(h.status.text, statusBarText('connected', false));
			assert.deepStrictEqual(h.requests, ['GET /v1/telegram-connection']);
			assert.deepStrictEqual(h.messages, []);
		} finally { h.runtime.dispose(); }
	});

	test('two cold unknown Toggle clicks share discovery without alert flips', async () => {
		const getGate = new Deferred<boolean>();
		const h = legacyHarness({ credential: CREDENTIAL, connectionResult: getGate.promise, onboarded: true });
		const first = h.runtime.toggleAlerts();
		let second: Promise<void> | undefined;
		try {
			await settlePromises();
			second = h.runtime.toggleAlerts();
			getGate.resolve(true);
			await Promise.all([first, second]);
			assert.deepStrictEqual(h.requests, ['GET /v1/telegram-connection']);
			assert.strictEqual(h.status.text, statusBarText('connected', false));
			await h.runtime.toggleAlerts();
			assert.strictEqual(h.status.text, statusBarText('connected', true));
		} finally {
			getGate.resolve(true);
			await Promise.allSettled([first, second]);
			h.runtime.dispose();
		}
	});

	test('unknown refresh result stays OFF and a later Toggle retries the authoritative GET', async () => {
		const failed = Promise.reject(new Error('network unavailable'));
		// resolveTelegramConnectionState absorbs the failed GET as unknown.
		const h = legacyHarness({ credential: CREDENTIAL, connectionResult: failed, onboarded: true });
		try {
			await h.runtime.toggleAlerts();
			assert.ok(h.status.text.includes('Alerts: OFF'));
			assert.ok(h.status.text.includes('?'));
			assert.deepStrictEqual(h.messages, []);
			await h.runtime.toggleAlerts();
			assert.deepStrictEqual(h.requests, [
				'GET /v1/telegram-connection', 'GET /v1/telegram-connection',
			]);
		} finally { h.runtime.dispose(); }
	});

	test('rejected credential is recovered before cold Toggle onboarding', async () => {
		const h = legacyHarness({ credential: CREDENTIAL, connectionStatus: 401 });
		try {
			await h.runtime.toggleAlerts();
			assert.strictEqual(h.credential, undefined);
			assert.deepStrictEqual(h.requests, ['GET /v1/telegram-connection']);
			assert.strictEqual(h.messages.length, 1);
			assert.strictEqual(h.onboarded, true);
		} finally { h.runtime.dispose(); }
	});

	test('new disconnected user sees one onboarding prompt on first Toggle', async () => {
		const h = legacyHarness();
		try {
			await h.runtime.toggleAlerts();
			assert.strictEqual(h.messages.length, 1);
			assert.ok(h.messages[0].includes('Connect Telegram'));
			assert.strictEqual(h.onboarded, true);
			assert.deepStrictEqual(h.requests, []);
		} finally { h.runtime.dispose(); }
	});

	test('three Toggles held behind onboarding dismissal do not open later Connect prompts', async () => {
		const selection = new Deferred<string | undefined>();
		const h = legacyHarness({ promptSelection: selection.promise });
		const first = h.runtime.toggleAlerts();
		let second: Promise<void> | undefined;
		let third: Promise<void> | undefined;
		try {
			await settlePromises();
			assert.deepStrictEqual(h.messages, ['Connect Telegram to receive Codex alerts on your phone.']);
			second = h.runtime.toggleAlerts();
			third = h.runtime.toggleAlerts();
			assert.strictEqual(h.messages.length, 1);
			selection.resolve('Not now');
			await Promise.all([first, second, third]);
			assert.deepStrictEqual(h.messages, ['Connect Telegram to receive Codex alerts on your phone.']);
			assert.deepStrictEqual(h.requests, []);
			assert.strictEqual(h.sessions.length, 0);
			assert.strictEqual(h.status.text, statusBarText('disconnected', false));
		} finally {
			selection.resolve('Not now');
			await Promise.allSettled([first, second, third]);
			h.runtime.dispose();
		}
	});

	test('three Toggles held behind onboarding Connect create one enable-intent pairing', async () => {
		const selection = new Deferred<string | undefined>();
		const h = legacyHarness({ promptSelection: selection.promise });
		const first = h.runtime.toggleAlerts();
		let second: Promise<void> | undefined;
		let third: Promise<void> | undefined;
		try {
			await settlePromises();
			second = h.runtime.toggleAlerts();
			third = h.runtime.toggleAlerts();
			selection.resolve('Connect Telegram');
			await Promise.all([first, second, third]);
			assert.deepStrictEqual(h.messages, ['Connect Telegram to receive Codex alerts on your phone.']);
			assert.strictEqual(h.sessions.length, 1);
			assert.strictEqual(h.requests.filter((route) => route === 'POST /v1/pairings').length, 1);
			h.sessions[0].emitConnected();
			h.sessions[0].emitTerminal('connected');
			assert.strictEqual(h.status.text, statusBarText('connected', true));
		} finally {
			selection.resolve('Not now');
			await Promise.allSettled([first, second, third]);
			h.runtime.dispose();
		}
	});

	test('Toggle-initiated onboarding Connect enables alerts on connected pairing terminal', async () => {
		const h = legacyHarness({ selection: 'Connect Telegram' });
		try {
			await h.runtime.toggleAlerts();
			assert.strictEqual(h.sessions.length, 1);
			assert.strictEqual(h.sessions[0].startCalls, 1);
			h.sessions[0].emitConnected();
			h.sessions[0].emitTerminal('connected');
			assert.ok(h.status.text.includes('Alerts: ON'));
		} finally { h.runtime.dispose(); }
	});

	test('previously onboarded disconnected user gets Toggle Connect CTA after the cold refresh', async () => {
		const h = legacyHarness({ onboarded: true });
		try {
			await h.runtime.toggleAlerts();
			assert.deepStrictEqual(h.messages, []);
			await h.runtime.toggleAlerts();
			assert.deepStrictEqual(h.messages, ['Telegram is not connected.']);
		} finally { h.runtime.dispose(); }
	});

	test('previously onboarded cold Toggle propagates a failed Connect prompt', async () => {
		const failure = new Error('Connect prompt failed');
		const h = legacyHarness({ onboarded: true, promptFailure: failure });
		try {
			await h.runtime.toggleAlerts();
			await assert.rejects(h.runtime.toggleAlerts(), (error: unknown) => error === failure);
			assert.deepStrictEqual(h.messages, ['Telegram is not connected.']);
			assert.deepStrictEqual(h.errors, []);
		} finally { h.runtime.dispose(); }
	});

	test('contributed cold Toggle exposes a failed Connect prompt', async () => {
		const failure = new Error('Connect prompt failed');
		const h = legacyHarness({ onboarded: true, promptFailure: failure });
		const subscriptions: vscode.Disposable[] = [];
		const commands = new Map<string, () => unknown>();
		activate({ subscriptions } as unknown as vscode.ExtensionContext, {
			createCompanionClient: () => { throw new Error('Companion locator unavailable'); },
			createLegacyTelegramRuntime: () => h.runtime,
			createStatusBarItem: () => ({ text: '', show() {}, dispose() {} }) as unknown as vscode.StatusBarItem,
			registerCommand: (name, callback) => {
				commands.set(name, callback);
				return { dispose: () => { commands.delete(name); } };
			},
		});
		try {
			const toggle = commands.get('far-away-from-codex.toggleAlerts');
			assert.ok(toggle);
			await toggle();
			await assert.rejects(toggle() as Promise<void>, (error: unknown) => error === failure);
			assert.deepStrictEqual(h.messages, ['Telegram is not connected.']);
			assert.deepStrictEqual(h.errors, []);
		} finally {
			for (const disposable of subscriptions) { disposable.dispose(); }
		}
	});

	test('cold Disconnect without credential reports already disconnected without DELETE', async () => {
		const h = legacyHarness();
		try {
			await h.runtime.disconnectTelegram();
			assert.deepStrictEqual(h.messages, ['Telegram is already disconnected.']);
			assert.deepStrictEqual(h.errors, []);
			assert.deepStrictEqual(h.requests, []);
		} finally { h.runtime.dispose(); }
	});

	test('cold Disconnect with credential issues one authenticated DELETE', async () => {
		const h = legacyHarness({ credential: CREDENTIAL });
		try {
			await h.runtime.disconnectTelegram();
			assert.deepStrictEqual(h.requests, ['DELETE /v1/telegram-connection']);
			assert.deepStrictEqual(h.messages, ['Telegram is disconnected.']);
			assert.strictEqual(h.credential, CREDENTIAL);
		} finally { h.runtime.dispose(); }
	});

	test('concurrent cold Toggle and Connect share one runtime and do not duplicate pairing', async () => {
		const result = new Deferred<boolean>();
		const h = legacyHarness({ credential: CREDENTIAL, connectionResult: result.promise, onboarded: true });
		try {
			const toggle = h.runtime.toggleAlerts();
			const firstConnect = h.runtime.connectTelegram();
			const secondConnect = h.runtime.connectTelegram();
			assert.strictEqual(h.sessions.length, 1);
			result.resolve(false);
			await Promise.all([toggle, firstConnect, secondConnect]);
			await settlePromises();
			assert.strictEqual(h.sessions.length, 1);
			assert.ok(h.requests.filter((item) => item === 'POST /v1/pairings').length <= 1);
		} finally { h.runtime.dispose(); }
	});

	test('cold Disconnect followed by Connect cannot fence the newer pairing result', async () => {
		const h = legacyHarness();
		try {
			const disconnect = h.runtime.disconnectTelegram();
			const connect = h.runtime.connectTelegram();
			await Promise.all([disconnect, connect]);
			assert.strictEqual(h.sessions.length, 1);
			h.sessions[0].emitConnected();
			h.sessions[0].emitTerminal('connected');
			assert.ok(h.status.text.includes('$(send) ✓'));
			assert.strictEqual(h.errors.length, 0);
		} finally { h.runtime.dispose(); }
	});

	test('older Disconnect paused at credential lookup cannot DELETE after newer Connect starts', async () => {
		const credentialRead = new Deferred<string | undefined>();
		const h = legacyHarness({ credential: CREDENTIAL, firstCredentialRead: credentialRead.promise });
		try {
			const oldDisconnect = h.runtime.disconnectTelegram();
			assert.strictEqual(h.requests.length, 0);
			const newConnect = h.runtime.connectTelegram();
			await newConnect;
			assert.strictEqual(h.sessions.length, 1);
			assert.strictEqual(h.sessions[0].state, 'waiting');
			credentialRead.resolve(CREDENTIAL);
			await oldDisconnect;
			assert.ok(!h.requests.includes('DELETE /v1/telegram-connection'));
			assert.strictEqual(h.sessions[0].cancelCalls, 0);
			h.sessions[0].emitConnected();
			h.sessions[0].emitTerminal('connected');
			assert.ok(h.status.text.includes('$(send) ✓'));
			assert.deepStrictEqual(h.errors, []);
		} finally { h.runtime.dispose(); }
	});

	test('newer Disconnect still cancels and fences an older Connect', async () => {
		const connectionRead = new Deferred<boolean>();
		const h = legacyHarness({ credential: CREDENTIAL, connectionResult: connectionRead.promise });
		try {
			const oldConnect = h.runtime.connectTelegram();
			await settlePromises();
			assert.ok(h.requests.includes('GET /v1/telegram-connection'));
			const newDisconnect = h.runtime.disconnectTelegram();
			await newDisconnect;
			connectionRead.resolve(true);
			await oldConnect;
			assert.ok(h.requests.includes('DELETE /v1/telegram-connection'));
			assert.ok(!h.requests.includes('POST /v1/pairings'));
			assert.strictEqual(h.sessions[0].cancelCalls, 1);
			assert.ok(h.status.text.includes('$(send) ✕'));
		} finally { h.runtime.dispose(); }
	});

	test('cold Connect followed by Toggle upgrades one starting pairing without a stale refresh', async () => {
		const h = legacyHarness();
		try {
			const connect = h.runtime.connectTelegram();
			const toggle = h.runtime.toggleAlerts();
			await Promise.all([connect, toggle]);
			assert.strictEqual(h.sessions.length, 1);
			h.sessions[0].emitConnected();
			h.sessions[0].emitTerminal('connected');
			assert.ok(h.status.text.includes('Alerts: ON'));
			assert.deepStrictEqual(h.requests, [
				'POST /v1/installations', 'GET /v1/telegram-connection', 'POST /v1/pairings',
			]);
		} finally { h.runtime.dispose(); }
	});

	test('Toggle on a connected projection flips alerts despite a still-active pairing session', async () => {
		const h = legacyHarness();
		try {
			await h.runtime.connectTelegram();
			assert.strictEqual(h.sessions.length, 1);
			h.sessions[0].emitConnected();
			assert.ok(h.status.text.includes('Alerts: OFF'));
			await h.runtime.toggleAlerts();
			assert.ok(h.status.text.includes('Alerts: ON'));
			assert.strictEqual(h.sessions.length, 1);
			assert.deepStrictEqual(h.requests, [
				'POST /v1/installations', 'GET /v1/telegram-connection', 'POST /v1/pairings',
			]);
		} finally { h.runtime.dispose(); }
	});

	test('issued DELETE settles before a newer Connect may GET connection state', async () => {
		const deleteGate = new Deferred<void>();
		let serverConnected = true;
		const h = legacyHarness({ credential: CREDENTIAL, respond: (route) => {
			if (route === 'DELETE /v1/telegram-connection') {
				return deleteGate.promise.then(() => {
					serverConnected = false;
					return new Response(null, { status: 204 });
				});
			}
			if (route === 'GET /v1/telegram-connection') {
				return Promise.resolve(new Response(JSON.stringify({ connected: serverConnected }), { status: 200 }));
			}
			return undefined;
		} });
		const disconnect = h.runtime.disconnectTelegram();
		let connect: Promise<void> | undefined;
		try {
			await settlePromises();
			assert.ok(h.requests.includes('DELETE /v1/telegram-connection'));
			connect = h.runtime.connectTelegram();
			await settlePromises();
			assert.ok(!h.requests.includes('GET /v1/telegram-connection'));
			deleteGate.resolve();
			await Promise.all([disconnect, connect]);
			assert.ok(h.requests.indexOf('GET /v1/telegram-connection')
				> h.requests.indexOf('DELETE /v1/telegram-connection'));
			assert.ok(!h.status.text.includes('$(send) ✓'));
		} finally {
			deleteGate.resolve();
			await Promise.allSettled([disconnect, connect]);
			h.runtime.dispose();
		}
	});

	test('ambiguous issued DELETE cannot be followed by a confirmed connected Connect result', async () => {
		const deleteGate = new Deferred<Response>();
		const h = legacyHarness({ credential: CREDENTIAL, respond: (route) => {
			if (route === 'DELETE /v1/telegram-connection') { return deleteGate.promise; }
			if (route === 'GET /v1/telegram-connection') {
				return Promise.resolve(new Response(JSON.stringify({ connected: true }), { status: 200 }));
			}
			return undefined;
		} });
		const disconnect = h.runtime.disconnectTelegram();
		let connect: Promise<void> | undefined;
		try {
			await settlePromises();
			connect = h.runtime.connectTelegram();
			await settlePromises();
			deleteGate.reject(new Error('lost DELETE response'));
			await Promise.allSettled([disconnect, connect]);
			assert.ok(!h.status.text.includes('$(send) ✓'));
			assert.ok(h.status.text.includes('$(send) ?'));
			assert.ok(!h.messages.includes('Telegram is connected.'));
		} finally {
			deleteGate.reject(new Error('lost DELETE response'));
			await Promise.allSettled([disconnect, connect]);
			h.runtime.dispose();
		}
	});

	test('Disconnect after intervening Connect owns a new attempt despite an older credential lookup', async () => {
		const credentialGate = new Deferred<string | undefined>();
		const h = legacyHarness({ credential: CREDENTIAL, firstCredentialRead: credentialGate.promise });
		const firstDisconnect = h.runtime.disconnectTelegram();
		try {
			await h.runtime.connectTelegram();
			assert.strictEqual(h.sessions.length, 1);
			const secondDisconnect = h.runtime.disconnectTelegram();
			assert.strictEqual(h.sessions[0].cancelCalls, 1);
			credentialGate.resolve(CREDENTIAL);
			await Promise.all([firstDisconnect, secondDisconnect]);
			assert.strictEqual(h.requests.filter((route) => route === 'DELETE /v1/telegram-connection').length, 1);
			assert.ok(h.status.text.includes('$(send) ✕'));
		} finally {
			credentialGate.resolve(CREDENTIAL);
			await firstDisconnect;
			h.runtime.dispose();
		}
	});

	test('Disconnect then Toggle then Disconnect keeps the final Disconnect intent', async () => {
		const credentialGate = new Deferred<string | undefined>();
		const h = legacyHarness({
			credential: CREDENTIAL, firstCredentialRead: credentialGate.promise,
			selection: 'Connect Telegram',
	});
		const firstDisconnect = h.runtime.disconnectTelegram();
		const toggle = h.runtime.toggleAlerts();
		const finalDisconnect = h.runtime.disconnectTelegram();
		try {
			assert.notStrictEqual(finalDisconnect, firstDisconnect,
				'Toggle must claim its intent before waiting for the first Disconnect');
			credentialGate.resolve(CREDENTIAL);
			await Promise.all([firstDisconnect, toggle, finalDisconnect]);
			assert.strictEqual(h.requests.filter((route) => route === 'DELETE /v1/telegram-connection').length, 1);
			assert.ok(!h.messages.includes('Telegram is not connected.'));
			assert.strictEqual(h.sessions.length, 0);
			assert.ok(h.status.text.includes('Alerts: OFF'));
			assert.strictEqual(h.status.text, statusBarText('disconnected', false));
		} finally {
			credentialGate.resolve(CREDENTIAL);
			await Promise.allSettled([firstDisconnect, toggle, finalDisconnect]);
			h.runtime.dispose();
		}
	});

	test('latest Disconnect cancels a Connect queued behind an issued DELETE', async () => {
		const deleteGate = new Deferred<Response>();
		const h = legacyHarness({ credential: CREDENTIAL, respond: (route) =>
			route === 'DELETE /v1/telegram-connection' ? deleteGate.promise : undefined });
		const firstDisconnect = h.runtime.disconnectTelegram();
		let connect: Promise<void> | undefined;
		try {
			await settlePromises();
			connect = h.runtime.connectTelegram();
			const latestDisconnect = h.runtime.disconnectTelegram();
			await settlePromises();
			assert.ok(!h.requests.includes('GET /v1/telegram-connection'));
			deleteGate.resolve(new Response(null, { status: 204 }));
			await Promise.all([firstDisconnect, connect, latestDisconnect]);
			assert.ok(!h.requests.includes('GET /v1/telegram-connection'));
			assert.ok(!h.requests.includes('POST /v1/pairings'));
			assert.ok(h.status.text.includes('$(send) ✕'));
		} finally {
			deleteGate.resolve(new Response(null, { status: 204 }));
			await Promise.allSettled([firstDisconnect, connect]);
			h.runtime.dispose();
		}
	});

	test('later Toggle upgrades Connect instead of sharing superseded onboarding', async () => {
		const promptGate = new Deferred<string | undefined>();
		const h = legacyHarness({ promptSelection: promptGate.promise });
		const firstToggle = h.runtime.toggleAlerts();
		try {
			await settlePromises();
			assert.deepStrictEqual(h.messages, ['Connect Telegram to receive Codex alerts on your phone.']);
			await h.runtime.connectTelegram();
			const laterToggle = h.runtime.toggleAlerts();
			promptGate.resolve('Connect Telegram');
			await Promise.all([firstToggle, laterToggle]);
			assert.strictEqual(h.sessions.length, 1);
			h.sessions[0].emitConnected();
			h.sessions[0].emitTerminal('connected');
			assert.ok(h.status.text.includes('Alerts: ON'));
			assert.strictEqual(h.requests.filter((route) => route === 'POST /v1/pairings').length, 1);
		} finally {
			promptGate.resolve('Not now');
			await firstToggle;
			h.runtime.dispose();
		}
	});

	test('stale rejected refresh cannot delete a credential used by newer Connect', async () => {
		const firstGet = new Deferred<Response>();
		let getCalls = 0;
		const newerCredential = 'b'.repeat(32);
		const h = legacyHarness({ credential: CREDENTIAL, onboarded: true, respond: (route) => {
			if (route !== 'GET /v1/telegram-connection') { return undefined; }
			getCalls += 1;
			return getCalls === 1 ? firstGet.promise
				: Promise.resolve(new Response(JSON.stringify({ connected: false }), { status: 200 }));
		} });
		const refresh = h.runtime.toggleAlerts();
		try {
			await settlePromises();
			assert.strictEqual(getCalls, 1);
			h.setCredential(newerCredential);
			await h.runtime.connectTelegram();
			assert.strictEqual(h.sessions.length, 1);
			firstGet.resolve(new Response(null, { status: 401 }));
			await refresh;
			assert.strictEqual(h.credential, newerCredential);
			assert.strictEqual(h.sessions[0].state, 'waiting');
		} finally {
			firstGet.resolve(new Response(null, { status: 401 }));
			await refresh;
			h.runtime.dispose();
		}
	});

	test('Connect waits for credential recovery already begun by an older refresh', async () => {
		const recoveryGate = new Deferred<void>();
		let getCalls = 0;
		const h = legacyHarness({
			credential: CREDENTIAL, onboarded: true, credentialDeleteGate: recoveryGate.promise,
			respond: (route) => {
				if (route !== 'GET /v1/telegram-connection') { return undefined; }
				getCalls += 1;
				return Promise.resolve(getCalls === 1
					? new Response(null, { status: 401 })
					: new Response(JSON.stringify({ connected: false }), { status: 200 }));
			},
		});
		const refresh = h.runtime.toggleAlerts();
		let connect: Promise<void> | undefined;
		try {
			await settlePromises();
			assert.strictEqual(getCalls, 1);
			connect = h.runtime.connectTelegram();
			await settlePromises();
			assert.strictEqual(getCalls, 1);
			assert.ok(!h.requests.includes('POST /v1/installations'));
			recoveryGate.resolve();
			await Promise.all([refresh, connect]);
			assert.strictEqual(getCalls, 2);
			assert.strictEqual(h.credential, CREDENTIAL);
			assert.strictEqual(h.sessions[0].state, 'waiting');
		} finally {
			recoveryGate.resolve();
			await Promise.allSettled([refresh, connect]);
			h.runtime.dispose();
		}
	});

	test('Connect waits for rejected Disconnect credential recovery before reading identity', async () => {
		const recoveryGate = new Deferred<void>();
		const recoveryStarted = new Deferred<void>();
		const h = legacyHarness({
			credential: CREDENTIAL, credentialDeleteGate: recoveryGate.promise,
			onCredentialDelete: () => recoveryStarted.resolve(),
			respond: (route) => route === 'DELETE /v1/telegram-connection'
				? Promise.resolve(new Response(null, { status: 401 })) : undefined,
		});
		const disconnect = h.runtime.disconnectTelegram();
		let connect: Promise<void> | undefined;
		try {
			await recoveryStarted.promise;
			assert.ok(h.requests.includes('DELETE /v1/telegram-connection'));
			connect = h.runtime.connectTelegram();
			await settlePromises();
			assert.ok(!h.requests.includes('GET /v1/telegram-connection'));
			assert.ok(!h.requests.includes('POST /v1/installations'));
			recoveryGate.resolve();
			await Promise.all([disconnect, connect]);
			assert.ok(h.requests.includes('POST /v1/installations'));
			assert.strictEqual(h.sessions.length, 1);
		} finally {
			recoveryGate.resolve();
			await Promise.allSettled([disconnect, connect]);
			h.runtime.dispose();
		}
	});

	test('Connect waits for both overlapping credential deletions before storing a new identity', async () => {
		const olderDelete = new Deferred<void>();
		const newerDelete = new Deferred<void>();
		const firstDeleteStarted = new Deferred<void>();
		const secondDeleteStarted = new Deferred<void>();
		const newCredential = 'b'.repeat(32);
		let deletions = 0;
		let gets = 0;
		const h = legacyHarness({
			credential: CREDENTIAL, onboarded: true,
			credentialDeleteGates: [olderDelete.promise, newerDelete.promise],
			onCredentialDelete: () => {
				deletions += 1;
				(deletions === 1 ? firstDeleteStarted : secondDeleteStarted).resolve();
			},
			registrationCredential: newCredential,
			respond: (route) => {
				if (route === 'DELETE /v1/telegram-connection') {
					return Promise.resolve(new Response(null, { status: 401 }));
				}
				if (route === 'GET /v1/telegram-connection') {
					gets += 1;
					return Promise.resolve(gets === 1 ? new Response(null, { status: 401 })
						: new Response(JSON.stringify({ connected: false }), { status: 200 }));
				}
				return undefined;
			},
		});
		const refresh = h.runtime.toggleAlerts();
		let disconnect: Promise<void> | undefined;
		let connect: Promise<void> | undefined;
		try {
			await firstDeleteStarted.promise;
			disconnect = h.runtime.disconnectTelegram();
			await secondDeleteStarted.promise;
			connect = h.runtime.connectTelegram();
			newerDelete.resolve();
			await settlePromises();
			assert.ok(!h.requests.includes('POST /v1/installations'));
			olderDelete.resolve();
			await Promise.all([refresh, disconnect, connect]);
			assert.strictEqual(h.credential, newCredential);
			assert.strictEqual(h.sessions.length, 1);
		} finally {
			newerDelete.resolve();
			olderDelete.resolve();
			await Promise.allSettled([refresh, disconnect, connect]);
			h.runtime.dispose();
		}
	});

	test('Toggle while Disconnect awaits credentials does not cancel the Disconnect intent', async () => {
		const credentialGate = new Deferred<string | undefined>();
		const h = legacyHarness({ credential: CREDENTIAL, firstCredentialRead: credentialGate.promise });
		const disconnect = h.runtime.disconnectTelegram();
		const toggle = h.runtime.toggleAlerts();
		try {
			assert.deepStrictEqual(h.requests, []);
			credentialGate.resolve(CREDENTIAL);
			await Promise.all([disconnect, toggle]);
			assert.strictEqual(h.requests.filter((route) => route === 'DELETE /v1/telegram-connection').length, 1);
			assert.ok(h.status.text.includes('$(send) ✕'));
		} finally {
			credentialGate.resolve(CREDENTIAL);
			await Promise.allSettled([disconnect, toggle]);
			h.runtime.dispose();
		}
	});

	test('two Toggles deferred behind DELETE keep the first Connect offer held until dismissal', async () => {
		const deleteStarted = new Deferred<void>();
		const deleteResult = new Deferred<Response>();
		const firstPrompt = new Deferred<string | undefined>();
		const secondPrompt = new Deferred<string | undefined>();
		const h = legacyHarness({
			credential: CREDENTIAL,
			disconnectedPromptSelections: [firstPrompt.promise, secondPrompt.promise],
			respond: (route) => {
				if (route === 'DELETE /v1/telegram-connection') {
					deleteStarted.resolve();
					return deleteResult.promise;
				}
				return undefined;
			},
		});
		const disconnect = h.runtime.disconnectTelegram();
		let first: Promise<void> | undefined;
		let second: Promise<void> | undefined;
		try {
			await deleteStarted.promise;
			first = h.runtime.toggleAlerts();
			second = h.runtime.toggleAlerts();
			deleteResult.resolve(new Response(null, { status: 204 }));
			await disconnect;
			await settlePromises();
			assert.strictEqual(h.messages.filter((message) => message === 'Telegram is not connected.').length, 1);
			assert.strictEqual(h.sessions.length, 0);
			firstPrompt.resolve('Cancel');
			await first;
			await settlePromises();
			assert.strictEqual(h.messages.filter((message) => message === 'Telegram is not connected.').length, 2);
			assert.strictEqual(h.sessions.length, 0);
			secondPrompt.resolve('Cancel');
			await second;
			assert.strictEqual(h.status.text, statusBarText('disconnected', false));
			assert.strictEqual(h.requests.filter((route) => route === 'DELETE /v1/telegram-connection').length, 1);
		} finally {
			deleteResult.resolve(new Response(null, { status: 204 }));
			firstPrompt.resolve('Cancel');
			secondPrompt.resolve('Cancel');
			await Promise.allSettled([disconnect, first, second]);
			h.runtime.dispose();
		}
	});

	test('a rejected deferred Toggle prompt does not reject the later Toggle without its own offer', async () => {
		const deleteStarted = new Deferred<void>();
		const deleteResult = new Deferred<Response>();
		const firstPrompt = new Deferred<string | undefined>();
		const secondPrompt = new Deferred<string | undefined>();
		const promptError = new Error('Connect prompt failed');
		const secondPromptError = new Error('Later Connect prompt failed');
		const h = legacyHarness({
			credential: CREDENTIAL,
			disconnectedPromptSelections: [firstPrompt.promise, secondPrompt.promise],
			respond: (route) => {
				if (route === 'DELETE /v1/telegram-connection') {
					deleteStarted.resolve();
					return deleteResult.promise;
				}
				return undefined;
			},
		});
		const disconnect = h.runtime.disconnectTelegram();
		let first: Promise<void> | undefined;
		let second: Promise<void> | undefined;
		try {
			await deleteStarted.promise;
			first = h.runtime.toggleAlerts();
			second = h.runtime.toggleAlerts();
			const firstRejected = assert.rejects(first, (error) => error === promptError);
			const secondRejected = assert.rejects(second, (error) => error === secondPromptError);
			deleteResult.resolve(new Response(null, { status: 204 }));
			await disconnect;
			await settlePromises();
			assert.strictEqual(h.messages.filter((message) => message === 'Telegram is not connected.').length, 1);
			firstPrompt.reject(promptError);
			await firstRejected;
			await settlePromises();
			assert.strictEqual(h.messages.filter((message) => message === 'Telegram is not connected.').length, 2);
			assert.strictEqual(h.sessions.length, 0);
			secondPrompt.reject(secondPromptError);
			await secondRejected;
			assert.strictEqual(h.status.text, statusBarText('disconnected', false));
		} finally {
			deleteResult.resolve(new Response(null, { status: 204 }));
			firstPrompt.reject(promptError);
			secondPrompt.resolve('Cancel');
			await Promise.allSettled([disconnect, first, second]);
			h.runtime.dispose();
		}
	});

	test('two deferred Toggles share one pairing when the first Connect offer is accepted', async () => {
		const deleteStarted = new Deferred<void>();
		const deleteResult = new Deferred<Response>();
		const firstPrompt = new Deferred<string | undefined>();
		const h = legacyHarness({
			credential: CREDENTIAL, disconnectedPromptSelections: [firstPrompt.promise],
			respond: (route) => {
				if (route === 'DELETE /v1/telegram-connection') {
					deleteStarted.resolve();
					return deleteResult.promise;
				}
				return undefined;
			},
		});
		const disconnect = h.runtime.disconnectTelegram();
		let first: Promise<void> | undefined;
		let second: Promise<void> | undefined;
		try {
			await deleteStarted.promise;
			first = h.runtime.toggleAlerts();
			second = h.runtime.toggleAlerts();
			deleteResult.resolve(new Response(null, { status: 204 }));
			await disconnect;
			await settlePromises();
			assert.strictEqual(h.messages.filter((message) => message === 'Telegram is not connected.').length, 1);
			assert.strictEqual(h.sessions.length, 0);
			firstPrompt.resolve('Connect Telegram');
			await Promise.all([first, second]);
			assert.strictEqual(h.messages.filter((message) => message === 'Telegram is not connected.').length, 1);
			assert.strictEqual(h.sessions.length, 1);
			assert.strictEqual(h.requests.filter((route) => route === 'POST /v1/pairings').length, 1);
			h.sessions[0].emitConnected();
			h.sessions[0].emitTerminal('connected');
			assert.strictEqual(h.status.text, statusBarText('connected', true));
		} finally {
			deleteResult.resolve(new Response(null, { status: 204 }));
			firstPrompt.resolve('Cancel');
			await Promise.allSettled([disconnect, first, second]);
			h.runtime.dispose();
		}
	});

	test('Toggle upgrades a Connect queued behind an issued DELETE', async () => {
		const deleteGate = new Deferred<Response>();
		const h = legacyHarness({ credential: CREDENTIAL, respond: (route) => {
			if (route === 'DELETE /v1/telegram-connection') { return deleteGate.promise; }
			if (route === 'GET /v1/telegram-connection') {
				return Promise.resolve(new Response(JSON.stringify({ connected: false }), { status: 200 }));
			}
			return undefined;
		} });
		const disconnect = h.runtime.disconnectTelegram();
		let connect: Promise<void> | undefined;
		let toggle: Promise<void> | undefined;
		try {
			await settlePromises();
			connect = h.runtime.connectTelegram();
			toggle = h.runtime.toggleAlerts();
			assert.ok(!h.requests.includes('GET /v1/telegram-connection'));
			deleteGate.resolve(new Response(null, { status: 204 }));
			await Promise.all([disconnect, connect, toggle]);
			assert.strictEqual(h.sessions.length, 1);
			h.sessions[0].emitConnected();
			h.sessions[0].emitTerminal('connected');
			assert.ok(h.status.text.includes('Alerts: ON'));
		} finally {
			deleteGate.resolve(new Response(null, { status: 204 }));
			await Promise.allSettled([disconnect, connect, toggle]);
			h.runtime.dispose();
		}
	});

	test('dispose while Connect waits for issued DELETE cannot start a later GET', async () => {
		const deleteGate = new Deferred<Response>();
		const h = legacyHarness({ credential: CREDENTIAL, respond: (route) =>
			route === 'DELETE /v1/telegram-connection' ? deleteGate.promise : undefined });
		const disconnect = h.runtime.disconnectTelegram();
		await settlePromises();
		const connect = h.runtime.connectTelegram();
		h.runtime.dispose();
		await Promise.all([h.runtime.connectTelegram(), h.runtime.disconnectTelegram(), h.runtime.toggleAlerts()]);
		deleteGate.resolve(new Response(null, { status: 204 }));
		await Promise.allSettled([disconnect, connect]);
		assert.ok(!h.requests.includes('GET /v1/telegram-connection'));
		assert.ok(!h.requests.includes('POST /v1/pairings'));
	});

	test('an issued DELETE settling after disposal cannot notify or mutate the status item', async () => {
		const deleteStarted = new Deferred<void>();
		const deleteResult = new Deferred<Response>();
		const h = legacyHarness({ credential: CREDENTIAL, respond: (route) => {
			if (route === 'DELETE /v1/telegram-connection') {
				deleteStarted.resolve();
				return deleteResult.promise;
			}
			return undefined;
		} });
		const disconnect = h.runtime.disconnectTelegram();
		try {
			await deleteStarted.promise;
			const textAtDisposal = h.status.text;
			h.runtime.dispose();
			deleteResult.resolve(new Response(null, { status: 204 }));
			await disconnect;
			assert.strictEqual(h.status.text, textAtDisposal);
			assert.deepStrictEqual(h.messages, []);
			assert.deepStrictEqual(h.errors, []);
		} finally {
			deleteResult.resolve(new Response(null, { status: 204 }));
			await disconnect;
			h.runtime.dispose();
		}
	});

	test('a failed DELETE settling after disposal cannot show a late error', async () => {
		const deleteStarted = new Deferred<void>();
		const deleteResult = new Deferred<Response>();
		const h = legacyHarness({ credential: CREDENTIAL, respond: (route) => {
			if (route === 'DELETE /v1/telegram-connection') {
				deleteStarted.resolve();
				return deleteResult.promise;
			}
			return undefined;
		} });
		const disconnect = h.runtime.disconnectTelegram();
		try {
			await deleteStarted.promise;
			const textAtDisposal = h.status.text;
			h.runtime.dispose();
			deleteResult.reject(new Error('lost DELETE response'));
			await disconnect;
			assert.strictEqual(h.status.text, textAtDisposal);
			assert.deepStrictEqual(h.messages, []);
			assert.deepStrictEqual(h.errors, []);
		} finally {
			deleteResult.reject(new Error('lost DELETE response'));
			await disconnect;
			h.runtime.dispose();
		}
	});

	test('Toggle after Disconnect supersedes an onboarding prompt without sharing its old result', async () => {
		const promptGate = new Deferred<string | undefined>();
		const h = legacyHarness({ promptSelection: promptGate.promise });
		const firstToggle = h.runtime.toggleAlerts();
		try {
			await settlePromises();
			await h.runtime.disconnectTelegram();
			const laterToggle = h.runtime.toggleAlerts();
			promptGate.resolve('Connect Telegram');
			await Promise.all([firstToggle, laterToggle]);
			assert.strictEqual(h.sessions.length, 0);
			assert.deepStrictEqual(h.messages, [
				'Connect Telegram to receive Codex alerts on your phone.',
				'Telegram is already disconnected.',
				'Telegram is not connected.',
			]);
		} finally {
			promptGate.resolve('Not now');
			await firstToggle;
			h.runtime.dispose();
		}
	});

	test('new Toggle acts while superseded onboarding prompt remains unresolved', async () => {
		const oldPrompt = new Deferred<string | undefined>();
		const h = legacyHarness({ promptSelection: oldPrompt.promise, selection: 'Cancel' });
		const first = h.runtime.toggleAlerts();
		let later: Promise<void> | undefined;
		try {
			await settlePromises();
			await h.runtime.disconnectTelegram();
			later = h.runtime.toggleAlerts();
			await settlePromises();
			assert.ok(h.messages.includes('Telegram is not connected.'));
			await later;
			assert.strictEqual(h.sessions.length, 0);
			oldPrompt.resolve('Connect Telegram');
			await first;
			assert.strictEqual(h.sessions.length, 0);
		} finally {
			oldPrompt.resolve('Connect Telegram');
			await Promise.allSettled([first, later]);
			h.runtime.dispose();
		}
	});
});
