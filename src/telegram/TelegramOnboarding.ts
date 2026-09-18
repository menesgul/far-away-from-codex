import type { TelegramConnectionState } from '../state/TelegramConnectionState';
import type { TelegramConnectIntent } from './TelegramConnectCommand';

export const TELEGRAM_ONBOARDING_SHOWN_KEY = 'farAway.telegramOnboardingShown';
export const TELEGRAM_ONBOARDING_MESSAGE = 'Connect Telegram to receive Codex alerts on your phone.';
export const TELEGRAM_ONBOARDING_CONNECT_BUTTON = 'Connect Telegram';
export const TELEGRAM_ONBOARDING_NOT_NOW_BUTTON = 'Not now';

/** The small persisted UX surface used by first-activation onboarding only. */
export interface TelegramOnboardingState {
	get<T>(section: string): T | undefined;
	update(section: string, value: unknown): Thenable<void>;
}

export interface TelegramOnboardingDependencies {
	globalState: TelegramOnboardingState;
	showPrompt(message: string, firstButton: string, secondButton: string): Thenable<string | undefined>;
	connectTelegram(intent: TelegramConnectIntent): Promise<void>;
}

export interface TelegramOnboarding {
	maybeShow(connectionState: TelegramConnectionState): Promise<void>;
	dispose(): void;
}

export interface TelegramActivationOnboardingDependencies {
	refreshConnectionState(): Promise<void>;
	getConnectionState(): TelegramConnectionState;
	onboarding: TelegramOnboarding;
}

/**
 * Owns one activation lifecycle's local first-activation prompt. It owns no
 * connection truth: D1 remains the authority, and callers supply the existing
 * lookup outcome. Its small lifecycle fence prevents old activation UI from
 * triggering a connection flow after disposal or replacement.
 */
export function createTelegramOnboarding(
	dependencies: TelegramOnboardingDependencies,
): TelegramOnboarding {
	let inFlight: Promise<void> | undefined;
	let lifecycleRevision = 0;
	let disposed = false;

	const maybeShow = (connectionState: TelegramConnectionState): Promise<void> => {
		if (
			disposed
			|| connectionState !== 'disconnected'
			|| dependencies.globalState.get<boolean>(TELEGRAM_ONBOARDING_SHOWN_KEY) === true
		) {
			return Promise.resolve();
		}
		if (inFlight !== undefined) {
			return inFlight;
		}

		const attemptRevision = lifecycleRevision;
		const attempt = (async () => {
			const selection = await dependencies.showPrompt(
				TELEGRAM_ONBOARDING_MESSAGE,
				TELEGRAM_ONBOARDING_CONNECT_BUTTON,
				TELEGRAM_ONBOARDING_NOT_NOW_BUTTON
			);
			// A failed presentation must remain eligible for a later activation.
			// Once the prompt resolves, including normal dismissal, persist before
			// permitting any action so reload cannot turn it into a repeated prompt.
			await dependencies.globalState.update(TELEGRAM_ONBOARDING_SHOWN_KEY, true);
			if (disposed || lifecycleRevision !== attemptRevision) {
				return;
			}
			if (selection === TELEGRAM_ONBOARDING_CONNECT_BUTTON) {
				await dependencies.connectTelegram('connect-only');
			}
		})();
		inFlight = attempt;
		const clearInFlight = () => {
			if (inFlight === attempt) {
				inFlight = undefined;
			}
		};
		void attempt.then(clearInFlight, clearInFlight);
		return attempt;
	};

	return {
		maybeShow,
		dispose: () => {
			disposed = true;
			lifecycleRevision += 1;
		},
	};
}

/** Completes activation's existing authoritative read before considering UX-only onboarding. */
export async function runTelegramActivationOnboarding(
	dependencies: TelegramActivationOnboardingDependencies,
): Promise<void> {
	await dependencies.refreshConnectionState();
	await dependencies.onboarding.maybeShow(dependencies.getConnectionState());
}
