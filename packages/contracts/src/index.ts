/** Versioned JSON wire vocabulary; never canonical domain state. */
export interface ProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

/** Wire DTOs must be representable as JSON, separate from canonical domain state. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Opaque correlation only, 1–64 UTF-8 bytes. Never an authority token. */
export type IpcRequestId = string;

export interface IpcHelloChallenge {
  readonly version: ProtocolVersion;
  readonly type: 'hello.challenge';
  readonly challenge: string;
}

export interface IpcHelloRequest {
  readonly version: ProtocolVersion;
  readonly type: 'hello';
  readonly requestId: IpcRequestId;
  readonly supported: { readonly min: ProtocolVersion; readonly max: ProtocolVersion };
  readonly challenge: string;
}

export interface IpcHelloAck {
  readonly version: ProtocolVersion;
  readonly type: 'hello.ack';
  readonly requestId: IpcRequestId;
  readonly challenge: string;
  readonly sessionId: string;
}

export interface IpcHealthGetRequest {
  readonly version: ProtocolVersion;
  readonly type: 'health.get';
  readonly requestId: IpcRequestId;
  readonly sessionId: string;
}

export interface IpcHealthGetResult {
  readonly version: ProtocolVersion;
  readonly type: 'health.get.result';
  readonly requestId: IpcRequestId;
  readonly sessionId: string;
  readonly health: { readonly service: 'responsive'; readonly uptimeSeconds: number };
}

export interface IpcCompanionStatusRequest {
  readonly version: ProtocolVersion;
  readonly type: 'companion.status';
  readonly requestId: IpcRequestId;
  readonly sessionId: string;
}

export interface IpcCompanionStatusResult {
  readonly version: ProtocolVersion;
  readonly type: 'companion.status.result';
  readonly requestId: IpcRequestId;
  readonly sessionId: string;
  readonly status: {
    readonly state: 'starting' | 'ready' | 'stopping' | 'stopped';
    readonly transport: 'named-pipe' | 'unix-domain-socket';
    readonly protocol: ProtocolVersion;
  };
}

export type IpcProtocolErrorCode =
  | 'PROTOCOL_REQUIRED'
  | 'INCOMPATIBLE_VERSION'
  | 'INVALID_REQUEST'
  | 'UNKNOWN_MESSAGE'
  | 'DUPLICATE_REQUEST_ID'
  | 'INVALID_SESSION';

export interface IpcProtocolError {
  readonly version: ProtocolVersion;
  readonly type: 'protocol.error';
  readonly requestId?: IpcRequestId;
  readonly code: IpcProtocolErrorCode;
}

export type IpcRequest = IpcHelloRequest | IpcHealthGetRequest | IpcCompanionStatusRequest;
export type IpcResponse = IpcHelloChallenge | IpcHelloAck | IpcHealthGetResult |
  IpcCompanionStatusResult | IpcProtocolError;
