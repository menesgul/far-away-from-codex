import * as assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localEndpoint } from '@far-away/contracts';
import { CompanionClient, CompanionClientError } from '../../companion/CompanionClient';
import { ClientFrameDecoder, encodeClientFrame } from '../../companion/ipc-frame';

const V1 = { major: 1, minor: 0 };
const CHALLENGE = randomBytes(32).toString('base64url');

class Peer {
  private readonly decoder = new ClientFrameDecoder();
  private readonly messages: Record<string, unknown>[] = [];
  private readonly waiters: Array<(message: Record<string, unknown>) => void> = [];
  constructor(readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      for (const message of this.decoder.push(chunk)) {
        const waiter = this.waiters.shift();
        if (waiter) {waiter(message);}
        else {this.messages.push(message);}
      }
    });
    socket.on('error', () => undefined);
  }
  send(message: object): void { this.socket.write(encodeClientFrame(message)); }
  next(): Promise<Record<string, unknown>> {
    const message = this.messages.shift();
    if (message) {return Promise.resolve(message);}
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

async function fixture(run: (client: CompanionClient, peer: () => Promise<Peer>, server: Server) => Promise<void>,
  options: { connectionTimeoutMs?: number; requestTimeoutMs?: number } = {}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'far-away-client-'));
  const endpoint = localEndpoint(root);
  const peers: Peer[] = [];
  const queued: Peer[] = [];
  const waiters: Array<(peer: Peer) => void> = [];
  const server = createServer((socket) => {
    const peer = new Peer(socket);
    peers.push(peer);
    const waiter = waiters.shift();
    if (waiter) {waiter(peer);}
    else {queued.push(peer);}
  });
  const client = new CompanionClient({ paths: { testDataRoot: root },
    connectionTimeoutMs: options.connectionTimeoutMs ?? 500,
    requestTimeoutMs: options.requestTimeoutMs ?? 500 });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint.path, () => { server.off('error', reject); resolve(); });
    });
    await run(client, () => queued.length ? Promise.resolve(queued.shift()!) :
      new Promise((resolve) => waiters.push(resolve)), server);
  } finally {
    client.disconnect();
    for (const peer of peers) {peer.socket.destroy();}
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

async function hello(client: CompanionClient, getPeer: () => Promise<Peer>): Promise<{ peer: Peer; session: string }> {
  const connecting = client.connect();
  const peer = await getPeer();
  peer.send({ type: 'hello.challenge', version: V1, challenge: CHALLENGE });
  const request = await peer.next();
  assert.deepStrictEqual(request, { type: 'hello', version: V1, requestId: request.requestId,
    supported: { min: V1, max: V1 }, challenge: CHALLENGE });
  assert.ok(typeof request.requestId === 'string' && Buffer.byteLength(request.requestId, 'utf8') <= 64);
  const session = randomUUID();
  peer.send({ type: 'hello.ack', version: V1, requestId: request.requestId, challenge: CHALLENGE, sessionId: session });
  await connecting;
  return { peer, session };
}

function isCode(code: CompanionClientError['code']) {
  return (error: unknown) => error instanceof CompanionClientError && error.code === code;
}

suite('CompanionClient protocol', () => {
  test('exact v1 handshake and typed health/status reads', async () => fixture(async (client, getPeer) => {
    const { peer, session } = await hello(client, getPeer);
    const health = client.healthGet();
    const h = await peer.next();
    assert.deepStrictEqual(h, { type: 'health.get', version: V1, requestId: h.requestId, sessionId: session });
    peer.send({ type: 'health.get.result', version: V1, requestId: h.requestId, sessionId: session,
      health: { service: 'responsive', uptimeSeconds: 12 } });
    assert.deepStrictEqual(await health, { service: 'responsive', uptimeSeconds: 12 });
    const status = client.companionStatus();
    const s = await peer.next();
    assert.deepStrictEqual(s, { type: 'companion.status', version: V1, requestId: s.requestId, sessionId: session });
    peer.send({ type: 'companion.status.result', version: V1, requestId: s.requestId, sessionId: session,
      status: { state: 'ready', transport: process.platform === 'win32' ? 'named-pipe' : 'unix-domain-socket', protocol: V1 } });
    assert.strictEqual((await status).state, 'ready');
  }));

  test('incompatible and malformed challenges fail closed', async () => {
    for (const frame of [
      { type: 'hello.challenge', version: { major: 2, minor: 0 }, challenge: CHALLENGE },
      { type: 'hello.challenge', version: { major: '1', minor: 0 }, challenge: CHALLENGE },
      { type: 'hello.challenge', version: V1, challenge: 'invalid' },
      { type: 'hello.challenge', version: V1, challenge: CHALLENGE, extra: true },
      { type: 'health.get.result', version: V1, requestId: 'early', sessionId: randomUUID(), health: {} },
    ]) {
      await fixture(async (client, getPeer) => {
        const connecting = client.connect();
        (await getPeer()).send(frame);
        await assert.rejects(connecting, isCode(frame.version.major === 2 ? 'incompatible_protocol' : 'protocol_violation'));
        await assert.rejects(client.healthGet(), isCode('disconnected'));
      });
    }
  });

  test('wrong challenge, malformed ack, response before ack, and sanitized protocol errors fail closed', async () => {
    for (const mutation of [
      (request: Record<string, unknown>) => ({ type: 'hello.ack', version: V1, requestId: request.requestId,
        challenge: randomBytes(32).toString('base64url'), sessionId: randomUUID() }),
      (request: Record<string, unknown>) => ({ type: 'hello.ack', version: V1, requestId: request.requestId,
        challenge: CHALLENGE, sessionId: 'bad' }),
      (request: Record<string, unknown>) => ({ type: 'hello.ack', version: V1, requestId: request.requestId,
        challenge: CHALLENGE, sessionId: randomUUID(), extra: true }),
      (request: Record<string, unknown>) => ({ type: 'health.get.result', version: V1,
        requestId: request.requestId, sessionId: randomUUID(), health: { service: 'responsive', uptimeSeconds: 1 } }),
    ]) {
      await fixture(async (client, getPeer) => {
        const connecting = client.connect();
        const peer = await getPeer();
        peer.send({ type: 'hello.challenge', version: V1, challenge: CHALLENGE });
        peer.send(mutation(await peer.next()));
        await assert.rejects(connecting, isCode('protocol_violation'));
      });
    }
    await fixture(async (client, getPeer) => {
      const connecting = client.connect();
      const peer = await getPeer();
      peer.send({ type: 'hello.challenge', version: V1, challenge: CHALLENGE });
      const request = await peer.next();
      peer.send({ type: 'protocol.error', version: V1, requestId: request.requestId,
        code: 'INCOMPATIBLE_VERSION' });
      await assert.rejects(connecting, (error: unknown) => isCode('remote_protocol_error')(error) &&
        (error as CompanionClientError).remoteCode === 'INCOMPATIBLE_VERSION' &&
        !(error as Error).message.includes(CHALLENGE));
    });
  });

  test('connection and request timeouts are finite and clear the session', async () => {
    await fixture(async (client, getPeer) => {
      const connecting = client.connect();
      await getPeer();
      await assert.rejects(connecting, isCode('connection_timeout'));
    }, { connectionTimeoutMs: 40 });
    await fixture(async (client, getPeer) => {
      const { peer } = await hello(client, getPeer);
      const result = client.healthGet();
      await peer.next();
      await assert.rejects(result, isCode('request_timeout'));
      await assert.rejects(client.companionStatus(), isCode('disconnected'));
    }, { requestTimeoutMs: 40 });
  });

  test('32 pending requests are bounded; disconnect rejects each once and is idempotent', async () => fixture(async (client, getPeer) => {
    await hello(client, getPeer);
    const requests = Array.from({ length: 32 }, () => client.healthGet());
    let settled = 0;
    const tracked = requests.map((request) => request.catch((error) => {
      settled++;
      assert.ok(isCode('disconnected')(error));
    }));
    await assert.rejects(client.healthGet(), isCode('protocol_violation'));
    client.disconnect();
    client.disconnect();
    client.dispose();
    await Promise.all(tracked);
    assert.strictEqual(settled, 32);
    await assert.rejects(client.healthGet(), isCode('disconnected'));
  }));

  test('unknown, wrong-session, duplicate, and invalid-shape responses fail closed', async () => {
    for (const response of [
      (id: unknown, session: string) => ({ type: 'health.get.result', version: V1, requestId: 'unknown', sessionId: session,
        health: { service: 'responsive', uptimeSeconds: 1 } }),
      (id: unknown) => ({ type: 'health.get.result', version: V1, requestId: id, sessionId: randomUUID(),
        health: { service: 'responsive', uptimeSeconds: 1 } }),
      (id: unknown, session: string) => ({ type: 'health.get.result', version: V1, requestId: id, sessionId: session,
        health: { service: 'responsive', uptimeSeconds: -1 } }),
    ]) {
      await fixture(async (client, getPeer) => {
        const { peer, session } = await hello(client, getPeer);
        const result = client.healthGet();
        const request = await peer.next();
        peer.send(response(request.requestId, session));
        await assert.rejects(result, isCode('protocol_violation'));
      });
    }
    await fixture(async (client, getPeer) => {
      const { peer, session } = await hello(client, getPeer);
      const first = client.healthGet();
      const request = await peer.next();
      const response = { type: 'health.get.result', version: V1, requestId: request.requestId,
        sessionId: session, health: { service: 'responsive', uptimeSeconds: 2 } };
      peer.send(response);
      assert.strictEqual((await first).uptimeSeconds, 2);
      const second = client.healthGet();
      await peer.next();
      peer.send(response);
      await assert.rejects(second, isCode('protocol_violation'));
    });
  });

  test('explicit reconnect uses a fresh session and rejects stale session response', async () => fixture(async (client, getPeer) => {
    const first = await hello(client, getPeer);
    client.disconnect();
    const second = await hello(client, getPeer);
    assert.notStrictEqual(first.session, second.session);
    const result = client.healthGet();
    const request = await second.peer.next();
    second.peer.send({ type: 'health.get.result', version: V1, requestId: request.requestId,
      sessionId: first.session, health: { service: 'responsive', uptimeSeconds: 1 } });
    await assert.rejects(result, isCode('protocol_violation'));
  }));

  test('transport loss rejects every pending request once and a fresh generation ignores old socket events',
    async () => fixture(async (client, getPeer) => {
      const first = await hello(client, getPeer);
      const oldSocket = (client as unknown as { current: { socket: Socket } }).current.socket;
      let rejected = 0;
      const a = client.healthGet().catch((error) => { rejected++; assert.ok(isCode('disconnected')(error)); });
      const b = client.companionStatus().catch((error) => { rejected++; assert.ok(isCode('disconnected')(error)); });
      await first.peer.next();
      await first.peer.next();
      first.peer.socket.destroy();
      await Promise.all([a, b]);
      assert.strictEqual(rejected, 2);
      const second = await hello(client, getPeer);
      const current = client.healthGet();
      const request = await second.peer.next();
      oldSocket.emit('data', encodeClientFrame({ type: 'health.get.result', version: V1,
        requestId: request.requestId, sessionId: second.session,
        health: { service: 'responsive', uptimeSeconds: 99 } }));
      second.peer.send({ type: 'health.get.result', version: V1, requestId: request.requestId,
        sessionId: second.session, health: { service: 'responsive', uptimeSeconds: 3 } });
      assert.strictEqual((await current).uptimeSeconds, 3);
      assert.strictEqual(rejected, 2);
    }));

  test('refused endpoint is typed unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'far-away-client-refused-'));
    const server = createServer();
    const endpoint = localEndpoint(root);
    try {
      await new Promise<void>((resolve) => server.listen(endpoint.path, resolve));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const client = new CompanionClient({ paths: { testDataRoot: root }, connectionTimeoutMs: 200 });
      await assert.rejects(client.connect(), isCode('unavailable'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('absent Companion yields typed unavailable without creating a server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'far-away-client-absent-'));
    try {
      const client = new CompanionClient({ paths: { testDataRoot: root }, connectionTimeoutMs: 200 });
      await assert.rejects(client.connect(), isCode('unavailable'));
      client.disconnect();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
