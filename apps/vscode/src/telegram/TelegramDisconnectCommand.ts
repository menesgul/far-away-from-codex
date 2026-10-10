import type { InstallationCredentialStore } from '../backend/BackendClient';
import type { TelegramConnectionState } from '../state/TelegramConnectionState';

export interface TelegramDisconnectClient {
	disconnectTelegram(credential: string, owner?: number): Promise<void>;
}

export interface TelegramDisconnectCommandDependencies {
	client: TelegramDisconnectClient;
	store: Pick<InstallationCredentialStore, 'getInstallationCredential'>;
	getConnectionState(): TelegramConnectionState;
	/** Advances extension-owned authority before any asynchronous disconnect work. */
	beginAuthoritativeDisconnect(): number;
	getConnectionStateRevision(): number;
	applyConnectionState(state: TelegramConnectionState): void;
	forceAlertsOff(): void;
	cancelActivePairingSession(): boolean | void;
	isCredentialRejected(error: unknown): boolean;
	/** Local identity recovery; this is not a confirmed Telegram disconnect. */
	recoverRejectedCredential(owner?: number): Promise<void>;
	showDisconnected(): void;
	showAlreadyDisconnected(): void;
	showError(message: string): void;
}

export interface TelegramDisconnectCommand {
	execute(owner?: number): Promise<void>;
}

/**
 * Performs the one authoritative local mutation for Telegram Disconnect.
 *
 * The extension continues to own rendered state and its revision counter. This
 * command only coordinates that authority with the authenticated DELETE, so a
 * request with an unknown outcome cannot be mistaken for a confirmed delete.
 */
export function createTelegramDisconnectCommand(
	dependencies: TelegramDisconnectCommandDependencies
): TelegramDisconnectCommand {
	let disconnectInFlight: { owner: number; promise: Promise<void> } | undefined;

	const execute = (owner = 0): Promise<void> => {
		if (disconnectInFlight?.owner === owner) {
			return disconnectInFlight.promise;
		}

		const attempt = executeOnce(owner);
		disconnectInFlight = { owner, promise: attempt };
		void attempt.then(() => {
			if (disconnectInFlight?.promise === attempt) {
				disconnectInFlight = undefined;
			}
		}, () => {
			if (disconnectInFlight?.promise === attempt) {
				disconnectInFlight = undefined;
			}
		});
		return attempt;
	};

	const executeOnce = async (owner: number): Promise<void> => {
		// This fence and cancellation happen before looking up a credential or
		// issuing DELETE. They make every older GET/session callback stale now.
		dependencies.beginAuthoritativeDisconnect();
		dependencies.forceAlertsOff();
		const hadActivePairing = dependencies.cancelActivePairingSession() === true;

		if (dependencies.getConnectionState() === 'disconnected' && !hadActivePairing) {
			dependencies.showAlreadyDisconnected();
			return;
		}

		// DELETE is an authoritative mutation but its result is not yet known.
		dependencies.applyConnectionState('unknown');
		const disconnectRevision = dependencies.getConnectionStateRevision();

		let credential: string | undefined;
		try {
			credential = await dependencies.store.getInstallationCredential();
			if (credential === undefined) {
				// The authoritative resolver also maps no local installation to
				// disconnected. Cold lazy entry must retain the warmed command's
				// informational behavior without waiting for a cloud request.
				if (dependencies.getConnectionStateRevision() === disconnectRevision) {
					dependencies.applyConnectionState('disconnected');
					dependencies.showAlreadyDisconnected();
				}
				return;
			}
			// Credential lookup may have been pending when a newer Connect or
			// refresh took ownership. Never issue DELETE for a stale Disconnect.
			if (dependencies.getConnectionStateRevision() !== disconnectRevision) {
				return;
			}
			await dependencies.client.disconnectTelegram(credential, owner);
			if (dependencies.getConnectionStateRevision() !== disconnectRevision) {
				return;
			}

			dependencies.applyConnectionState('disconnected');
			dependencies.showDisconnected();
		} catch (error) {
			if (dependencies.getConnectionStateRevision() !== disconnectRevision) {
				return;
			}

			if (dependencies.isCredentialRejected(error)) {
				try {
					await dependencies.recoverRejectedCredential(owner);
				} catch {
					// The credential cannot be trusted, but a failed local cleanup must
					// not turn an identity-recovery outcome into a claimed disconnect.
					dependencies.applyConnectionState('unknown');
					dependencies.showError('The anonymous installation credential was rejected.');
					return;
				}
				if (dependencies.getConnectionStateRevision() !== disconnectRevision) {
					return;
				}
				dependencies.applyConnectionState('disconnected');
				dependencies.showError('The anonymous installation credential was rejected.');
				return;
			}

			// Preserve unknown. A timeout, network error, 5xx, or lost response may
			// have completed server-side; only a new authoritative operation may
			// resolve that uncertainty.
			dependencies.showError('Could not confirm whether Telegram was disconnected.');
		}
	};

	return { execute };
}
