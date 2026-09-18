import {
	BackendClientError,
	TelegramAlreadyConnectedError,
	type InstallationCredentialStore,
	type Pairing,
} from '../backend/BackendClient';
import type { TelegramConnectionState } from '../state/TelegramConnectionState';
import type { PairingSessionState } from './TelegramPairingSession';

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

function safeErrorMessage(error: unknown, fallback: string): string {
	return error instanceof BackendClientError ? error.message : fallback;
}
