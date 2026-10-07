import * as assert from 'node:assert/strict';
import { ClientFrameDecoder, ClientFrameError, encodeClientFrame, MAX_IPC_FRAME_BYTES } from '../../companion/ipc-frame';

suite('Companion client frame codec', () => {
  test('fragmented prefix and body, coalesced frames, and UTF-8 byte length', () => {
    const first = encodeClientFrame({ value: 'é' });
    assert.strictEqual(first.readUInt32BE(0), Buffer.byteLength('{"value":"é"}', 'utf8'));
    const second = encodeClientFrame({ value: 2 });
    const decoder = new ClientFrameDecoder();
    assert.deepStrictEqual(decoder.push(first.subarray(0, 2)), []);
    assert.deepStrictEqual(decoder.push(first.subarray(2, 6)), []);
    assert.deepStrictEqual(decoder.push(Buffer.concat([first.subarray(6), second])), [
      { value: 'é' }, { value: 2 },
    ]);
    decoder.end();
  });

  test('accepts exactly 64 KiB and rejects one byte more, including multibyte strings', () => {
    const base = Buffer.byteLength('{"v":""}', 'utf8');
    const valid = encodeClientFrame({ v: 'a'.repeat(MAX_IPC_FRAME_BYTES - base) });
    assert.strictEqual(valid.readUInt32BE(0), MAX_IPC_FRAME_BYTES);
    assert.strictEqual(new ClientFrameDecoder().push(valid).length, 1);
    assert.throws(() => encodeClientFrame({ v: 'a'.repeat(MAX_IPC_FRAME_BYTES - base + 1) }), ClientFrameError);
    assert.throws(() => encodeClientFrame({ v: 'é'.repeat((MAX_IPC_FRAME_BYTES - base) / 2 + 1) }), ClientFrameError);
  });

  test('rejects zero and oversized wire lengths', () => {
    const zero = Buffer.alloc(4);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(MAX_IPC_FRAME_BYTES + 1);
    assert.throws(() => new ClientFrameDecoder().push(zero), ClientFrameError);
    assert.throws(() => new ClientFrameDecoder().push(oversized), ClientFrameError);
  });

  test('rejects invalid UTF-8, invalid JSON, and non-object JSON', () => {
    const raw = (payload: Buffer) => {
      const frame = Buffer.alloc(4 + payload.length);
      frame.writeUInt32BE(payload.length);
      payload.copy(frame, 4);
      return frame;
    };
    for (const payload of [Buffer.from([0xff]), Buffer.from('{'), Buffer.from('null'),
      Buffer.from('[]'), Buffer.from('"text"')]) {
      assert.throws(() => new ClientFrameDecoder().push(raw(payload)), ClientFrameError);
    }
  });

  test('rejects truncated prefix and body at EOF', () => {
    const frame = encodeClientFrame({ value: 1 });
    const prefix = new ClientFrameDecoder();
    prefix.push(frame.subarray(0, 2));
    assert.throws(() => prefix.end(), ClientFrameError);
    const body = new ClientFrameDecoder();
    body.push(frame.subarray(0, 5));
    assert.throws(() => body.end(), ClientFrameError);
    const complete = new ClientFrameDecoder();
    complete.push(frame);
    complete.end();
  });
});
