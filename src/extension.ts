import * as vscode from 'vscode';
import { BackendClient, BackendClientError, type Pairing } from './backend/BackendClient';
import { SecretStore } from './state/SecretStore';
import {
	canEnableAlerts,
	resolveTelegramConnectionState,
	statusBarText,
	type TelegramConnectionState,
} from './state/TelegramConnectionState';

// This is application-owned, not read from workspace configuration. Replace it when the
// production Worker URL is provisioned; tests inject their own URL via BackendClient.
const PRODUCTION_BACKEND_URL = 'https://far-away-from-codex-worker.menesgul.workers.dev';
const PAIRING_POLL_INTERVAL_MS = 3_000;
const MAX_PAIRING_POLL_DURATION_MS = 5 * 60 * 1_000;

export function activate(context: vscode.ExtensionContext) {
	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);
	const secretStore = new SecretStore(context.secrets);
	const backendClient = new BackendClient(PRODUCTION_BACKEND_URL);
	let pairingInProgress = false;
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

	const connectTelegramCommand = vscode.commands.registerCommand(
		'far-away-from-codex.connectTelegram',
		async () => {
			if (pairingInProgress) {
				void vscode.window.showInformationMessage('A Telegram pairing is already in progress.');
				return;
			}

			pairingInProgress = true;
			try {
				const credential = await backendClient.ensureInstallation(secretStore);
				const pairing = await backendClient.createPairing(credential);
				if (pairing.expiresAt.getTime() <= Date.now()) {
					throw new BackendClientError('The backend returned an expired pairing.');
				}

				const wasOpened = await vscode.env.openExternal(vscode.Uri.parse(pairing.telegramUrl));
				if (!wasOpened) {
					throw new BackendClientError('Could not open Telegram.');
				}

				const outcome = await pollForPairing(backendClient, credential, pairing);
				if (outcome === 'connected') {
					applyConnectionState('connected');
					void vscode.window.showInformationMessage('Telegram is connected.');
				} else if (outcome === 'expired') {
					void vscode.window.showErrorMessage('Telegram pairing expired. Please try again.');
				} else {
					void vscode.window.showInformationMessage('Telegram pairing was cancelled.');
				}
			} catch (error) {
				void vscode.window.showErrorMessage(safeErrorMessage(error, 'Could not connect Telegram.'));
			} finally {
				pairingInProgress = false;
			}
		}
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
		statusBarItem,
		toggleCommand,
		connectTelegramCommand,
		disconnectTelegramCommand,
		testNotificationCommand
	);
}

export function deactivate() {}

async function pollForPairing(
	client: BackendClient,
	credential: string,
	pairing: Pairing
): Promise<'connected' | 'expired' | 'cancelled'> {
	const deadline = Math.min(
		pairing.expiresAt.getTime(),
		Date.now() + MAX_PAIRING_POLL_DURATION_MS
	);

	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Waiting for Telegram pairing',
			cancellable: true,
		},
		async (_progress, cancellationToken) => {
			while (!cancellationToken.isCancellationRequested && Date.now() < deadline) {
				const status = await client.getPairingStatus(credential, pairing.pairingId);
				if (cancellationToken.isCancellationRequested) {
					return 'cancelled';
				}
				if (status === 'connected' || status === 'expired') {
					return status;
				}

				if (!await waitForNextPoll(cancellationToken, deadline)) {
					return cancellationToken.isCancellationRequested ? 'cancelled' : 'expired';
				}
			}

			return cancellationToken.isCancellationRequested ? 'cancelled' : 'expired';
		}
	);
}

function waitForNextPoll(token: vscode.CancellationToken, deadline: number): Promise<boolean> {
	const remaining = deadline - Date.now();
	if (remaining <= 0 || token.isCancellationRequested) {
		return Promise.resolve(false);
	}

	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			disposable.dispose();
			resolve(true);
		}, Math.min(PAIRING_POLL_INTERVAL_MS, remaining));
		const disposable = token.onCancellationRequested(() => {
			clearTimeout(timeout);
			disposable.dispose();
			resolve(false);
		});
	});
}

function safeErrorMessage(error: unknown, fallback: string): string {
	return error instanceof BackendClientError ? error.message : fallback;
}
