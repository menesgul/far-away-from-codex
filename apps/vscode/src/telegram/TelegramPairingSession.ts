import type { Pairing, PairingStatus } from '../backend/BackendClient';
import type { PairingPanelMessage, TelegramPairingPanel } from '../ui/TelegramPairingPanel';

/**
 * A local pairing session is deliberately not the Telegram connection state. In
 * particular, cancelling this session says nothing about a pairing that may
 * already have completed at the Worker.
 */
export type PairingSessionState = 'starting' | 'waiting' | 'connected' | 'expired' | 'cancelled';

export interface PairingStatusClient {
	getPairingStatus(credential: string, pairingId: string): Promise<PairingStatus>;
}

export interface PairingSessionTimers {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
	clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface PairingSessionDependencies {
	client: PairingStatusClient;
	createPanel(telegramUrl: string): Promise<TelegramPairingPanel>;
	writeClipboard(telegramUrl: string): Promise<void> | Thenable<void>;
	openExternal(telegramUrl: string): Promise<unknown> | Thenable<unknown>;
	/** Called for every trusted, observed connected status, including after local cancellation. */
	onConnected(session: TelegramPairingSession): void;
	/** Called once when the local session first reaches a terminal state. */
	onTerminal?(session: TelegramPairingSession, state: Exclude<PairingSessionState, 'starting' | 'waiting'>): void;
	/** Called after the panel and its event subscriptions have been released. */
	onDisposed?(session: TelegramPairingSession): void;
	timers?: PairingSessionTimers;
	pollIntervalMs?: number;
	maxPollDurationMs?: number;
}

interface Disposable {
	dispose(): void;
}

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_POLL_DURATION_MS = 5 * 60 * 1_000;

const systemTimers: PairingSessionTimers = {
	now: () => Date.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (timer) => clearTimeout(timer),
};

/**
 * Owns a single transient pairing attempt. It never writes authoritative
 * Telegram connection state itself; the extension decides whether an observed
 * connection belongs to its currently active session.
 */
export class TelegramPairingSession implements Disposable {
	private readonly timers: PairingSessionTimers;
	private readonly pollIntervalMs: number;
	private readonly maxPollDurationMs: number;
	private stateValue: PairingSessionState = 'starting';
	private credential: string | undefined;
	private pairing: Pairing | undefined;
	private panel: TelegramPairingPanel | undefined;
	private deadline = 0;
	private pollTimer: ReturnType<typeof setTimeout> | undefined;
	private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	private pollInFlight = false;
	private terminalCleanupDone = false;
	private connectionReported = false;
	private panelSubscriptions: Disposable[] = [];
	private panelReleased = false;

	public constructor(private readonly dependencies: PairingSessionDependencies) {
		this.timers = dependencies.timers ?? systemTimers;
		this.pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.maxPollDurationMs = dependencies.maxPollDurationMs ?? DEFAULT_MAX_POLL_DURATION_MS;
		if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
			throw new Error('The pairing poll interval must be positive.');
		}
		if (!Number.isFinite(this.maxPollDurationMs) || this.maxPollDurationMs <= 0) {
			throw new Error('The pairing poll duration must be positive.');
		}
	}

	public get state(): PairingSessionState {
		return this.stateValue;
	}

	public get isDisposed(): boolean {
		return this.panelReleased;
	}

	/**
	 * Supplies the short-lived material only after the command has performed its
	 * authoritative connection lookup and created a pairing. The material is
	 * retained in memory only for the lifetime of this session.
	 */
	public async start(credential: string, pairing: Pairing): Promise<void> {
		if (this.stateValue !== 'starting') {
			return;
		}

		this.credential = credential;
		this.pairing = pairing;

		let panel: TelegramPairingPanel;
		try {
			panel = await this.dependencies.createPanel(pairing.telegramUrl);
		} catch (error) {
			this.finish('cancelled');
			throw error;
		}

		if (this.stateValue !== 'starting') {
			// A command may have cancelled while local panel construction awaited.
			panel.dispose();
			return;
		}

		this.panel = panel;
		this.installPanelSubscriptions(panel);
		this.stateValue = 'waiting';
		this.deadline = Math.min(
			pairing.expiresAt.getTime(),
			this.timers.now() + this.maxPollDurationMs
		);

		if (this.deadline <= this.timers.now()) {
			this.finish('expired');
			return;
		}

		this.deadlineTimer = this.timers.setTimeout(
			() => this.handleDeadline(),
			this.deadline - this.timers.now()
		);
		this.startPoll();
	}

	/** Reveals an existing waiting panel without allocating another pairing. */
	public reveal(): boolean {
		return this.stateValue === 'waiting' && this.panel !== undefined && !this.panel.isDisposed
			? this.panel.reveal()
			: false;
	}

	/** A local cancellation. It intentionally does not revoke the Worker pairing. */
	public cancel(): void {
		if (this.stateValue === 'starting' || this.stateValue === 'waiting') {
			this.finish('cancelled');
		}
	}

	/**
	 * Completes without a pairing panel when the command's authoritative
	 * connection lookup already reports Telegram connected.
	 */
	public completeConnected(): void {
		if (this.stateValue !== 'starting' && this.stateValue !== 'waiting') {
			return;
		}

		this.reportConnected();
		this.finish('connected');
	}

	public dispose(): void {
		if (this.stateValue === 'starting' || this.stateValue === 'waiting') {
			this.finish('cancelled');
			return;
		}

		this.releasePanel();
	}

	private installPanelSubscriptions(panel: TelegramPairingPanel): void {
		this.panelSubscriptions.push(
			panel.onDidReceiveAction((message) => this.handlePanelMessage(message)),
			panel.onDidDispose(() => this.handlePanelDisposed())
		);
	}

	private handlePanelMessage(message: PairingPanelMessage): void {
		if (message.type === 'close') {
			if (this.stateValue === 'expired') {
				this.dispose();
			}
			return;
		}

		if (this.stateValue !== 'waiting' || this.timers.now() >= this.deadline) {
			if (this.stateValue === 'waiting') {
				this.handleDeadline();
			}
			return;
		}

		switch (message.type) {
			case 'copy-link':
				this.runExplicitAction(() => this.dependencies.writeClipboard(this.pairingUrl()));
				return;
			case 'open-on-this-device':
				this.runExplicitAction(() => this.dependencies.openExternal(this.pairingUrl()));
				return;
			case 'cancel':
				this.cancel();
				return;
		}
	}

	private runExplicitAction(action: () => Promise<unknown> | Thenable<unknown>): void {
		// The action itself is user initiated. Ignore failures here: neither the
		// pairing token nor URL should be surfaced or logged by this lifecycle code.
		void Promise.resolve(action()).catch(() => undefined);
	}

	private pairingUrl(): string {
		if (this.pairing === undefined) {
			throw new Error('Pairing material is unavailable.');
		}
		return this.pairing.telegramUrl;
	}

	private handlePanelDisposed(): void {
		if (this.stateValue === 'waiting' || this.stateValue === 'starting') {
			this.finish('cancelled', false);
		}
		this.releasePanel(false);
	}

	private startPoll(): void {
		if (this.stateValue !== 'waiting' || this.pollInFlight || this.timers.now() >= this.deadline) {
			return;
		}

		this.pollInFlight = true;
		const credential = this.credential;
		const pairing = this.pairing;
		const startedBeforeDeadline = this.timers.now() < this.deadline;
		if (credential === undefined || pairing === undefined || !startedBeforeDeadline) {
			this.pollInFlight = false;
			this.handleDeadline();
			return;
		}

		void this.dependencies.client.getPairingStatus(credential, pairing.pairingId)
			.then((status) => this.handlePollResult(status, startedBeforeDeadline))
			.catch(() => this.handlePollFailure())
			.finally(() => {
				this.pollInFlight = false;
				this.afterPollSettles();
			});
	}

	private handlePollResult(status: PairingStatus, startedBeforeDeadline: boolean): void {
		if (status === 'connected' && startedBeforeDeadline) {
			this.reportConnected();
			if (this.stateValue === 'waiting') {
				this.finish('connected');
			}
			return;
		}

		if (this.stateValue !== 'waiting') {
			return;
		}

		if (status === 'expired') {
			this.finish('expired');
		}
	}

	private handlePollFailure(): void {
		// Status reads are bounded and may retry until the pairing deadline. The
		// failure is intentionally not logged because it can contain transport data.
	}

	private afterPollSettles(): void {
		if (this.stateValue !== 'waiting') {
			return;
		}

		if (this.timers.now() >= this.deadline) {
			this.finish('expired');
			return;
		}

		this.scheduleNextPoll();
	}

	private scheduleNextPoll(): void {
		if (this.stateValue !== 'waiting' || this.pollTimer !== undefined || this.pollInFlight) {
			return;
		}

		const remaining = this.deadline - this.timers.now();
		if (remaining <= 0) {
			this.handleDeadline();
			return;
		}

		this.pollTimer = this.timers.setTimeout(() => {
			this.pollTimer = undefined;
			this.startPoll();
		}, Math.min(this.pollIntervalMs, remaining));
	}

	private handleDeadline(): void {
		if (this.stateValue !== 'waiting') {
			return;
		}

		if (this.pollTimer !== undefined) {
			this.timers.clearTimeout(this.pollTimer);
			this.pollTimer = undefined;
		}
		if (!this.pollInFlight) {
			this.finish('expired');
		}
	}

	private reportConnected(): void {
		if (this.connectionReported) {
			return;
		}
		this.connectionReported = true;
		try {
			this.dependencies.onConnected(this);
		} catch {
			// Lifecycle completion must not be prevented by a presentation callback.
		}
	}

	private finish(
		nextState: Exclude<PairingSessionState, 'starting' | 'waiting'>,
		disposePanel = nextState !== 'expired'
	): void {
		if (this.stateValue !== 'starting' && this.stateValue !== 'waiting') {
			return;
		}

		this.stateValue = nextState;
		this.stopPolling();
		if (!this.terminalCleanupDone) {
			this.terminalCleanupDone = true;
			try {
				this.dependencies.onTerminal?.(this, nextState);
			} catch {
				// Keep terminal cleanup idempotent even if the command-layer callback fails.
			}
		}

		if (nextState === 'expired') {
			this.panel?.showExpired();
			return;
		}

		if (disposePanel) {
			this.releasePanel();
		}
	}

	private stopPolling(): void {
		if (this.pollTimer !== undefined) {
			this.timers.clearTimeout(this.pollTimer);
			this.pollTimer = undefined;
		}
		if (this.deadlineTimer !== undefined) {
			this.timers.clearTimeout(this.deadlineTimer);
			this.deadlineTimer = undefined;
		}
	}

	private releasePanel(disposePanel = true): void {
		if (this.panelReleased) {
			return;
		}
		this.panelReleased = true;
		for (const subscription of this.panelSubscriptions.splice(0)) {
			subscription.dispose();
		}
		const panel = this.panel;
		this.panel = undefined;
		if (disposePanel) {
			panel?.dispose();
		}
		try {
			this.dependencies.onDisposed?.(this);
		} catch {
			// Releasing a panel must never throw back into a disposal event.
		}
	}
}
