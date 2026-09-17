import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	BackendClient,
	BackendClientError,
	InstallationCredentialRejectedError,
	TelegramAlreadyConnectedError,
	type InstallationCredentialStore,
	type Pairing,
	type PairingStatus,
} from '../backend/BackendClient';
import {
	createTelegramAlertsToggleCommand,
	createTelegramConnectionStateRefresh,
	createTelegramConnectCommand,
	createTelegramOnboarding,
	TELEGRAM_ONBOARDING_SHOWN_KEY,
	runTelegramActivationOnboarding,
	type TelegramConnectSession,
	type TelegramConnectSessionCallbacks,
	type TelegramConnectIntent,
	type TelegramOnboarding,
	type TelegramOnboardingState,
} from '../extension';
import { SecretStore } from '../state/SecretStore';
import {
	canEnableAlerts,
	resolveTelegramConnectionState,
	statusBarText,
	type TelegramConnectionClient,
	type TelegramConnectionState,
} from '../state/TelegramConnectionState';
import {
	generateTelegramPairingQrDataUri,
	isPairingPanelMessage,
	renderTelegramPairingExpiredHtml,
	renderTelegramPairingHtml,
	type PairingPanelMessage,
	type TelegramPairingPanel,
} from '../ui/TelegramPairingPanel';
import {
	TelegramPairingSession,
	type PairingSessionState,
	type PairingSessionTimers,
} from '../telegram/TelegramPairingSession';
import { createTelegramDisconnectCommand } from '../telegram/TelegramDisconnectCommand';

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

class Deferred<T> {
	public readonly promise: Promise<T>;
	public resolve!: (value: T | PromiseLike<T>) => void;
	public reject!: (reason?: unknown) => void;

	public constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}
}

class FakeTimers implements PairingSessionTimers {
	private currentTime = 0;
	private nextId = 1;
	private readonly scheduled = new Map<number, { at: number; callback: () => void }>();

	public now(): number {
		return this.currentTime;
	}

	public setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
		const id = this.nextId++;
		this.scheduled.set(id, { at: this.currentTime + delayMs, callback });
		return id as unknown as ReturnType<typeof setTimeout>;
	}

	public clearTimeout(timer: ReturnType<typeof setTimeout>): void {
		this.scheduled.delete(timer as unknown as number);
	}

	public advanceBy(delayMs: number): void {
		const target = this.currentTime + delayMs;
		while (true) {
			const due = [...this.scheduled.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
			if (due === undefined) {
				break;
			}
			const [id, timer] = due;
			this.scheduled.delete(id);
			this.currentTime = timer.at;
			timer.callback();
		}
		this.currentTime = target;
	}
}

class FakePairingPanel {
	public isDisposed = false;
	public showExpiredCalls = 0;
	public revealCalls = 0;
	public disposeCalls = 0;
	private readonly actionListeners = new Set<(message: PairingPanelMessage) => void>();
	private readonly disposeListeners = new Set<() => void>();

	public readonly onDidReceiveAction = (listener: (message: PairingPanelMessage) => void) => {
		this.actionListeners.add(listener);
		return { dispose: () => this.actionListeners.delete(listener) };
	};

	public readonly onDidDispose = (listener: () => void) => {
		this.disposeListeners.add(listener);
		return { dispose: () => this.disposeListeners.delete(listener) };
	};

	public showExpired(): void {
		this.showExpiredCalls += 1;
	}

	public reveal(): boolean {
		if (this.isDisposed) {
			return false;
		}
		this.revealCalls += 1;
		return true;
	}

	public dispose(): void {
		this.disposeCalls += 1;
		if (this.isDisposed) {
			return;
		}
		this.isDisposed = true;
		for (const listener of [...this.disposeListeners]) {
			listener();
		}
	}

	public emitAction(message: PairingPanelMessage): void {
		for (const listener of [...this.actionListeners]) {
			listener(message);
		}
	}
}

function futurePairing(expiresAt: number): { pairingId: string; telegramUrl: string; expiresAt: Date } {
	return {
		pairingId: PAIRING_ID,
		telegramUrl: 'https://t.me/far_away_bot?start=opaque-token',
		expiresAt: new Date(expiresAt),
	};
}

async function settlePromises(): Promise<void> {
	for (let index = 0; index < 8; index += 1) {
		await Promise.resolve();
	}
}

class FakeConnectSession implements TelegramConnectSession {
	public state: PairingSessionState = 'starting';
	public revealCalls = 0;
	public disposeCalls = 0;
	public cancelCalls = 0;
	public completeConnectedCalls = 0;
	public startCalls = 0;

	public constructor(private readonly callbacks: TelegramConnectSessionCallbacks) {}

	public reveal(): boolean {
		this.revealCalls += 1;
		return this.state === 'waiting';
	}

	public dispose(): void {
		this.disposeCalls += 1;
		this.callbacks.onDisposed(this);
	}

	public cancel(): void {
		this.cancelCalls += 1;
		this.emitTerminal('cancelled');
	}

	public completeConnected(): void {
		this.completeConnectedCalls += 1;
		this.emitConnected();
		this.emitTerminal('connected');
	}

	public async start(_credential: string, _pairing: Pairing): Promise<void> {
		this.startCalls += 1;
		this.state = 'waiting';
	}

	public emitConnected(): void {
		this.callbacks.onConnected(this);
	}

	public emitTerminal(state: Exclude<PairingSessionState, 'starting' | 'waiting'>): void {
		this.state = state;
		this.callbacks.onTerminal(this, state);
	}

	public emitDisposed(): void {
		this.callbacks.onDisposed(this);
	}
}

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

function createDisconnectCommandHarness(options: {
	connectionState?: TelegramConnectionState;
	alertsEnabled?: boolean;
	disconnectTelegram?: (credential: string) => Promise<void>;
	credential?: string;
	connectFlow?: ReturnType<typeof createTelegramConnectCommand>;
} = {}) {
	let connectionState = options.connectionState ?? 'connected';
	let alertsEnabled = options.alertsEnabled ?? true;
	let connectionStateRevision = 0;
	let disconnectCalls = 0;
	let cancelActivePairingSessionCalls = 0;
	let recoverRejectedCredentialCalls = 0;
	const appliedStates: TelegramConnectionState[] = [];
	const snapshots: Array<{ state: TelegramConnectionState; alertsEnabled: boolean }> = [];
	const messages: string[] = [];
	const store = new FakeCredentialStore(options.credential ?? INSTALLATION_CREDENTIAL);
	const record = () => snapshots.push({ state: connectionState, alertsEnabled });
	const beginAuthoritativeMutation = () => {
		connectionStateRevision += 1;
		record();
		return connectionStateRevision;
	};
	const applyConnectionState = (state: TelegramConnectionState) => {
		connectionStateRevision += 1;
		connectionState = state;
		if (!canEnableAlerts(state)) {
			alertsEnabled = false;
		}
		appliedStates.push(state);
		record();
	};
	const command = createTelegramDisconnectCommand({
		client: {
			disconnectTelegram: async (credential) => {
				disconnectCalls += 1;
				assert.strictEqual(credential, options.credential ?? INSTALLATION_CREDENTIAL);
				await (options.disconnectTelegram?.(credential) ?? Promise.resolve());
			},
		},
		store,
		getConnectionState: () => connectionState,
		beginAuthoritativeDisconnect: beginAuthoritativeMutation,
		getConnectionStateRevision: () => connectionStateRevision,
		applyConnectionState,
		forceAlertsOff: () => {
			alertsEnabled = false;
			record();
		},
		cancelActivePairingSession: () => {
			cancelActivePairingSessionCalls += 1;
			options.connectFlow?.cancelActiveSession();
		},
		isCredentialRejected: (error) => error instanceof InstallationCredentialRejectedError,
		recoverRejectedCredential: async () => {
			recoverRejectedCredentialCalls += 1;
			await store.deleteInstallationCredential();
		},
		showDisconnected: () => messages.push('disconnected'),
		showAlreadyDisconnected: () => messages.push('already-disconnected'),
		showError: (message) => messages.push(message),
	});

	return {
		command,
		store,
		appliedStates,
		snapshots,
		messages,
		applyConnectionState,
		beginAuthoritativeMutation,
		getConnectionState: () => connectionState,
		getAlertsEnabled: () => alertsEnabled,
		getConnectionStateRevision: () => connectionStateRevision,
		get disconnectCalls() { return disconnectCalls; },
		get cancelActivePairingSessionCalls() { return cancelActivePairingSessionCalls; },
		get recoverRejectedCredentialCalls() { return recoverRejectedCredentialCalls; },
	};
}

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

	test('connection-state presentation enforces canonical status text and ON invariants', () => {
		assert.strictEqual(statusBarText('connected', false), '$(bell-slash) Codex Alerts: OFF · $(send) ✓');
		assert.strictEqual(statusBarText('connected', true), '$(bell) Codex Alerts: ON · $(send) ✓');
		assert.strictEqual(statusBarText('disconnected', true), '$(bell-slash) Codex Alerts: OFF · $(send) ✕');
		assert.strictEqual(statusBarText('unknown', true), '$(bell-slash) Codex Alerts: OFF · $(send) ?');
		assert.strictEqual(canEnableAlerts('connected'), true);
		assert.strictEqual(canEnableAlerts('disconnected'), false);
		assert.strictEqual(canEnableAlerts('unknown'), false);
	});

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
		assert.ok(html.includes("script-src 'nonce-test-nonce'"));
		assert.ok(html.includes("base-uri 'none'"));
		assert.ok(html.includes("form-action 'none'"));
		assert.ok(html.includes('nonce="test-nonce"'));
		assert.ok(html.includes('acquireVsCodeApi()'));
		assert.strictEqual(html.includes('http://'), false);
		assert.strictEqual(html.includes('https://'), false);
		assert.strictEqual(html.includes(telegramUrl), false);
		assert.strictEqual(html.includes('opaque-token'), false);
		assert.strictEqual(html.includes('fetch('), false);
		assert.strictEqual(html.includes('XMLHttpRequest'), false);
		assert.strictEqual(html.includes('WebSocket'), false);
		assert.strictEqual(html.includes('localStorage'), false);
		assert.strictEqual(html.includes('sessionStorage'), false);
	});

	test('pairing panel accepts only exact action-only messages and expired markup has Close only', () => {
		for (const message of [
			{ type: 'copy-link' },
			{ type: 'open-on-this-device' },
			{ type: 'cancel' },
			{ type: 'close' },
		]) {
			assert.strictEqual(isPairingPanelMessage(message), true);
		}
		for (const message of [
			null,
			{},
			{ type: 'copy-link', telegramUrl: 'https://t.me/token' },
			{ type: 'unknown' },
			{ type: 7 },
			['copy-link'],
		]) {
			assert.strictEqual(isPairingPanelMessage(message), false);
		}

		const expiredHtml = renderTelegramPairingExpiredHtml('expired-nonce');
		assert.ok(expiredHtml.includes('Pairing expired'));
		assert.ok(expiredHtml.includes('This QR code is no longer valid.'));
		assert.ok(expiredHtml.includes('Run Connect Telegram again to create a new pairing.'));
		assert.ok(expiredHtml.includes('data-action="close"'));
		assert.strictEqual(expiredHtml.includes('data-action="copy-link"'), false);
		assert.strictEqual(expiredHtml.includes('data-action="open-on-this-device"'), false);
		assert.strictEqual(expiredHtml.includes('data-action="cancel"'), false);
		assert.strictEqual(expiredHtml.includes('opaque-token'), false);
	});

	test('cancelling during asynchronous panel construction leaves the starting session terminal and disposes the late panel', async () => {
		const timers = new FakeTimers();
		const latePanel = new FakePairingPanel();
		const panelCreation = new Deferred<TelegramPairingPanel>();
		let terminalCalls = 0;
		const session = new TelegramPairingSession({
			client: { getPairingStatus: async () => 'pending' },
			createPanel: async () => panelCreation.promise,
			writeClipboard: async () => undefined,
			openExternal: async () => undefined,
			onConnected: () => undefined,
			onTerminal: () => { terminalCalls += 1; },
			timers,
			maxPollDurationMs: 100,
		});

		const start = session.start(INSTALLATION_CREDENTIAL, futurePairing(100));
		assert.strictEqual(session.state, 'starting');
		session.cancel();
		panelCreation.resolve(latePanel as unknown as TelegramPairingPanel);
		await start;
		assert.strictEqual(session.state, 'cancelled');
		assert.strictEqual(terminalCalls, 1);
		assert.strictEqual(latePanel.isDisposed, true);
	});

	test('pairing session serializes polling and does not overlap status GETs', async () => {
		const timers = new FakeTimers();
		const panel = new FakePairingPanel();
		const firstPoll = new Deferred<PairingStatus>();
		let requests = 0;
		const session = new TelegramPairingSession({
			client: {
				getPairingStatus: async () => {
					requests += 1;
					return firstPoll.promise;
				},
			},
			createPanel: async () => panel as unknown as TelegramPairingPanel,
			writeClipboard: async () => undefined,
			openExternal: async () => undefined,
			onConnected: () => undefined,
			timers,
			pollIntervalMs: 3,
			maxPollDurationMs: 100,
		});

		await session.start(INSTALLATION_CREDENTIAL, futurePairing(100));
		assert.strictEqual(requests, 1);
		timers.advanceBy(50);
		assert.strictEqual(requests, 1);
		firstPoll.resolve('pending');
		await settlePromises();
		timers.advanceBy(3);
		assert.strictEqual(requests, 2);
		session.cancel();
	});

	test('pairing session handles duplicate Cancel and Cancel plus panel X exactly once', async () => {
		const timers = new FakeTimers();
		const panel = new FakePairingPanel();
		let terminalCalls = 0;
		const session = new TelegramPairingSession({
			client: { getPairingStatus: async () => new Promise<PairingStatus>(() => undefined) },
			createPanel: async () => panel as unknown as TelegramPairingPanel,
			writeClipboard: async () => undefined,
			openExternal: async () => undefined,
			onConnected: () => undefined,
			onTerminal: () => { terminalCalls += 1; },
			timers,
			maxPollDurationMs: 100,
		});

		await session.start(INSTALLATION_CREDENTIAL, futurePairing(100));
		panel.emitAction({ type: 'cancel' });
		panel.emitAction({ type: 'cancel' });
		panel.dispose();
		assert.strictEqual(session.state, 'cancelled');
		assert.strictEqual(terminalCalls, 1);
		assert.strictEqual(panel.disposeCalls, 2);
	});

	test('panel X cancels locally and stops future polling', async () => {
		const timers = new FakeTimers();
		const panel = new FakePairingPanel();
		let requests = 0;
		const session = new TelegramPairingSession({
			client: { getPairingStatus: async () => { requests += 1; return 'pending'; } },
			createPanel: async () => panel as unknown as TelegramPairingPanel,
			writeClipboard: async () => undefined,
			openExternal: async () => undefined,
			onConnected: () => undefined,
			timers,
			pollIntervalMs: 3,
			maxPollDurationMs: 100,
		});

		await session.start(INSTALLATION_CREDENTIAL, futurePairing(100));
		await settlePromises();
		panel.dispose();
		timers.advanceBy(99);
		await settlePromises();
		assert.strictEqual(session.state, 'cancelled');
		assert.strictEqual(requests, 1);
	});

	test('a connected in-flight status response is observed after local Cancel without reviving the panel', async () => {
		const timers = new FakeTimers();
		const panel = new FakePairingPanel();
		const poll = new Deferred<PairingStatus>();
		let connectedCalls = 0;
		const session = new TelegramPairingSession({
			client: { getPairingStatus: async () => poll.promise },
			createPanel: async () => panel as unknown as TelegramPairingPanel,
			writeClipboard: async () => undefined,
			openExternal: async () => undefined,
			onConnected: () => { connectedCalls += 1; },
			timers,
			maxPollDurationMs: 100,
		});

		await session.start(INSTALLATION_CREDENTIAL, futurePairing(100));
		panel.emitAction({ type: 'cancel' });
		poll.resolve('connected');
		await settlePromises();
		assert.strictEqual(session.state, 'cancelled');
		assert.strictEqual(connectedCalls, 1);
		assert.strictEqual(panel.disposeCalls, 1);
	});

	test('a pre-deadline connected GET beats the local expiry boundary', async () => {
		const timers = new FakeTimers();
		const panel = new FakePairingPanel();
		const poll = new Deferred<PairingStatus>();
		let connectedCalls = 0;
		const session = new TelegramPairingSession({
			client: { getPairingStatus: async () => poll.promise },
			createPanel: async () => panel as unknown as TelegramPairingPanel,
			writeClipboard: async () => undefined,
			openExternal: async () => undefined,
			onConnected: () => { connectedCalls += 1; },
			timers,
			maxPollDurationMs: 10,
		});

		await session.start(INSTALLATION_CREDENTIAL, futurePairing(10));
		timers.advanceBy(10);
		assert.strictEqual(session.state, 'waiting');
		poll.resolve('connected');
		await settlePromises();
		assert.strictEqual(session.state, 'connected');
		assert.strictEqual(connectedCalls, 1);
		assert.strictEqual(panel.disposeCalls, 1);
	});

	test('expiry waits for an in-flight pending or failed GET then keeps the expired panel open', async () => {
		for (const outcome of ['pending', 'failure'] as const) {
			const timers = new FakeTimers();
			const panel = new FakePairingPanel();
			const poll = new Deferred<PairingStatus>();
			const session = new TelegramPairingSession({
				client: { getPairingStatus: async () => poll.promise },
				createPanel: async () => panel as unknown as TelegramPairingPanel,
				writeClipboard: async () => undefined,
				openExternal: async () => undefined,
				onConnected: () => undefined,
				timers,
				maxPollDurationMs: 10,
			});

			await session.start(INSTALLATION_CREDENTIAL, futurePairing(10));
			timers.advanceBy(10);
			if (outcome === 'pending') {
				poll.resolve('pending');
			} else {
				poll.reject(new Error('temporary backend failure'));
			}
			await settlePromises();
			assert.strictEqual(session.state, 'expired');
			assert.strictEqual(panel.showExpiredCalls, 1);
			assert.strictEqual(panel.isDisposed, false);
		}
	});

	test('Copy and Open are explicit-only and ignored after expiry or cancellation', async () => {
		const timers = new FakeTimers();
		const panel = new FakePairingPanel();
		const poll = new Deferred<PairingStatus>();
		let copied = 0;
		let opened = 0;
		const session = new TelegramPairingSession({
			client: { getPairingStatus: async () => poll.promise },
			createPanel: async () => panel as unknown as TelegramPairingPanel,
			writeClipboard: async () => { copied += 1; },
			openExternal: async () => { opened += 1; },
			onConnected: () => undefined,
			timers,
			maxPollDurationMs: 10,
		});

		await session.start(INSTALLATION_CREDENTIAL, futurePairing(10));
		assert.strictEqual(copied, 0);
		assert.strictEqual(opened, 0);
		panel.emitAction({ type: 'copy-link' });
		panel.emitAction({ type: 'open-on-this-device' });
		await settlePromises();
		assert.strictEqual(copied, 1);
		assert.strictEqual(opened, 1);
		timers.advanceBy(10);
		poll.resolve('pending');
		await settlePromises();
		panel.emitAction({ type: 'copy-link' });
		panel.emitAction({ type: 'open-on-this-device' });
		await settlePromises();
		assert.strictEqual(session.state, 'expired');
		assert.strictEqual(copied, 1);
		assert.strictEqual(opened, 1);
		panel.emitAction({ type: 'close' });
		assert.strictEqual(panel.isDisposed, true);
	});

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

	test('extension contributes Telegram connection commands and delegates pairing lifecycle to one session', () => {
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
		const sessionSource = fs.readFileSync(path.resolve(__dirname, '../../src/telegram/TelegramPairingSession.ts'), 'utf8');
		assert.ok(extensionSource.includes('createTelegramConnectCommand'));
		assert.ok(extensionSource.includes('let activePairingSession: TelegramConnectSession | undefined'));
		assert.strictEqual(extensionSource.includes('pairingInProgress'), false);
		assert.strictEqual(extensionSource.includes('withProgress'), false);
		assert.ok(extensionSource.includes('getTelegramConnection(credential)'));
		assert.ok(extensionSource.includes('createPairing(credential)'));
		assert.ok(extensionSource.includes('createTelegramAlertsToggleCommand'));
		assert.ok(extensionSource.includes("if (existingSession.state === 'expired')"));
		assert.ok(extensionSource.includes('existingSession.reveal();'));
		assert.ok(extensionSource.includes('activePairingSession = session;'));
		assert.ok(extensionSource.includes('if (activePairingSession !== session || sessionRevision !== pairingSessionRevision)'));
		assert.ok(extensionSource.includes('if (activePairingSession !== completedSession)'));
		assert.ok(extensionSource.includes('sessionConnectionStateRevision === dependencies.getConnectionStateRevision()'));
		assert.ok(sessionSource.includes('DEFAULT_POLL_INTERVAL_MS = 3_000'));
		assert.ok(sessionSource.includes('pollInFlight'));
		assert.ok(extensionSource.includes("let alertsEnabled = false"));
		assert.ok(extensionSource.includes("let connectionState: TelegramConnectionState = 'unknown'"));
		assert.ok(extensionSource.includes('let connectionStateRevision = 0'));
		assert.ok(extensionSource.includes('createTelegramConnectionStateRefresh'));
		assert.ok(extensionSource.includes('beginAuthoritativeRefresh'));
		assert.ok(extensionSource.includes('const refreshRevision = dependencies.beginAuthoritativeRefresh()'));
		assert.ok(extensionSource.includes('dependencies.getConnectionStateRevision() === refreshRevision'));
		assert.ok(extensionSource.includes('createTelegramOnboarding'));
		assert.ok(extensionSource.includes('runTelegramActivationOnboarding'));
		assert.ok(extensionSource.includes('dependencies.onboarding.maybeShow(dependencies.getConnectionState())'));
		assert.ok(extensionSource.includes("applySessionConnectionState('connected')"));
		assert.ok(extensionSource.includes("applySessionConnectionState('disconnected')"));
	});

	test('pairing material is not persisted by extension state', () => {
		const extensionSource = fs.readFileSync(path.resolve(__dirname, '../../src/extension.ts'), 'utf8');
		const secretStoreSource = fs.readFileSync(path.resolve(__dirname, '../../src/state/SecretStore.ts'), 'utf8');

		assert.ok(extensionSource.includes(TELEGRAM_ONBOARDING_SHOWN_KEY));
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
