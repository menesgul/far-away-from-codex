import * as vscode from 'vscode';
import {
	BackendClient,
	BackendClientError,
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
import { TelegramPairingPanel } from './ui/TelegramPairingPanel';

// This is application-owned, not read from workspace configuration. Replace it when the
// production Worker URL is provisioned; tests inject their own URL via BackendClient.
const PRODUCTION_BACKEND_URL = 'https://far-away-from-codex-worker.menesgul.workers.dev';

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
	showConnected(): void;
	showError(message: string): void;
	now(): number;
}

export interface TelegramConnectCommand {
	execute(): Promise<void>;
	dispose(): void;
	getActiveSession(): TelegramConnectSession | undefined;
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

	const execute = async (): Promise<void> => {
		const existingSession = activePairingSession;
		if (existingSession !== undefined) {
			if (existingSession.state === 'expired') {
				existingSession.dispose();
				if (activePairingSession === existingSession) {
					activePairingSession = undefined;
				}
			} else {
				// A starting session has no panel yet; a waiting session reveals its panel.
				existingSession.reveal();
				return;
			}
		}

		const sessionRevision = ++pairingSessionRevision;
		let session: TelegramConnectSession;
		session = dependencies.createSession({
			onConnected: () => {
				// Local cancellation does not mean Telegram disconnected. Accept a
				// late trusted observation until a newer Connect attempt supersedes it.
				if (sessionRevision === pairingSessionRevision) {
					dependencies.applyConnectionState('connected');
				}
			},
			onTerminal: (completedSession, state) => {
				if (activePairingSession !== completedSession) {
					return;
				}
				if (state === 'connected') {
					dependencies.showConnected();
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
			if (activePairingSession !== session || sessionRevision !== pairingSessionRevision) {
				return;
			}
			if (connected) {
				session.completeConnected();
				return;
			}
			dependencies.applyConnectionState('disconnected');

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
		dispose: () => {
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
	let connectionRefreshInFlight: Promise<void> | undefined;

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

	const refreshConnectionState = (): Promise<void> => {
		if (connectionRefreshInFlight !== undefined) {
			return connectionRefreshInFlight;
		}

		const refreshRevision = connectionStateRevision;
		const refresh = resolveTelegramConnectionState(secretStore, backendClient)
			.then((nextState) => {
				if (connectionStateRevision === refreshRevision) {
					applyConnectionState(nextState);
				}
			});
		connectionRefreshInFlight = refresh;
		void refresh.finally(() => {
			if (connectionRefreshInFlight === refresh) {
				connectionRefreshInFlight = undefined;
			}
		});
		return refresh;
	};

	const toggleCommand = vscode.commands.registerCommand(
		'far-away-from-codex.toggleAlerts',
		() => {
			if (connectionState === 'unknown') {
				void refreshConnectionState();
				return;
			}

			if (!canEnableAlerts(connectionState)) {
				void vscode.window.showInformationMessage('Telegram is not connected.');
				return;
			}

			alertsEnabled = !alertsEnabled;
			updateStatusBar();
		}
	);

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
		showConnected: () => { void vscode.window.showInformationMessage('Telegram is connected.'); },
		showError: (message) => { void vscode.window.showErrorMessage(message); },
		now: () => Date.now(),
	});

	const connectTelegramCommand = vscode.commands.registerCommand(
		'far-away-from-codex.connectTelegram',
		connectFlow.execute
	);

	const disconnectTelegramCommand = vscode.commands.registerCommand(
		'far-away-from-codex.disconnectTelegram',
		async () => {
			try {
				const credential = await secretStore.getInstallationCredential();
				if (credential === undefined) {
					throw new BackendClientError('No anonymous installation is registered.');
				}

				await backendClient.disconnectTelegram(credential);
				applyConnectionState('disconnected');
				void vscode.window.showInformationMessage('Telegram is disconnected.');
			} catch (error) {
				void vscode.window.showErrorMessage(safeErrorMessage(error, 'Could not disconnect Telegram.'));
			}
		}
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
