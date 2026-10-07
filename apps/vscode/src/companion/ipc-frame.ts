/** Client-local codec for M0.7's four-byte length-prefixed JSON object frames. */
export const MAX_IPC_FRAME_BYTES = 64 * 1024;

export class ClientFrameError extends Error {}

export function encodeClientFrame(message: object): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length === 0 || payload.length > MAX_IPC_FRAME_BYTES) {
    throw new ClientFrameError('IPC frame size is invalid');
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class ClientFrameDecoder {
  private readonly prefix = Buffer.alloc(4);
  private prefixBytes = 0;
  private body?: Buffer;
  private bodyBytes = 0;
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true });

  push(chunk: Buffer): Record<string, unknown>[] {
    const frames: Record<string, unknown>[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        const count = Math.min(4 - this.prefixBytes, chunk.length - offset);
        chunk.copy(this.prefix, this.prefixBytes, offset, offset + count);
        this.prefixBytes += count;
        offset += count;
        if (this.prefixBytes !== 4) {continue;}
        const length = this.prefix.readUInt32BE(0);
        if (length === 0 || length > MAX_IPC_FRAME_BYTES) {throw new ClientFrameError('IPC frame size is invalid');}
        this.body = Buffer.allocUnsafe(length);
        this.bodyBytes = 0;
      }
      const count = Math.min(this.body.length - this.bodyBytes, chunk.length - offset);
      chunk.copy(this.body, this.bodyBytes, offset, offset + count);
      this.bodyBytes += count;
      offset += count;
      if (this.bodyBytes !== this.body.length) {continue;}
      let value: unknown;
      try { value = JSON.parse(this.utf8.decode(this.body)); }
      catch { throw new ClientFrameError('IPC frame payload is invalid'); }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ClientFrameError('IPC frame must contain a JSON object');
      }
      frames.push(value as Record<string, unknown>);
      this.body = undefined;
      this.bodyBytes = 0;
      this.prefixBytes = 0;
    }
    return frames;
  }

  end(): void {
    if (this.prefixBytes !== 0 || this.body) {throw new ClientFrameError('Truncated IPC frame');}
  }
}
