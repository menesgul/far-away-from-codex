import * as vscode from 'vscode';
import {
	BackendClient,
	BackendClientError,
	InstallationCredentialRejectedError,
	TelegramAlreadyConnectedError,
	type InstallationCredentialStore,
	type Pairing,
} from './backend/BackendClient';
import { SecretStore } from './state/SecretStore';
import {
	canEnableAlerts,
	resolveTelegramConnectionState,
	statusBarText,
	type TelegramConnectionState,
} from './state/TelegramConnectionState';
import {
	TelegramPairingSession,
	type PairingSessionState,
} from './telegram/TelegramPairingSession';
import { createTelegramDisconnectCommand } from './telegram/TelegramDisconnectCommand';
import { TelegramPairingPanel } from './ui/TelegramPairingPanel';

// This is application-owned, not read from workspace configuration. Replace it when the
// production Worker URL is provisioned; tests inject their own URL via BackendClient.
const PRODUCTION_BACKEND_URL = 'https://far-away-from-codex-worker.menesgul.workers.dev';

export type TelegramConnectIntent =
	| 'connect-only'
	| 'enable-alerts-after-connect';

export interface TelegramConnectSession {
	readonly state: PairingSessionState;
	reveal(): boolean;
	dispose(): void;
	cancel(): void;
	completeConnected(): void;
	start(credential: string, pairing: Pairing): Promise<void>;
}

export interface TelegramConnectSessionCallbacks {
	onConnected(session: TelegramConnectSession): void;
	onTerminal(session: TelegramConnectSession, state: Exclude<PairingSessionState, 'starting' | 'waiting'>): void;
	onDisposed(session: TelegramConnectSession): void;
}

export interface TelegramConnectClient {
	ensureInstallation(store: InstallationCredentialStore): Promise<string>;
	getTelegramConnection(credential: string): Promise<boolean>;
	createPairing(credential: string): Promise<Pairing>;
}

export interface TelegramConnectCommandDependencies {
	client: TelegramConnectClient;
	store: InstallationCredentialStore;
	createSession(callbacks: TelegramConnectSessionCallbacks): TelegramConnectSession;
	applyConnectionState(state: TelegramConnectionState): void;
	/** Enables alerts only after this command has verified a normal connected terminal state. */
	enableAlertsAfterConnect(): void;
	/** The extension-owned revision used to reject stale session side effects. */
	getConnectionStateRevision(): number;
	showConnected(): void;
	showError(message: string): void;
	now(): number;
}

export interface TelegramConnectCommand {
	execute(intent?: TelegramConnectIntent): Promise<void>;
	/** Cancels the current local attempt without changing server-side pairing state. */
	cancelActiveSession(): void;
	dispose(): void;
	getActiveSession(): TelegramConnectSession | undefined;
}

export interface TelegramAlertsToggleCommandDependencies {
	getConnectionState(): TelegramConnectionState;
	getAlertsEnabled(): boolean;
	setAlertsEnabled(enabled: boolean): void;
	refreshConnectionState(): Promise<void>;
	showDisconnectedPrompt(): Promise<'connect' | 'cancel' | undefined>;
	connectTelegram(intent: TelegramConnectIntent): Promise<void>;
}

/**
 * Routes a status-bar click from extension-owned state. The function owns no
 * state itself, keeping the activation lifecycle as the single owner while
 * making the canonical click behavior independently testable.
 */
export function createTelegramAlertsToggleCommand(
	dependencies: TelegramAlertsToggleCommandDependencies
): () => Promise<void> {
	return async () => {
		const connectionState = dependencies.getConnectionState();
		if (connectionState === 'unknown') {
			await dependencies.refreshConnectionState();
			// An unknown-state click is solely an authoritative retry. The result
			// changes the rendered state; a separate click performs its action.
			return;
		}

		if (connectionState === 'connected') {
			dependencies.setAlertsEnabled(!dependencies.getAlertsEnabled());
			return;
		}

		if (connectionState === 'disconnected') {
			if (await dependencies.showDisconnectedPrompt() === 'connect') {
				await dependencies.connectTelegram('enable-alerts-after-connect');
			}
		}
	};
}

export interface TelegramConnectionStateRefreshDependencies {
	resolveConnectionState(): Promise<TelegramConnectionState>;
	beginAuthoritativeRefresh(): number;
	getConnectionStateRevision(): number;
	applyConnectionState(state: TelegramConnectionState): void;
}

/**
 * Starts a single authoritative connection read. Beginning the read advances
 * the caller-owned revision immediately, so older pairing sessions lose
 * permission to mutate connection state before the network request settles.
 */
export function createTelegramConnectionStateRefresh(
	dependencies: TelegramConnectionStateRefreshDependencies
): () => Promise<void> {
	let inFlight: Promise<void> | undefined;

	return (): Promise<void> => {
		if (inFlight !== undefined) {
			return inFlight;
		}

		const refreshRevision = dependencies.beginAuthoritativeRefresh();
		const refresh = dependencies.resolveConnectionState()
			.then((nextState) => {
				if (dependencies.getConnectionStateRevision() === refreshRevision) {
					dependencies.applyConnectionState(nextState);
				}
			});
		inFlight = refresh;
		void refresh.finally(() => {
			if (inFlight === refresh) {
				inFlight = undefined;
			}
		});
		return refresh;
	};
}

/**
 * Owns exactly one Connect-command attempt. Keeping this small flow separate
 * from VS Code command registration makes the active-session and revision
 * guards explicit while leaving the panel and polling in their own classes.
 */
export function createTelegramConnectCommand(
	dependencies: TelegramConnectCommandDependencies
): TelegramConnectCommand {
	let activePairingSession: TelegramConnectSession | undefined;
	let pairingSessionRevision = 0;
	let activeIntent: TelegramConnectIntent = 'connect-only';

	const execute = async (intent: TelegramConnectIntent = 'connect-only'): Promise<void> => {
		const existingSession = activePairingSession;
		if (existingSession !== undefined) {
			if (existingSession.state === 'expired') {
				existingSession.dispose();
				if (activePairingSession === existingSession) {
					activePairingSession = undefined;
				}
			} else {
				// A status-bar request may raise the desired post-connect action, but a
				// later palette invocation must never lower it during this session.
				if (intent === 'enable-alerts-after-connect') {
					activeIntent = intent;
				}
				// A starting session has no panel yet; a waiting session reveals its panel.
				existingSession.reveal();
				return;
			}
		}

		const sessionRevision = ++pairingSessionRevision;
		activeIntent = intent;
		let sessionConnectionStateRevision = dependencies.getConnectionStateRevision();
		const applySessionConnectionState = (state: TelegramConnectionState): boolean => {
			// A cancellation may still receive a late trusted connected observation,
			// but a newer command or connection-state owner always wins.
			if (
				sessionRevision !== pairingSessionRevision
				|| sessionConnectionStateRevision !== dependencies.getConnectionStateRevision()
			) {
				return false;
			}
			dependencies.applyConnectionState(state);
			sessionConnectionStateRevision = dependencies.getConnectionStateRevision();
			return true;
		};
		let session: TelegramConnectSession;
		session = dependencies.createSession({
			onConnected: () => {
				// Local cancellation does not mean Telegram disconnected. Accept a
				// late trusted observation until a newer Connect attempt supersedes it.
				applySessionConnectionState('connected');
			},
			onTerminal: (completedSession, state) => {
				if (activePairingSession !== completedSession) {
					return;
				}
				if (state === 'connected') {
					dependencies.showConnected();
					if (
						activeIntent === 'enable-alerts-after-connect'
						&& sessionRevision === pairingSessionRevision
						&& sessionConnectionStateRevision === dependencies.getConnectionStateRevision()
					) {
						dependencies.enableAlertsAfterConnect();
					}
				}
				if (state !== 'expired') {
					activePairingSession = undefined;
				}
			},
			onDisposed: (disposedSession) => {
				if (activePairingSession === disposedSession && disposedSession.state === 'expired') {
					activePairingSession = undefined;
				}
			},
		});
		// Assign before any asynchronous work, including installation registration.
		activePairingSession = session;

		try {
			const credential = await dependencies.client.ensureInstallation(dependencies.store);
			if (activePairingSession !== session || sessionRevision !== pairingSessionRevision) {
				return;
			}

			const connected = await dependencies.client.getTelegramConnection(credential);
			if (sessionRevision !== pairingSessionRevision) {
				return;
			}
			if (activePairingSession !== session) {
				// A Cancel never revokes the server-side pairing or disbelieves a GET
				// already in flight. Preserve a late trusted connected observation, but
				// never resume the session or create pairing material after cancellation.
				if (connected) {
					applySessionConnectionState('connected');
				}
				return;
			}
			if (connected) {
				session.completeConnected();
				return;
			}
			applySessionConnectionState('disconnected');

			try {
				const pairing = await dependencies.client.createPairing(credential);
				if (activePairingSession !== session || sessionRevision !== pairingSessionRevision) {
					return;
				}
				if (pairing.expiresAt.getTime() <= dependencies.now()) {
					throw new BackendClientError('The backend returned an expired pairing.');
				}
				await session.start(credential, pairing);
			} catch (error) {
				if (!(error instanceof TelegramAlreadyConnectedError)) {
					throw error;
				}

				// Pairing creation raced with a server-side connection; resolve it using
				// the existing authoritative endpoint rather than creating another pairing.
				if (await dependencies.client.getTelegramConnection(credential)) {
					if (activePairingSession === session && sessionRevision === pairingSessionRevision) {
						session.completeConnected();
					}
					return;
				}
				throw error;
			}
		} catch (error) {
			if (activePairingSession === session) {
				session.cancel();
			}
			dependencies.showError(safeErrorMessage(error, 'Could not connect Telegram.'));
		}
	};

	return {
		execute,
		cancelActiveSession: () => {
			// Invalidate callbacks before cancelling: TelegramPairingSession may still
			// observe an in-flight trusted status response after local cancellation.
			pairingSessionRevision += 1;
			const session = activePairingSession;
			activePairingSession = undefined;
			session?.cancel();
		},
		dispose: () => {
			pairingSessionRevision += 1;
			activePairingSession?.dispose();
			activePairingSession = undefined;
		},
		getActiveSession: () => activePairingSession,
	};
}

export function activate(context: vscode.ExtensionContext) {
	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);
	const secretStore = new SecretStore(context.secrets);
	const backendClient = new BackendClient(PRODUCTION_BACKEND_URL);
	let alertsEnabled = false;
	let connectionState: TelegramConnectionState = 'unknown';
	let connectionStateRevision = 0;

	statusBarItem.command = 'far-away-from-codex.toggleAlerts';
	statusBarItem.tooltip = 'Click to enable or disable Codex phone alerts';

	const updateStatusBar = () => {
		statusBarItem.text = statusBarText(connectionState, alertsEnabled);
	};

	const applyConnectionState = (nextState: TelegramConnectionState) => {
		connectionStateRevision += 1;
		connectionState = nextState;
		if (!canEnableAlerts(connectionState)) {
			alertsEnabled = false;
		}
		updateStatusBar();
	};

	const refreshConnectionState = createTelegramConnectionStateRefresh({
		resolveConnectionState: () => resolveTelegramConnectionState(secretStore, backendClient),
		beginAuthoritativeRefresh: () => {
			connectionStateRevision += 1;
			return connectionStateRevision;
		},
		getConnectionStateRevision: () => connectionStateRevision,
		applyConnectionState,
	});

	const connectFlow = createTelegramConnectCommand({
		client: backendClient,
		store: secretStore,
		createSession: (callbacks) => new TelegramPairingSession({
			client: backendClient,
			createPanel: TelegramPairingPanel.create,
			writeClipboard: (telegramUrl) => vscode.env.clipboard.writeText(telegramUrl),
			openExternal: (telegramUrl) => vscode.env.openExternal(vscode.Uri.parse(telegramUrl)),
			...callbacks,
		}),
		applyConnectionState,
		getConnectionStateRevision: () => connectionStateRevision,
		enableAlertsAfterConnect: () => {
			if (canEnableAlerts(connectionState)) {
				alertsEnabled = true;
				updateStatusBar();
			}
		},
		showConnected: () => { void vscode.window.showInformationMessage('Telegram is connected.'); },
		showError: (message) => { void vscode.window.showErrorMessage(message); },
		now: () => Date.now(),
	});

	const toggleCommand = vscode.commands.registerCommand(
		'far-away-from-codex.toggleAlerts',
		createTelegramAlertsToggleCommand({
			getConnectionState: () => connectionState,
			getAlertsEnabled: () => alertsEnabled,
			setAlertsEnabled: (enabled) => {
				alertsEnabled = enabled;
				updateStatusBar();
			},
			refreshConnectionState,
			showDisconnectedPrompt: async () => {
				const selection = await vscode.window.showInformationMessage(
					'Telegram is not connected.',
					'Connect Telegram',
					'Cancel'
				);
				return selection === 'Connect Telegram' ? 'connect' : 'cancel';
			},
			connectTelegram: (intent) => connectFlow.execute(intent),
		})
	);

	const connectTelegramCommand = vscode.commands.registerCommand(
		'far-away-from-codex.connectTelegram',
		connectFlow.execute
	);

	const disconnectFlow = createTelegramDisconnectCommand({
		client: backendClient,
		store: secretStore,
		getConnectionState: () => connectionState,
		beginAuthoritativeDisconnect: () => {
			connectionStateRevision += 1;
			return connectionStateRevision;
		},
		getConnectionStateRevision: () => connectionStateRevision,
		applyConnectionState,
		forceAlertsOff: () => {
			alertsEnabled = false;
			updateStatusBar();
		},
		cancelActivePairingSession: () => connectFlow.cancelActiveSession(),
		isCredentialRejected: (error) => error instanceof InstallationCredentialRejectedError,
		recoverRejectedCredential: () => secretStore.deleteInstallationCredential(),
		showDisconnected: () => { void vscode.window.showInformationMessage('Telegram is disconnected.'); },
		showAlreadyDisconnected: () => {
			void vscode.window.showInformationMessage('Telegram is already disconnected.');
		},
		showError: (message) => { void vscode.window.showErrorMessage(message); },
	});

	const disconnectTelegramCommand = vscode.commands.registerCommand(
		'far-away-from-codex.disconnectTelegram',
		disconnectFlow.execute
	);

	const testNotificationCommand = vscode.commands.registerCommand(
		'far-away-from-codex.testNotification',
		async () => {
			void vscode.window.showErrorMessage('Test notifications are not available yet.');
		}
	);

	updateStatusBar();
	statusBarItem.show();
	void refreshConnectionState();

	context.subscriptions.push(
		{
			dispose: () => {
				connectFlow.dispose();
			},
		},
		statusBarItem,
		toggleCommand,
		connectTelegramCommand,
		disconnectTelegramCommand,
		testNotificationCommand
	);
}

export function deactivate() {}

function safeErrorMessage(error: unknown, fallback: string): string {
	return error instanceof BackendClientError ? error.message : fallback;
}
