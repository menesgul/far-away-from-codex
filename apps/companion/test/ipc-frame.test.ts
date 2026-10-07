import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeIpcFrame, IpcFrameDecoder, IpcFrameError, MAX_IPC_FRAME_BYTES } from '../src/ipc-frame.js';

test('frame length is UTF-8 bytes and prefix/body may be fragmented', () => {
  const frame = encodeIpcFrame({ text: '🛰️ café' });
  assert.equal(frame.readUInt32BE(0), Buffer.byteLength(JSON.stringify({ text: '🛰️ café' }), 'utf8'));
  const decoder = new IpcFrameDecoder();
  assert.deepEqual(decoder.push(frame.subarray(0, 1)), []);
  assert.deepEqual(decoder.push(frame.subarray(1, 3)), []);
  assert.deepEqual(decoder.push(frame.subarray(3, 8)), []);
  assert.deepEqual(decoder.push(frame.subarray(8)), [{ text: '🛰️ café' }]);
  decoder.end();
});

test('one read may contain multiple complete frames and part of another', () => {
  const one = encodeIpcFrame({ n: 1 });
  const two = encodeIpcFrame({ n: 2 });
  const three = encodeIpcFrame({ n: 3 });
  const decoder = new IpcFrameDecoder();
  assert.deepEqual(decoder.push(Buffer.concat([one, two, three.subarray(0, 5)])), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(decoder.push(three.subarray(5)), [{ n: 3 }]);
  decoder.end();
});

test('zero, oversized, truncated, invalid UTF-8/JSON, and non-object frames fail closed', () => {
  const raw = (bytes: Buffer) => {
    const frame = Buffer.alloc(4 + bytes.length);
    frame.writeUInt32BE(bytes.length, 0);
    bytes.copy(frame, 4);
    return frame;
  };
  for (const frame of [
    Buffer.alloc(4),
    Buffer.from([0, 1, 0, 1]),
    raw(Buffer.from([0xff])),
    raw(Buffer.from('{oops')),
    raw(Buffer.from('[]')),
    raw(Buffer.from('null')),
  ]) {
    assert.throws(() => new IpcFrameDecoder().push(frame), IpcFrameError);
  }
  assert.throws(() => encodeIpcFrame({ payload: 'x'.repeat(MAX_IPC_FRAME_BYTES) }), IpcFrameError);
  const exactLimit = encodeIpcFrame({ p: 'x'.repeat(MAX_IPC_FRAME_BYTES - 8) });
  assert.equal(exactLimit.readUInt32BE(0), MAX_IPC_FRAME_BYTES);
  assert.equal((new IpcFrameDecoder().push(exactLimit)[0] as { p: string }).p.length,
    MAX_IPC_FRAME_BYTES - 8);
  for (const prefix of [Buffer.from([0]), encodeIpcFrame({ ok: true }).subarray(0, 6)]) {
    const decoder = new IpcFrameDecoder();
    decoder.push(prefix);
    assert.throws(() => decoder.end(), IpcFrameError);
  }
});
