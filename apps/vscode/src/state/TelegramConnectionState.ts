import {
	InstallationCredentialRejectedError,
	type InstallationCredentialStore,
} from '../backend/BackendClient';

export type TelegramConnectionState = 'connected' | 'disconnected' | 'unknown';

export interface TelegramConnectionClient {
	getTelegramConnection(credential: string): Promise<boolean>;
}

export async function resolveTelegramConnectionState(
	store: InstallationCredentialStore,
	client: TelegramConnectionClient,
): Promise<TelegramConnectionState> {
	let credential: string | undefined;
	try {
		credential = await store.getInstallationCredential();
	} catch {
		return 'unknown';
	}

	if (credential === undefined) {
		return 'disconnected';
	}

	try {
		return (await client.getTelegramConnection(credential)) ? 'connected' : 'disconnected';
	} catch (error) {
		if (error instanceof InstallationCredentialRejectedError) {
			try {
				await store.deleteInstallationCredential();
				return 'disconnected';
			} catch {
				return 'unknown';
			}
		}

		return 'unknown';
	}
}

export function canEnableAlerts(connectionState: TelegramConnectionState): boolean {
	return connectionState === 'connected';
}

export function statusBarText(
	connectionState: TelegramConnectionState,
	alertsEnabled: boolean,
): string {
	if (connectionState === 'connected') {
		return alertsEnabled
			? '$(bell) Codex Alerts: ON · $(send) ✓'
			: '$(bell-slash) Codex Alerts: OFF · $(send) ✓';
	}

	return connectionState === 'disconnected'
		? '$(bell-slash) Codex Alerts: OFF · $(send) ✕'
		: '$(bell-slash) Codex Alerts: OFF · $(send) ?';
}
