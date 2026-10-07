import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeIpcFrame, IpcFrameDecoder } from '../src/ipc-frame.js';
import { IpcProtocolSession, IPC_V1, MAX_IN_FLIGHT_REQUESTS } from '../src/ipc-protocol.js';

function client() {
  const decoder = new IpcFrameDecoder();
  const output: Record<string, unknown>[] = [];
  let closed = false;
  const session = new IpcProtocolSession({
    send: (frame) => output.push(...decoder.push(frame) as Record<string, unknown>[]),
    close: () => { closed = true; },
  }, { transport: 'named-pipe', runtimeState: () => 'ready', uptimeSeconds: () => 12.9 });
  const challenge = output[0]!.challenge as string;
  const hello = (overrides: Record<string, unknown> = {}) => session.receive(encodeIpcFrame({
    version: IPC_V1, type: 'hello', requestId: 'hello-1',
    supported: { min: IPC_V1, max: IPC_V1 }, challenge, ...overrides,
  }));
  return { session, output, challenge, hello, closed: () => closed };
}

test('hello is required before both read-only requests', () => {
  for (const type of ['health.get', 'companion.status']) {
    const connection = client();
    connection.session.receive(encodeIpcFrame({ type, version: IPC_V1, requestId: 'early', sessionId: 'anything' }));
    assert.equal(connection.output.at(-1)?.code, 'PROTOCOL_REQUIRED');
    assert.equal(connection.closed(), true);
  }
});

test('compatible v1 hello binds challenge, negotiated version, and a fresh session', async () => {
  const connection = client();
  assert.deepEqual(Object.keys(connection.output[0]!).sort(), ['challenge', 'type', 'version']);
  connection.hello({ supported: { min: { major: 1, minor: 0 }, max: { major: 1, minor: 2 } } });
  const ack = connection.output[1]!;
  assert.equal(ack.type, 'hello.ack');
  assert.deepEqual(ack.version, IPC_V1);
  assert.equal(ack.challenge, connection.challenge);
  assert.equal(typeof ack.sessionId, 'string');
  connection.session.receive(Buffer.concat([
    encodeIpcFrame({ type: 'health.get', version: IPC_V1, requestId: 'h', sessionId: ack.sessionId }),
    encodeIpcFrame({ type: 'companion.status', version: IPC_V1, requestId: 's', sessionId: ack.sessionId }),
  ]));
  await Promise.resolve();
  assert.deepEqual(connection.output[2], {
    type: 'health.get.result', version: IPC_V1, requestId: 'h', sessionId: ack.sessionId,
    health: { service: 'responsive', uptimeSeconds: 12 },
  });
  assert.deepEqual(connection.output[3], {
    type: 'companion.status.result', version: IPC_V1, requestId: 's', sessionId: ack.sessionId,
    status: { state: 'ready', transport: 'named-pipe', protocol: IPC_V1 },
  });
  assert.equal(connection.closed(), false);
});

test('incompatible major, wrong challenge, and unknown messages fail closed', () => {
  const incompatible = client();
  incompatible.hello({ supported: { min: { major: 2, minor: 0 }, max: { major: 2, minor: 4 } } });
  assert.equal(incompatible.output.at(-1)?.code, 'INCOMPATIBLE_VERSION');
  assert.equal(incompatible.closed(), true);
  const incompatibleEnvelope = client();
  incompatibleEnvelope.hello({ version: { major: 2, minor: 0 } });
  assert.equal(incompatibleEnvelope.output.at(-1)?.code, 'INCOMPATIBLE_VERSION');
  assert.equal(incompatibleEnvelope.closed(), true);
  const malformedRange = client();
  malformedRange.hello({ supported: { min: { major: 0, minor: 65536 }, max: IPC_V1 } });
  assert.equal(malformedRange.output.at(-1)?.code, 'INCOMPATIBLE_VERSION');
  const wrongChallenge = client();
  wrongChallenge.hello({ challenge: 'replayed' });
  assert.equal(wrongChallenge.output.at(-1)?.code, 'INVALID_REQUEST');
  const unknown = client();
  unknown.hello();
  unknown.session.receive(encodeIpcFrame({ type: 'executeCommand', version: IPC_V1,
    requestId: 'cmd', sessionId: unknown.output[1]!.sessionId }));
  assert.equal(unknown.output.at(-1)?.code, 'UNKNOWN_MESSAGE');
  assert.equal(unknown.closed(), true);
  const extraField = client();
  extraField.hello();
  extraField.session.receive(encodeIpcFrame({ type: 'health.get', version: IPC_V1,
    requestId: 'extra', sessionId: extraField.output[1]!.sessionId, method: 'executeCommand' }));
  assert.equal(extraField.output.at(-1)?.code, 'INVALID_REQUEST');
});

test('duplicate in-flight IDs, invalid IDs, and incompatible post-hello version are rejected', () => {
  const duplicate = client();
  duplicate.hello();
  const sessionId = duplicate.output[1]!.sessionId;
  const request = encodeIpcFrame({ type: 'health.get', version: IPC_V1, requestId: 'same', sessionId });
  duplicate.session.receive(Buffer.concat([request, request]));
  assert.equal(duplicate.output.at(-1)?.code, 'DUPLICATE_REQUEST_ID');
  assert.equal(duplicate.closed(), true);
  const invalid = client();
  invalid.hello();
  invalid.session.receive(encodeIpcFrame({ type: 'health.get', version: IPC_V1,
    requestId: 'é'.repeat(40), sessionId: invalid.output[1]!.sessionId }));
  assert.equal(invalid.output.at(-1)?.code, 'INVALID_REQUEST');
  const version = client();
  version.hello();
  version.session.receive(encodeIpcFrame({ type: 'health.get', version: { major: 2, minor: 0 },
    requestId: 'version', sessionId: version.output[1]!.sessionId }));
  assert.equal(version.output.at(-1)?.code, 'INCOMPATIBLE_VERSION');
  const overloaded = client();
  overloaded.hello();
  const frames = Array.from({ length: MAX_IN_FLIGHT_REQUESTS + 1 }, (_, index) =>
    encodeIpcFrame({ type: 'health.get', version: IPC_V1, requestId: `r${index}`,
      sessionId: overloaded.output[1]!.sessionId }));
  overloaded.session.receive(Buffer.concat(frames));
  assert.equal(overloaded.output.at(-1)?.code, 'INVALID_REQUEST');
});

test('reconnect changes challenge/session; stale material cannot establish or use a new session', () => {
  const first = client();
  first.hello();
  const second = client();
  assert.notEqual(second.challenge, first.challenge);
  second.hello();
  assert.notEqual(second.output[1]!.sessionId, first.output[1]!.sessionId);
  second.session.receive(encodeIpcFrame({ type: 'health.get', version: IPC_V1,
    requestId: 'old', sessionId: first.output[1]!.sessionId }));
  assert.equal(second.output.at(-1)?.code, 'INVALID_SESSION');
  assert.equal(second.closed(), true);
  const third = client();
  third.hello({ challenge: first.challenge });
  assert.equal(third.output.at(-1)?.code, 'INVALID_REQUEST');
});
