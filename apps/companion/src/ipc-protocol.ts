import { randomBytes, randomUUID } from 'node:crypto';
import type {
  IpcCompanionStatusResult, IpcHealthGetResult, IpcHelloAck, IpcHelloChallenge,
  IpcProtocolError, IpcProtocolErrorCode, ProtocolVersion,
} from '@far-away/contracts';
import type { CompanionRuntimeState } from './runtime.js';
import { encodeIpcFrame, IpcFrameDecoder } from './ipc-frame.js';
import type { LocalEndpoint } from './ipc-endpoint.js';

export const IPC_V1: ProtocolVersion = Object.freeze({ major: 1, minor: 0 });
export const MAX_REQUEST_ID_BYTES = 64;
export const MAX_IN_FLIGHT_REQUESTS = 32;

export interface IpcByteConnection {
  send(frame: Buffer): void;
  close(): void;
}

export interface IpcSessionOptions {
  readonly transport: LocalEndpoint['transport'];
  readonly runtimeState: () => CompanionRuntimeState;
  readonly uptimeSeconds?: () => number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function version(value: unknown): ProtocolVersion | undefined {
  const candidate = record(value);
  return candidate && exactKeys(candidate, ['major', 'minor']) &&
    Number.isSafeInteger(candidate.major) && Number.isSafeInteger(candidate.minor) &&
    (candidate.major as number) >= 0 && (candidate.major as number) <= 65535 &&
    (candidate.minor as number) >= 0 && (candidate.minor as number) <= 65535
    ? { major: candidate.major as number, minor: candidate.minor as number } : undefined;
}

function requestId(value: unknown): string | undefined {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_REQUEST_ID_BYTES ? value : undefined;
}

function compatibleRange(value: unknown): boolean {
  const range = record(value);
  const min = version(range?.min);
  const max = version(range?.max);
  if (!range || !exactKeys(range, ['min', 'max']) || !min || !max) return false;
  const compare = (a: ProtocolVersion, b: ProtocolVersion) =>
    a.major === b.major ? a.minor - b.minor : a.major - b.major;
  return compare(min, IPC_V1) <= 0 && compare(max, IPC_V1) >= 0 && compare(min, max) <= 0;
}

/** Protocol state only. OS access control is the client-principal boundary. */
export class IpcProtocolSession {
  private readonly frames = new IpcFrameDecoder();
  private readonly challenge = randomBytes(32).toString('base64url');
  private readonly inFlight = new Set<string>();
  private sessionId?: string;
  private closed = false;

  constructor(private readonly connection: IpcByteConnection, private readonly options: IpcSessionOptions) {
    const announcement: IpcHelloChallenge = { type: 'hello.challenge', version: IPC_V1, challenge: this.challenge };
    this.send(announcement);
  }

  receive(data: Buffer): void {
    if (this.closed) return;
    let messages: object[];
    try { messages = this.frames.push(data); }
    catch { this.close(); return; }
    for (const message of messages) {
      if (this.closed) break;
      this.handle(record(message)!);
    }
  }

  end(): void {
    if (this.closed) return;
    try { this.frames.end(); } catch { this.close(); return; }
    this.closed = true;
  }

  stop(): void { this.close(); }

  private handle(message: Record<string, unknown>): void {
    const id = requestId(message.requestId);
    if (!id || typeof message.type !== 'string' || !version(message.version)) {
      this.error('INVALID_REQUEST', id);
      return;
    }
    if (!this.sessionId) {
      if (message.type !== 'hello') { this.error('PROTOCOL_REQUIRED', id); return; }
      if (!exactKeys(message, ['type', 'version', 'requestId', 'supported', 'challenge'])) {
        this.error('INVALID_REQUEST', id);
        return;
      }
      const helloVersion = version(message.version)!;
      if (helloVersion.major !== 1 || helloVersion.minor !== 0) {
        this.error('INCOMPATIBLE_VERSION', id);
        return;
      }
      if (!compatibleRange(message.supported)) { this.error('INCOMPATIBLE_VERSION', id); return; }
      if (message.challenge !== this.challenge) { this.error('INVALID_REQUEST', id); return; }
      this.sessionId = randomUUID();
      const reply: IpcHelloAck = {
        type: 'hello.ack', version: IPC_V1, requestId: id,
        challenge: this.challenge, sessionId: this.sessionId,
      };
      this.send(reply);
      return;
    }
    const selected = version(message.version)!;
    if (selected.major !== 1 || selected.minor !== 0) {
      this.error('INCOMPATIBLE_VERSION', id);
      return;
    }
    if (message.sessionId !== this.sessionId) { this.error('INVALID_SESSION', id); return; }
    if (message.type !== 'health.get' && message.type !== 'companion.status') {
      this.error(message.type === 'hello' ? 'INVALID_REQUEST' : 'UNKNOWN_MESSAGE', id);
      return;
    }
    if (!exactKeys(message, ['type', 'version', 'requestId', 'sessionId'])) {
      this.error('INVALID_REQUEST', id);
      return;
    }
    if (this.inFlight.has(id)) { this.error('DUPLICATE_REQUEST_ID', id); return; }
    if (this.inFlight.size >= MAX_IN_FLIGHT_REQUESTS) { this.error('INVALID_REQUEST', id); return; }
    this.inFlight.add(id);
    // Keep requests independently in flight so pipelined duplicate IDs are rejected.
    queueMicrotask(() => {
      if (this.closed) return;
      try {
        if (message.type === 'health.get') {
          const seconds = this.options.uptimeSeconds?.() ?? process.uptime();
          const reply: IpcHealthGetResult = {
            type: 'health.get.result', version: IPC_V1, requestId: id, sessionId: this.sessionId!,
            health: { service: 'responsive', uptimeSeconds: Math.max(0, Math.min(2147483647, Math.floor(seconds))) },
          };
          this.send(reply);
        } else {
          const reply: IpcCompanionStatusResult = {
            type: 'companion.status.result', version: IPC_V1, requestId: id, sessionId: this.sessionId!,
            status: { state: this.options.runtimeState(), transport: this.options.transport, protocol: IPC_V1 },
          };
          this.send(reply);
        }
      } catch { this.close(); }
      finally { this.inFlight.delete(id); }
    });
  }

  private error(code: IpcProtocolErrorCode, id?: string): void {
    const reply: IpcProtocolError = {
      type: 'protocol.error', version: IPC_V1, ...(id === undefined ? {} : { requestId: id }), code,
    };
    try { this.send(reply); } finally { this.close(); }
  }

  private send(message: object): void {
    if (this.closed) return;
    try { this.connection.send(encodeIpcFrame(message)); }
    catch { this.close(); }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inFlight.clear();
    this.connection.close();
  }
}
