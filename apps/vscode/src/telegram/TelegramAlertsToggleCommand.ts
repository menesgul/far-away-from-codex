import type { TelegramConnectionState } from '../state/TelegramConnectionState';
import type { TelegramConnectIntent } from './TelegramConnectCommand';

export interface TelegramAlertsToggleCommandDependencies {
	getConnectionState(): TelegramConnectionState;
	getAlertsEnabled(): boolean;
	setAlertsEnabled(enabled: boolean): void;
	refreshConnectionState(owner?: number): Promise<void>;
	showDisconnectedPrompt(): Promise<'connect' | 'cancel' | undefined>;
	connectTelegram(intent: TelegramConnectIntent, owner?: number): Promise<void>;
	isCurrentOwner?(owner: number): boolean;
}

/**
 * Routes a status-bar click from extension-owned state. The function owns no
 * state itself, keeping the activation lifecycle as the single owner while
 * making the canonical click behavior independently testable.
 */
export function createTelegramAlertsToggleCommand(
	dependencies: TelegramAlertsToggleCommandDependencies
): (owner?: number) => Promise<void> {
	return async (owner = 0) => {
		const connectionState = dependencies.getConnectionState();
		if (connectionState === 'unknown') {
			await dependencies.refreshConnectionState(owner);
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
				if (dependencies.isCurrentOwner?.(owner) === false) { return; }
				await dependencies.connectTelegram('enable-alerts-after-connect', owner);
			}
		}
	};
}
