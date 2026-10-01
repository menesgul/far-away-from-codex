import {
	type TelegramConnectionState,
	canEnableAlerts,
} from '../../state/TelegramConnectionState';
import { createTelegramConnectCommand } from '../../telegram/TelegramConnectCommand';
import {
	FakeCredentialStore,
	INSTALLATION_CREDENTIAL,
} from './credentials';
import { createTelegramDisconnectCommand } from '../../telegram/TelegramDisconnectCommand';
import * as assert from 'assert';
import { InstallationCredentialRejectedError } from '../../backend/BackendClient';

export function createDisconnectCommandHarness(options: {
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
