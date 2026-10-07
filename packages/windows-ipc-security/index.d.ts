/// <reference types="node" />
export interface PipeEvent {
  readonly type: 'connect' | 'data' | 'close' | 'fatal';
  readonly clientId: number;
  readonly data?: Buffer;
}
export interface PipeSecurityEvidence {
  readonly protectedDacl: boolean;
  readonly currentUserOnly: boolean;
  readonly aceCount: number;
  readonly rejectRemoteClients: boolean;
}
export function start(path: string, onEvent: (event: PipeEvent) => void): number;
export function write(serverId: number, clientId: number, data: Buffer): void;
export function disconnect(serverId: number, clientId: number): void;
/** Reclaim a client after its queued close event reaches JavaScript. */
export function reap(serverId: number, clientId: number): void;
/** Native transport counters for lifecycle and backpressure verification. */
export function stats(serverId: number): { readonly clientCount: number; readonly queueFullCount: number };
export function security(serverId: number): PipeSecurityEvidence;
export function stop(serverId: number): void;
