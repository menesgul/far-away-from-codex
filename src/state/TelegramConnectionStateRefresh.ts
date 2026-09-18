import type { TelegramConnectionState } from './TelegramConnectionState';

export interface TelegramConnectionStateRefreshDependencies {
	resolveConnectionState(): Promise<TelegramConnectionState>;
	beginAuthoritativeRefresh(): number;
	getConnectionStateRevision(): number;
	applyConnectionState(state: TelegramConnectionState): void;
}

/**
 * Starts a single authoritative connection read. Beginning the read advances
 * the caller-owned revision immediately, so older pairing sessions lose
 * permission to mutate connection state before the network request settles.
 */
export function createTelegramConnectionStateRefresh(
	dependencies: TelegramConnectionStateRefreshDependencies
): () => Promise<void> {
	let inFlight: Promise<void> | undefined;

	return (): Promise<void> => {
		if (inFlight !== undefined) {
			return inFlight;
		}

		const refreshRevision = dependencies.beginAuthoritativeRefresh();
		const refresh = dependencies.resolveConnectionState()
			.then((nextState) => {
				if (dependencies.getConnectionStateRevision() === refreshRevision) {
					dependencies.applyConnectionState(nextState);
				}
			});
		inFlight = refresh;
		void refresh.finally(() => {
			if (inFlight === refresh) {
				inFlight = undefined;
			}
		});
		return refresh;
	};
}
