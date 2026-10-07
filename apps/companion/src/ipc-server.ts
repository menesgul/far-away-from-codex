import { chmod, lstat, stat, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { localEndpoint, type LocalEndpoint } from './ipc-endpoint.js';
import { IpcProtocolSession, type IpcSessionOptions } from './ipc-protocol.js';
import type { CompanionRuntimeState } from './runtime.js';

export interface LocalIpcOptions {
  readonly dataRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly assertOwnershipHeld: () => Promise<void>;
  readonly runtimeState: () => CompanionRuntimeState;
  readonly onFatal?: () => void;
}

type NativePipe = typeof import('@far-away/windows-ipc-security');
const require = createRequire(import.meta.url);

async function clearStaleSocket(endpoint: string): Promise<void> {
  let before;
  try { before = await lstat(endpoint); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!before.isSocket()) throw new Error('IPC endpoint already exists and is not a socket');
  const live = await new Promise<boolean>((resolve, reject) => {
    const probe = createConnection({ path: endpoint });
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
  if (live) throw new Error('IPC endpoint is already served by a live process');
  const after = await lstat(endpoint);
  if (!after.isSocket() || before.ino !== after.ino || before.dev !== after.dev) {
    throw new Error('IPC endpoint changed during stale-socket inspection');
  }
  await unlink(endpoint);
}

/** Companion-owned transport. A session never becomes Companion or source authority. */
export class LocalIpcServer {
  readonly endpoint: LocalEndpoint;
  private unix?: Server;
  private readonly unixClients = new Map<Socket, IpcProtocolSession>();
  private native?: NativePipe;
  private nativeId?: number;
  private readonly nativeClients = new Map<number, IpcProtocolSession>();
  private stopping?: Promise<void>;
  private closed = false;

  private constructor(private readonly options: LocalIpcOptions) {
    this.endpoint = localEndpoint(options.dataRoot, options.platform);
  }

  static async start(options: LocalIpcOptions): Promise<LocalIpcServer> {
    const service = new LocalIpcServer(options);
    await options.assertOwnershipHeld();
    try {
      if (service.endpoint.transport === 'named-pipe') await service.startWindows();
      else await service.startUnix();
      return service;
    } catch (error) {
      await service.stop();
      throw error;
    }
  }

  private sessionOptions(): IpcSessionOptions {
    return { transport: this.endpoint.transport, runtimeState: this.options.runtimeState };
  }

  private async startWindows(): Promise<void> {
    this.native = require('@far-away/windows-ipc-security') as NativePipe;
    const native = this.native;
    this.nativeId = native.start(this.endpoint.path, (event) => {
      if (this.closed) return;
      if (event.type === 'fatal') { this.options.onFatal?.(); return; }
      if (event.type === 'connect') {
        const session = new IpcProtocolSession({
          send: (frame) => native.write(this.nativeId!, event.clientId, frame),
          close: () => native.disconnect(this.nativeId!, event.clientId),
        }, this.sessionOptions());
        this.nativeClients.set(event.clientId, session);
      } else if (event.type === 'data') {
        this.nativeClients.get(event.clientId)?.receive(event.data!);
      } else if (event.type === 'close') {
        this.nativeClients.get(event.clientId)?.end();
        this.nativeClients.delete(event.clientId);
        native.reap(this.nativeId!, event.clientId);
      }
    });
    const evidence = native.security(this.nativeId);
    if (!evidence.protectedDacl || !evidence.currentUserOnly || evidence.aceCount !== 1 ||
        !evidence.rejectRemoteClients) {
      throw new Error('Windows Named Pipe security check failed');
    }
  }

  private async startUnix(): Promise<void> {
    const root = await lstat(this.options.dataRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('IPC data root must be a real directory');
    if (process.getuid && root.uid !== process.getuid()) throw new Error('IPC data root has a different owner');
    await chmod(this.options.dataRoot, 0o700);
    if (((await stat(this.options.dataRoot)).mode & 0o077) !== 0) {
      throw new Error('IPC data root is not owner-only');
    }
    await this.options.assertOwnershipHeld();
    await clearStaleSocket(this.endpoint.path);
    this.unix = createServer((socket) => this.acceptUnix(socket));
    await new Promise<void>((resolve, reject) => {
      this.unix!.once('error', reject);
      this.unix!.listen({ path: this.endpoint.path, exclusive: true }, () => {
        this.unix!.off('error', reject);
        resolve();
      });
    });
    this.unix.on('error', () => this.options.onFatal?.());
    await chmod(this.endpoint.path, 0o600);
    const endpoint = await stat(this.endpoint.path);
    if (!endpoint.isSocket() || (endpoint.mode & 0o777) !== 0o600 ||
        (process.getuid && endpoint.uid !== process.getuid())) {
      throw new Error('Unix IPC socket is not restricted to its owner');
    }
  }

  private acceptUnix(socket: Socket): void {
    if (this.closed) { socket.destroy(); return; }
    let session: IpcProtocolSession;
    session = new IpcProtocolSession({
      send: (frame) => { socket.write(frame); },
      close: () => { socket.end(); },
    }, this.sessionOptions());
    this.unixClients.set(socket, session);
    socket.on('data', (chunk: Buffer) => session.receive(chunk));
    socket.on('end', () => session.end());
    socket.on('error', () => { socket.destroy(); });
    socket.on('close', () => { session.end(); this.unixClients.delete(socket); });
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopOnce();
    return this.stopping;
  }

  private async stopOnce(): Promise<void> {
    this.closed = true;
    if (this.nativeId !== undefined && this.native) {
      this.native.stop(this.nativeId);
      this.nativeId = undefined;
      this.nativeClients.clear();
    }
    if (this.unix?.listening) {
      const closed = new Promise<void>((resolve, reject) => {
        this.unix!.close((error) => error ? reject(error) : resolve());
      });
      for (const [socket, session] of this.unixClients) {
        session.stop();
        socket.destroy();
      }
      this.unixClients.clear();
      await closed;
      this.unix = undefined;
    } else {
      this.unix = undefined;
    }
  }
}
