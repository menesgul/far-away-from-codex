import type { TelegramConnectionState } from './TelegramConnectionState';

export interface TelegramConnectionStateRefreshDependencies {
	resolveConnectionState(owner?: number): Promise<TelegramConnectionState>;
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
): (owner?: number) => Promise<void> {
	let inFlight: { owner: number; promise: Promise<void> } | undefined;

	return (owner = 0): Promise<void> => {
		if (inFlight?.owner === owner) {
			return inFlight.promise;
		}

		const refreshRevision = dependencies.beginAuthoritativeRefresh();
		const refresh = dependencies.resolveConnectionState(owner)
			.then((nextState) => {
				if (dependencies.getConnectionStateRevision() === refreshRevision) {
					dependencies.applyConnectionState(nextState);
				}
			});
		inFlight = { owner, promise: refresh };
		void refresh.finally(() => {
			if (inFlight?.promise === refresh) {
				inFlight = undefined;
			}
		});
		return refresh;
	};
}
