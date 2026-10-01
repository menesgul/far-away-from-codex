import {
	type TelegramConnectSession,
	type TelegramConnectSessionCallbacks,
} from '../../telegram/TelegramConnectCommand';
import { type PairingSessionState } from '../../telegram/TelegramPairingSession';
import { type Pairing } from '../../backend/BackendClient';

export class FakeConnectSession implements TelegramConnectSession {
	public state: PairingSessionState = 'starting';
	public revealCalls = 0;
	public disposeCalls = 0;
	public cancelCalls = 0;
	public completeConnectedCalls = 0;
	public startCalls = 0;

	public constructor(private readonly callbacks: TelegramConnectSessionCallbacks) {}

	public reveal(): boolean {
		this.revealCalls += 1;
		return this.state === 'waiting';
	}

	public dispose(): void {
		this.disposeCalls += 1;
		this.callbacks.onDisposed(this);
	}

	public cancel(): void {
		this.cancelCalls += 1;
		this.emitTerminal('cancelled');
	}

	public completeConnected(): void {
		this.completeConnectedCalls += 1;
		this.emitConnected();
		this.emitTerminal('connected');
	}

	public async start(_credential: string, _pairing: Pairing): Promise<void> {
		this.startCalls += 1;
		this.state = 'waiting';
	}

	public emitConnected(): void {
		this.callbacks.onConnected(this);
	}

	public emitTerminal(state: Exclude<PairingSessionState, 'starting' | 'waiting'>): void {
		this.state = state;
		this.callbacks.onTerminal(this, state);
	}

	public emitDisposed(): void {
		this.callbacks.onDisposed(this);
	}
}
