import * as vscode from 'vscode';
import {
	BackendClient,
	InstallationCredentialRejectedError,
} from './backend/BackendClient';
import { SecretStore } from './state/SecretStore';
import {
	canEnableAlerts,
	resolveTelegramConnectionState,
	statusBarText,
	type TelegramConnectionState,
} from './state/TelegramConnectionState';
import { TelegramPairingSession } from './telegram/TelegramPairingSession';
import { createTelegramDisconnectCommand } from './telegram/TelegramDisconnectCommand';
import { TelegramPairingPanel } from './ui/TelegramPairingPanel';

import { createTelegramConnectCommand } from './telegram/TelegramConnectCommand';
import { createTelegramOnboarding, runTelegramActivationOnboarding } from './telegram/TelegramOnboarding';
import { createTelegramConnectionStateRefresh } from './state/TelegramConnectionStateRefresh';
import { createTelegramAlertsToggleCommand } from './telegram/TelegramAlertsToggleCommand';

// This is application-owned, not read from workspace configuration. Replace it when the
// production Worker URL is provisioned; tests inject their own URL via BackendClient.
const PRODUCTION_BACKEND_URL = 'https://far-away-from-codex-worker.menesgul.workers.dev';

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
	const onboarding = createTelegramOnboarding({
		globalState: context.globalState,
		showPrompt: (message, firstButton, secondButton) => vscode.window.showInformationMessage(
			message,
			firstButton,
			secondButton
		),
		connectTelegram: (intent) => connectFlow.execute(intent),
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
	void runTelegramActivationOnboarding({
		refreshConnectionState,
		getConnectionState: () => connectionState,
		onboarding,
	}).catch(() => undefined);

	context.subscriptions.push(
		{
			dispose: () => {
				onboarding.dispose();
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
