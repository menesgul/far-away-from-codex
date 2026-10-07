import { LocalIpcServer, type LocalIpcOptions } from './ipc-server.js';
import { resolveCompanionPaths, type PathEnvironment } from './paths.js';
import { CompanionRuntime, type CompanionRuntimeState } from './runtime.js';
import { CompanionStorage, type StorageOptions } from './storage.js';

export interface CompanionApplicationOptions {
  readonly paths?: PathEnvironment;
  readonly onStateChange?: (state: CompanionRuntimeState) => void;
  readonly onResourceEvent?: (event: string) => void;
  readonly onFatalIpc?: () => void;
  readonly startStorage?: (options: StorageOptions) => Promise<CompanionStorage>;
  readonly startIpc?: (options: LocalIpcOptions) => Promise<LocalIpcServer>;
}

/** Coordinates M0.6 ownership/storage and the M0.7 local client boundary. */
export class CompanionApplication {
  private readonly runtime: CompanionRuntime;
  private storage?: CompanionStorage;
  private ipc?: LocalIpcServer;

  constructor(private readonly options: CompanionApplicationOptions = {}) {
    this.runtime = new CompanionRuntime({
      initialize: () => this.initialize(),
      dispose: () => this.dispose(),
      onStateChange: options.onStateChange,
    });
  }

  get state(): CompanionRuntimeState { return this.runtime.state; }
  get endpoint() { return this.ipc?.endpoint; }
  start(): Promise<void> { return this.runtime.start(); }
  stop(): Promise<void> { return this.runtime.stop(); }

  private async initialize(): Promise<void> {
    const paths = resolveCompanionPaths(this.options.paths);
    this.storage = await (this.options.startStorage ?? CompanionStorage.start)({
      paths: this.options.paths,
      onResourceEvent: this.options.onResourceEvent,
    });
    try {
      this.ipc = await (this.options.startIpc ?? LocalIpcServer.start)({
        dataRoot: paths.dataRoot,
        platform: this.options.paths?.platform,
        assertOwnershipHeld: () => this.storage!.assertOwnershipHeld(),
        runtimeState: () => this.runtime.state,
        onFatal: () => {
          void this.stop().catch(() => undefined);
          this.options.onFatalIpc?.();
        },
      });
      this.options.onResourceEvent?.('ipc-bound');
    } catch (error) {
      try { await this.dispose(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Companion startup and cleanup failed');
      }
      throw error;
    }
  }

  private async dispose(): Promise<void> {
    let eventError: unknown;
    if (this.ipc) {
      await this.ipc.stop();
      this.ipc = undefined;
      try { this.options.onResourceEvent?.('ipc-closed'); }
      catch (error) { eventError = error; }
    }
    if (this.storage) {
      await this.storage.stop();
      this.storage = undefined;
    }
    if (eventError) throw eventError;
  }
}
