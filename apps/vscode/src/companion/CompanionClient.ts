import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import {
  localDataRoot, localEndpoint,
  type IpcHelloRequest, type IpcHealthGetResult, type IpcCompanionStatusResult,
  type IpcHealthGetRequest, type IpcCompanionStatusRequest, type IpcProtocolErrorCode,
  type LocalPathEnvironment, type LocalEndpoint,
} from '@far-away/contracts';
import { ClientFrameDecoder, encodeClientFrame } from './ipc-frame';

export type CompanionClientErrorCode =
  | 'unavailable' | 'connection_timeout' | 'request_timeout' | 'incompatible_protocol'
  | 'protocol_violation' | 'remote_protocol_error' | 'disconnected';

/** Messages are fixed and sanitized; raw socket data and challenge material are never exposed. */
export class CompanionClientError extends Error {
  constructor(readonly code: CompanionClientErrorCode, readonly remoteCode?: IpcProtocolErrorCode) {
    super(remoteCode === undefined ? `Companion client: ${code}` : `Companion client: ${code} (${remoteCode})`);
    this.name = 'CompanionClientError';
  }
}

export interface CompanionClientOptions {
  readonly paths?: LocalPathEnvironment;
  readonly connectionTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

type Pending = {
  readonly type: 'health.get.result' | 'companion.status.result';
  readonly resolve: (value: never) => void;
  readonly reject: (error: CompanionClientError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type Connection = {
  readonly generation: number;
  readonly socket: Socket;
  readonly frames: ClientFrameDecoder;
  readonly pending: Map<string, Pending>;
  phase: 'challenge' | 'ack' | 'ready';
  challenge?: string;
  helloId?: string;
  sessionId?: string;
  connectTimer?: ReturnType<typeof setTimeout>;
  connectPromise: Promise<void>;
  resolveConnect: () => void;
  rejectConnect: (error: CompanionClientError) => void;
};

const V1 = Object.freeze({ major: 1, minor: 0 });
const REMOTE_CODES = new Set<IpcProtocolErrorCode>([
  'PROTOCOL_REQUIRED', 'INCOMPATIBLE_VERSION', 'INVALID_REQUEST',
  'UNKNOWN_MESSAGE', 'DUPLICATE_REQUEST_ID', 'INVALID_SESSION',
]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isV1(value: unknown): boolean {
  return object(value) && exact(value, ['major', 'minor']) && value.major === 1 && value.minor === 0;
}

function validVersion(value: unknown): boolean {
  return object(value) && exact(value, ['major', 'minor']) &&
    Number.isSafeInteger(value.major) && Number.isSafeInteger(value.minor) &&
    (value.major as number) >= 0 && (value.major as number) <= 65535 &&
    (value.minor as number) >= 0 && (value.minor as number) <= 65535;
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0 && Buffer.byteLength(value, 'utf8') <= 64;
}

function challenge(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value;
}

function sessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > 120_000) {
    throw new RangeError('Companion client timeout must be a positive integer at most 120000 ms');
  }
  return selected;
}

/** One optional local IPC client. OS access control is the local-principal boundary. */
export class CompanionClient {
  private readonly endpoint: LocalEndpoint;
  private readonly connectionTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private generation = 0;
  private requestSerial = 0;
  private current?: Connection;

  constructor(options: CompanionClientOptions = {}) {
    this.endpoint = localEndpoint(localDataRoot(options.paths), options.paths?.platform);
    this.connectionTimeoutMs = positiveTimeout(options.connectionTimeoutMs, 5_000);
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, 5_000);
  }

  connect(): Promise<void> {
    if (this.current) { return this.current.connectPromise; }
    const socket = createConnection({ path: this.endpoint.path });
    let resolveConnect!: () => void;
    let rejectConnect!: (error: CompanionClientError) => void;
    const connectPromise = new Promise<void>((resolve, reject) => {
      resolveConnect = resolve;
      rejectConnect = reject;
    });
    const connection: Connection = {
      generation: ++this.generation, socket, frames: new ClientFrameDecoder(), pending: new Map(),
      phase: 'challenge', connectPromise, resolveConnect, rejectConnect,
    };
    this.current = connection;
    connection.connectTimer = setTimeout(() => this.fail(connection, new CompanionClientError('connection_timeout')),
      this.connectionTimeoutMs);
    socket.on('data', (bytes: Buffer) => this.receive(connection, bytes));
    socket.on('end', () => {
      if (!this.isCurrent(connection)) { return; }
      try { connection.frames.end(); }
      catch { this.fail(connection, new CompanionClientError('protocol_violation')); return; }
      this.fail(connection, new CompanionClientError('disconnected'));
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const unavailable = error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'ERROR_PIPE_BUSY';
      this.fail(connection, new CompanionClientError(unavailable ? 'unavailable' : 'disconnected'));
    });
    socket.on('close', () => this.fail(connection, new CompanionClientError('disconnected')));
    return connectPromise;
  }

  healthGet(): Promise<IpcHealthGetResult['health']> {
    return this.read('health.get', 'health.get.result');
  }

  companionStatus(): Promise<IpcCompanionStatusResult['status']> {
    return this.read('companion.status', 'companion.status.result');
  }

  disconnect(): void {
    if (this.current) { this.fail(this.current, new CompanionClientError('disconnected')); }
  }

  dispose(): void { this.disconnect(); }

  private isCurrent(connection: Connection): boolean {
    return this.current === connection && connection.generation === this.generation;
  }

  private nextId(): string {
    if (this.requestSerial >= Number.MAX_SAFE_INTEGER) {
      throw new CompanionClientError('protocol_violation');
    }
    const id = `r${(++this.requestSerial).toString(36)}-${randomUUID()}`;
    if (!boundedId(id)) { throw new CompanionClientError('protocol_violation'); }
    return id;
  }

  private read(type: 'health.get', resultType: 'health.get.result'): Promise<IpcHealthGetResult['health']>;
  private read(type: 'companion.status', resultType: 'companion.status.result'): Promise<IpcCompanionStatusResult['status']>;
  private read(type: 'health.get' | 'companion.status', resultType: Pending['type']): Promise<never> {
    const connection = this.current;
    if (!connection || connection.phase !== 'ready' || !connection.sessionId) {
      return Promise.reject(new CompanionClientError('disconnected'));
    }
    if (connection.pending.size >= 32) { return Promise.reject(new CompanionClientError('protocol_violation')); }
    const requestId = this.nextId();
    const request: IpcHealthGetRequest | IpcCompanionStatusRequest = {
      type, version: V1, requestId, sessionId: connection.sessionId,
    };
    return new Promise<never>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(connection, new CompanionClientError('request_timeout')),
        this.requestTimeoutMs);
      connection.pending.set(requestId, { type: resultType, resolve, reject, timer });
      try { connection.socket.write(encodeClientFrame(request)); }
      catch { this.fail(connection, new CompanionClientError('disconnected')); }
    });
  }

  private receive(connection: Connection, bytes: Buffer): void {
    if (!this.isCurrent(connection)) { return; }
    let frames: Record<string, unknown>[];
    try { frames = connection.frames.push(bytes); }
    catch { this.fail(connection, new CompanionClientError('protocol_violation')); return; }
    for (const frame of frames) {
      if (!this.isCurrent(connection)) { return; }
      this.handle(connection, frame);
    }
  }

  private handle(connection: Connection, frame: Record<string, unknown>): void {
    if (!validVersion(frame.version)) {
      this.fail(connection, new CompanionClientError('protocol_violation'));
      return;
    }
    if (!isV1(frame.version)) {
      this.fail(connection, new CompanionClientError('incompatible_protocol'));
      return;
    }
    if (frame.type === 'protocol.error' && connection.phase !== 'challenge') {
      const keys = frame.requestId === undefined ? ['type', 'version', 'code'] : ['type', 'version', 'requestId', 'code'];
      if (!exact(frame, keys) || !REMOTE_CODES.has(frame.code as IpcProtocolErrorCode) ||
          (frame.requestId !== undefined && !boundedId(frame.requestId))) {
        this.fail(connection, new CompanionClientError('protocol_violation'));
      } else {
        this.fail(connection, new CompanionClientError('remote_protocol_error', frame.code as IpcProtocolErrorCode));
      }
      return;
    }
    if (connection.phase === 'challenge') {
      if (frame.type !== 'hello.challenge' || !exact(frame, ['type', 'version', 'challenge']) ||
          !challenge(frame.challenge)) {
        this.fail(connection, new CompanionClientError('protocol_violation'));
        return;
      }
      connection.challenge = frame.challenge;
      connection.helloId = this.nextId();
      connection.phase = 'ack';
      const hello: IpcHelloRequest = {
        type: 'hello', version: V1, requestId: connection.helloId,
        supported: { min: V1, max: V1 }, challenge: connection.challenge,
      };
      try { connection.socket.write(encodeClientFrame(hello)); }
      catch { this.fail(connection, new CompanionClientError('disconnected')); }
      return;
    }
    if (connection.phase === 'ack') {
      if (frame.type !== 'hello.ack' || !exact(frame, ['type', 'version', 'requestId', 'challenge', 'sessionId']) ||
          frame.requestId !== connection.helloId || frame.challenge !== connection.challenge ||
          !sessionId(frame.sessionId)) {
        this.fail(connection, new CompanionClientError('protocol_violation'));
        return;
      }
      connection.sessionId = frame.sessionId;
      connection.challenge = undefined;
      connection.helloId = undefined;
      connection.phase = 'ready';
      clearTimeout(connection.connectTimer);
      connection.connectTimer = undefined;
      connection.resolveConnect();
      return;
    }
    const id = frame.requestId;
    if (!boundedId(id) || !sessionId(frame.sessionId) || frame.sessionId !== connection.sessionId) {
      this.fail(connection, new CompanionClientError('protocol_violation'));
      return;
    }
    const pending = connection.pending.get(id);
    if (!pending || frame.type !== pending.type) {
      this.fail(connection, new CompanionClientError('protocol_violation'));
      return;
    }
    let result: unknown;
    if (pending.type === 'health.get.result') {
      if (!exact(frame, ['type', 'version', 'requestId', 'sessionId', 'health']) ||
          !object(frame.health) || !exact(frame.health, ['service', 'uptimeSeconds']) ||
          frame.health.service !== 'responsive' || !Number.isSafeInteger(frame.health.uptimeSeconds) ||
          (frame.health.uptimeSeconds as number) < 0 || (frame.health.uptimeSeconds as number) > 2147483647) {
        this.fail(connection, new CompanionClientError('protocol_violation'));
        return;
      }
      result = frame.health;
    } else {
      if (!exact(frame, ['type', 'version', 'requestId', 'sessionId', 'status']) ||
          !object(frame.status) || !exact(frame.status, ['state', 'transport', 'protocol']) ||
          !['starting', 'ready', 'stopping', 'stopped'].includes(frame.status.state as string) ||
          frame.status.transport !== this.endpoint.transport || !isV1(frame.status.protocol)) {
        this.fail(connection, new CompanionClientError('protocol_violation'));
        return;
      }
      result = frame.status;
    }
    connection.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(result as never);
  }

  private fail(connection: Connection, error: CompanionClientError): void {
    if (!this.isCurrent(connection)) { return; }
    this.current = undefined;
    this.generation++;
    clearTimeout(connection.connectTimer);
    connection.connectTimer = undefined;
    connection.challenge = undefined;
    connection.helloId = undefined;
    connection.sessionId = undefined;
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    connection.pending.clear();
    connection.rejectConnect(error);
    connection.socket.removeAllListeners('data');
    connection.socket.removeAllListeners('end');
    connection.socket.removeAllListeners('error');
    connection.socket.removeAllListeners('close');
    connection.socket.on('error', () => undefined);
    connection.socket.destroy();
  }
}
