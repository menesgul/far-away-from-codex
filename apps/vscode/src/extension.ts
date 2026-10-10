import * as vscode from 'vscode';
import { BackendClient, InstallationCredentialRejectedError } from './backend/BackendClient';
import { CompanionClient } from './companion/CompanionClient';
import { createCompanionStatusProjection, type CompanionStatusClient } from './companion/CompanionStatusProjection';
import { SecretStore } from './state/SecretStore';
import {
	canEnableAlerts, resolveTelegramConnectionState, statusBarText,
	type TelegramConnectionState,
} from './state/TelegramConnectionState';
import { createTelegramConnectionStateRefresh } from './state/TelegramConnectionStateRefresh';
import { createTelegramAlertsToggleCommand } from './telegram/TelegramAlertsToggleCommand';
import { createTelegramConnectCommand, type TelegramConnectIntent, type TelegramConnectCommandDependencies } from './telegram/TelegramConnectCommand';
import { createTelegramDisconnectCommand } from './telegram/TelegramDisconnectCommand';
import { LegacyTelegramCommandCoordinator } from './telegram/LegacyTelegramCommandCoordinator';
import { createTelegramOnboarding, runTelegramActivationOnboarding, TELEGRAM_ONBOARDING_SHOWN_KEY } from './telegram/TelegramOnboarding';
import { TelegramPairingSession } from './telegram/TelegramPairingSession';
import { TelegramPairingPanel } from './ui/TelegramPairingPanel';

// This is application-owned, not read from workspace configuration. Replace it when the
// production Worker URL is provisioned; tests inject their own URL via BackendClient.
const PRODUCTION_BACKEND_URL = 'https://far-away-from-codex-worker.menesgul.workers.dev';

interface LegacyTelegramRuntime {
	toggleAlerts(): Promise<void>;
	connectTelegram(intent?: TelegramConnectIntent): Promise<void>;
	disconnectTelegram(): Promise<void>;
	dispose(): void;
}

interface ActivationServices {
	createCompanionClient(): CompanionStatusClient;
	createLegacyTelegramRuntime(context: vscode.ExtensionContext): LegacyTelegramRuntime;
	createStatusBarItem(alignment: vscode.StatusBarAlignment, priority: number): vscode.StatusBarItem;
	registerCommand(command: string, callback: (...args: unknown[]) => unknown): vscode.Disposable;
}

/** Narrow factory inputs let tests exercise the production legacy dispatch without cloud/UI side effects. */
export interface LegacyTelegramRuntimeServices {
	backendClient?: BackendClient;
	secretStore?: SecretStore;
	statusBarItem?: vscode.StatusBarItem;
	createSession?: TelegramConnectCommandDependencies['createSession'];
	showInformationMessage?: (message: string, ...buttons: string[]) => Thenable<string | undefined>;
	showErrorMessage?: (message: string) => void;
}

/** The optional services argument is a local test seam; VS Code invokes this with context only. */
export function activate(context: vscode.ExtensionContext, services: Partial<ActivationServices> = {}): void {
	const createStatusBarItem = services.createStatusBarItem ?? ((alignment, priority) =>
		vscode.window.createStatusBarItem(alignment, priority));
	const registerCommand = services.registerCommand ?? ((command, callback) =>
		vscode.commands.registerCommand(command, callback));
	const companionItem = createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	companionItem.command = 'far-away-from-codex.refreshCompanionStatus';
	companionItem.tooltip = 'Last local Companion IPC check. Click to check again.';
	companionItem.text = 'Companion: Checking';
	let disposed = false;
	let companion: ReturnType<typeof createCompanionStatusProjection> | undefined;
	const probeCompanion = async (): Promise<void> => {
		if (disposed) { return; }
		try {
			companion ??= createCompanionStatusProjection(
				(services.createCompanionClient ?? (() => new CompanionClient()))(),
				(text) => { companionItem.text = text; },
			);
			await companion.probe();
		} catch {
			// A bad local locator is an optional-client failure, never an activation failure.
			if (!disposed) { companionItem.text = 'Companion: Unavailable'; }
		}
	};

	let legacy: LegacyTelegramRuntime | undefined;
	const getLegacy = (): LegacyTelegramRuntime => {
		legacy ??= (services.createLegacyTelegramRuntime ?? createLegacyTelegramRuntime)(context);
		return legacy;
	};
	const owned: vscode.Disposable[] = [
		{ dispose: () => { disposed = true; companion?.dispose(); legacy?.dispose(); } },
		companionItem,
	];
	try {
		companionItem.show();
		owned.push(registerCommand('far-away-from-codex.refreshCompanionStatus', probeCompanion));
		owned.push(registerCommand('far-away-from-codex.toggleAlerts', () => getLegacy().toggleAlerts()));
		owned.push(registerCommand('far-away-from-codex.connectTelegram', () => getLegacy().connectTelegram()));
		owned.push(registerCommand('far-away-from-codex.disconnectTelegram', () => getLegacy().disconnectTelegram()));
		owned.push(registerCommand('far-away-from-codex.testNotification', () => {
			void vscode.window.showErrorMessage('Test notifications are not available yet.');
		}));
		context.subscriptions.push(...owned);
	} catch (error) {
		for (const resource of owned) { resource.dispose(); }
		throw error;
	}
	// All commands and disposables exist before the bounded IPC probe starts.
	queueMicrotask(() => { void probeCompanion(); });
}

export function createLegacyTelegramRuntime(
	context: vscode.ExtensionContext, services: LegacyTelegramRuntimeServices = {},
): LegacyTelegramRuntime {
	const statusBarItem = services.statusBarItem ?? vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	const secretStore = services.secretStore ?? new SecretStore(context.secrets);
	const backendClient = services.backendClient ?? new BackendClient(PRODUCTION_BACKEND_URL);
	const showInformationMessage = services.showInformationMessage ??
		((message: string, ...buttons: string[]) => vscode.window.showInformationMessage(message, ...buttons));
	const showErrorMessage = services.showErrorMessage ??
		((message: string) => { void vscode.window.showErrorMessage(message); });
	let alertsEnabled = false;
	let connectionState: TelegramConnectionState = 'unknown';
	let connectionStateRevision = 0;
	const coordinator = new LegacyTelegramCommandCoordinator();
	let onboardingAttempted = false;
	let initialToggleInFlight: { owner: number; promise: Promise<void> } | undefined;
	let queuedConnect: { owner: number; intent: TelegramConnectIntent; promise: Promise<void> } | undefined;
	let activeDisconnect: { owner: number; promise: Promise<void>; toggleTail?: Promise<void> } | undefined;
	let disposed = false;

	statusBarItem.command = 'far-away-from-codex.toggleAlerts';
	statusBarItem.tooltip = 'Click to enable or disable Codex phone alerts';
	const updateStatusBar = () => {
		if (!disposed) { statusBarItem.text = statusBarText(connectionState, alertsEnabled); }
	};
	const applyConnectionState = (nextState: TelegramConnectionState) => {
		if (disposed) { return; }
		connectionStateRevision += 1;
		connectionState = nextState;
		if (!canEnableAlerts(connectionState)) { alertsEnabled = false; }
		updateStatusBar();
	};
	const refreshConnectionState = createTelegramConnectionStateRefresh({
		resolveConnectionState: (owner) => resolveTelegramConnectionState(
			{
				getInstallationCredential: () => secretStore.getInstallationCredential(),
				saveInstallationCredential: (credential) => secretStore.saveInstallationCredential(credential),
				deleteInstallationCredential: () => coordinator.recoverCredential(
					owner ?? -1, () => secretStore.deleteInstallationCredential(),
				),
			},
			backendClient, () => owner !== undefined && coordinator.owns(owner),
		),
		beginAuthoritativeRefresh: () => ++connectionStateRevision,
		getConnectionStateRevision: () => connectionStateRevision,
		applyConnectionState,
	});
	const connectFlow = createTelegramConnectCommand({
		client: backendClient,
		store: secretStore,
		createSession: services.createSession ?? ((callbacks) => new TelegramPairingSession({
			client: backendClient,
			createPanel: TelegramPairingPanel.create,
			writeClipboard: (telegramUrl) => vscode.env.clipboard.writeText(telegramUrl),
			openExternal: (telegramUrl) => vscode.env.openExternal(vscode.Uri.parse(telegramUrl)),
			...callbacks,
		})),
		applyConnectionState,
		getConnectionStateRevision: () => connectionStateRevision,
		enableAlertsAfterConnect: () => {
			if (canEnableAlerts(connectionState)) { alertsEnabled = true; updateStatusBar(); }
		},
		showConnected: () => { if (!disposed) { void showInformationMessage('Telegram is connected.'); } },
		showError: (message) => { if (!disposed) { showErrorMessage(message); } },
		now: () => Date.now(),
	});
	const connectTelegram = (intent: TelegramConnectIntent = 'connect-only'): Promise<void> => {
		if (disposed) { return Promise.resolve(); }
		onboardingAttempted = true;
		const active = connectFlow.getActiveSession();
		const share = coordinator.currentKind() === 'connect'
			&& (queuedConnect !== undefined || (active !== undefined && active.state !== 'expired'));
		const owner = coordinator.claim('connect', share);
		if (!share) { connectionStateRevision += 1; }
		if (queuedConnect?.owner === owner) {
			if (intent === 'enable-alerts-after-connect') { queuedConnect.intent = intent; }
			return queuedConnect.promise;
		}
		const barrier = coordinator.deleteBarrier();
		const credentialBarrier = coordinator.credentialBarrier();
		if (barrier || credentialBarrier) {
			const pending = { owner, intent, promise: Promise.resolve() as Promise<void> };
			const attempt = (async () => {
				if (credentialBarrier) {
					try { await credentialBarrier; }
					catch {
						if (coordinator.owns(owner)) {
							applyConnectionState('unknown');
							showErrorMessage('Could not access the Telegram credential. Try Connect again.');
						}
						return;
					}
				}
				const outcome = barrier ? await barrier : 'confirmed';
				if (!coordinator.owns(owner)) { return; }
				if (outcome === 'uncertain') {
					applyConnectionState('unknown');
					showErrorMessage('Could not confirm whether Telegram was disconnected. Try Connect again.');
					return;
				}
				await connectFlow.execute(pending.intent);
			})();
			pending.promise = attempt;
			queuedConnect = pending;
			void attempt.then(() => { if (queuedConnect === pending) { queuedConnect = undefined; } },
				() => { if (queuedConnect === pending) { queuedConnect = undefined; } });
			return attempt;
		}
		return connectFlow.execute(intent);
	};
	const onboarding = createTelegramOnboarding({
		globalState: context.globalState,
		showPrompt: (message, firstButton, secondButton) => showInformationMessage(
			message, firstButton, secondButton,
		),
		connectTelegram: () => connectTelegram('enable-alerts-after-connect'),
	});
	const toggleCommand = createTelegramAlertsToggleCommand({
		getConnectionState: () => connectionState,
		getAlertsEnabled: () => alertsEnabled,
		setAlertsEnabled: (enabled) => { alertsEnabled = enabled; updateStatusBar(); },
		refreshConnectionState,
		showDisconnectedPrompt: async () => {
			const selection = await showInformationMessage(
				'Telegram is not connected.', 'Connect Telegram', 'Cancel',
			);
			return selection === 'Connect Telegram' ? 'connect' : 'cancel';
		},
		connectTelegram: (intent) => connectTelegram(intent),
		isCurrentOwner: (owner) => coordinator.owns(owner),
	});
	const disconnectFlow = createTelegramDisconnectCommand({
		client: { disconnectTelegram: (credential, owner = 0) =>
			coordinator.issueDelete(owner, () => backendClient.disconnectTelegram(credential)) },
		store: secretStore,
		getConnectionState: () => connectionState,
		beginAuthoritativeDisconnect: () => ++connectionStateRevision,
		getConnectionStateRevision: () => connectionStateRevision,
		applyConnectionState,
		forceAlertsOff: () => { alertsEnabled = false; updateStatusBar(); },
		cancelActivePairingSession: () => connectFlow.cancelActiveSession(),
		isCredentialRejected: (error) => error instanceof InstallationCredentialRejectedError,
		recoverRejectedCredential: (owner = -1) => coordinator.recoverCredential(
			owner, () => secretStore.deleteInstallationCredential(),
		),
		showDisconnected: () => { if (!disposed) { void showInformationMessage('Telegram is disconnected.'); } },
		showAlreadyDisconnected: () => {
		if (!disposed) { void showInformationMessage('Telegram is already disconnected.'); }
		},
		showError: (message) => { if (!disposed) { showErrorMessage(message); } },
	});

	updateStatusBar();
	statusBarItem.show();
	const disconnectTelegram = (): Promise<void> => {
		if (disposed) { return Promise.resolve(); }
		onboardingAttempted = true;
		const share = coordinator.currentKind() === 'disconnect'
			&& activeDisconnect !== undefined && coordinator.owns(activeDisconnect.owner)
			&& coordinator.isLatestIntent(activeDisconnect.owner);
		const owner = coordinator.claim('disconnect', share);
		if (share) { return activeDisconnect!.promise; }
		const attempt = disconnectFlow.execute(owner);
		const pending = { owner, promise: attempt };
		activeDisconnect = pending;
		void attempt.then(() => { if (activeDisconnect === pending) { activeDisconnect = undefined; } },
			() => { if (activeDisconnect === pending) { activeDisconnect = undefined; } });
		return attempt;
	};
	const toggleAlerts = (): Promise<void> => {
		if (disposed) { return Promise.resolve(); }
		if (connectionState !== 'connected' && coordinator.currentKind() === 'connect'
			&& (queuedConnect !== undefined || connectFlow.getActiveSession() !== undefined)) {
			return connectTelegram('enable-alerts-after-connect');
		}
		if (activeDisconnect && coordinator.currentKind() === 'disconnect'
			&& coordinator.owns(activeDisconnect.owner)) {
			const pending = activeDisconnect;
			const intent = coordinator.claimDeferredToggle();
			const predecessor = pending.toggleTail ?? pending.promise;
			const resume = () => {
				if (!coordinator.ownsDeferredToggle(intent)) { return; }
				return toggleAlerts();
			};
			const attempt = predecessor.then(resume, resume);
			pending.toggleTail = attempt;
			return attempt;
		}
		if (initialToggleInFlight) {
			const pending = initialToggleInFlight;
			if (coordinator.owns(pending.owner)) {
				if (connectionState !== 'connected') {
					// Unknown discovery and the current onboarding prompt are one intent.
					return pending.promise;
				}
				// A newly connected projection makes this a distinct actionable click.
				onboardingAttempted = true;
				initialToggleInFlight = undefined;
			}
			// A stale prompt cannot hold a newer click; a connected projection
			// likewise makes the new click independently actionable.
			initialToggleInFlight = undefined;
		}
		const owner = coordinator.claim('toggle');
		if (onboardingAttempted) { return toggleCommand(owner); }
		const attempt = (async () => {
			const wasOnboarded = context.globalState.get<boolean>(TELEGRAM_ONBOARDING_SHOWN_KEY) === true;
			const startedUnknown = connectionState === 'unknown';
			if (startedUnknown) {
				try {
					await runTelegramActivationOnboarding({
						refreshConnectionState: () => refreshConnectionState(owner),
						getConnectionState: () => coordinator.owns(owner) ? connectionState : 'unknown',
						onboarding,
						isCurrent: () => coordinator.owns(owner),
					});
				} catch {
					// A failed refresh/onboarding presentation stays eligible for retry.
					return;
				}
			} else if (connectionState === 'disconnected' && !wasOnboarded) {
				try { await onboarding.maybeShow(connectionState, () => coordinator.owns(owner)); }
				catch { return; }
			}
			if (!coordinator.owns(owner) || connectionState === 'unknown') { return; }
			if (connectionState === 'disconnected' && !wasOnboarded) {
				onboardingAttempted = true;
				return;
			}
			onboardingAttempted = true;
			if (startedUnknown) { return; }
			await toggleCommand(owner);
		})();
		const pending = { owner, promise: attempt };
		initialToggleInFlight = pending;
		void attempt.then(() => { if (initialToggleInFlight === pending) { initialToggleInFlight = undefined; } },
			() => { if (initialToggleInFlight === pending) { initialToggleInFlight = undefined; } });
		return attempt;
	};
	return {
		toggleAlerts,
		connectTelegram,
		disconnectTelegram,
		dispose: () => {
			disposed = true;
			coordinator.dispose();
			onboarding.dispose();
			connectFlow.dispose();
			statusBarItem.dispose();
		},
	};
}

export function deactivate() {}
