export type CompanionRuntimeState = 'starting' | 'ready' | 'stopping' | 'stopped';

export interface CompanionRuntimeOptions {
  initialize?: () => void | Promise<void>;
  dispose?: () => void | Promise<void>;
  onStateChange?: (state: CompanionRuntimeState) => void;
}

/** READY describes this process shell only; it conveys no source authority. */
export class CompanionRuntime {
  private currentState: CompanionRuntimeState = 'starting';
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private stopRequested = false;

  constructor(private readonly options: CompanionRuntimeOptions = {}) {}

  get state(): CompanionRuntimeState {
    return this.currentState;
  }

  start(): Promise<void> {
    if (this.stopRequested) {
      return Promise.reject(new Error('Companion runtime is stopping or stopped'));
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = (async () => {
      try {
        await this.options.initialize?.();
        if (!this.stopRequested) {
          this.setState('ready');
        }
      } catch (error) {
        this.setState('stopped');
        throw error;
      }
    })();
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.stopRequested = true;
    this.stopPromise = (async () => {
      try {
        await this.startPromise?.catch(() => undefined);
        if (this.currentState === 'stopped') {
          return;
        }
        this.setState('stopping');
        await this.options.dispose?.();
      } finally {
        this.setState('stopped');
      }
    })();
    return this.stopPromise;
  }

  private setState(state: CompanionRuntimeState): void {
    if (this.currentState !== state) {
      this.currentState = state;
      this.options.onStateChange?.(state);
    }
  }
}
