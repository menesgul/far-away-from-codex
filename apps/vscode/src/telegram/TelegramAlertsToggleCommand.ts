import type { TelegramConnectionState } from '../state/TelegramConnectionState';
import type { TelegramConnectIntent } from './TelegramConnectCommand';

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
