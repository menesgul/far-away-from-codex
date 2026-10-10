import * as assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localDataRoot, localEndpoint } from '@far-away/contracts';
import { CompanionClient } from '../../companion/CompanionClient';
import { createCompanionStatusProjection, type CompanionStatusText } from '../../companion/CompanionStatusProjection';

suite('CompanionClient real local transport', () => {
  test('shared locator preserves Windows, macOS, Linux/XDG, and UDS semantics', () => {
    const win = localDataRoot({ platform: 'win32', localAppData: 'C:\\Users\\test\\AppData\\Local' });
    assert.strictEqual(win, 'C:\\Users\\test\\AppData\\Local\\Far Away');
    assert.deepStrictEqual(localEndpoint(win, 'win32'), {
      transport: 'named-pipe', path: '\\\\.\\pipe\\far-away-f60ffe992d18ee48afbad72e262d6e7f',
    });
    assert.strictEqual(localDataRoot({ platform: 'darwin', home: '/Users/test' }),
      '/Users/test/Library/Application Support/Far Away');
    assert.strictEqual(localDataRoot({ platform: 'linux', home: '/home/test', xdgDataHome: '/data/test' }),
      '/data/test/far-away');
    assert.strictEqual(localDataRoot({ platform: 'linux', home: '/home/test', xdgDataHome: '' }),
      '/home/test/.local/share/far-away');
    assert.deepStrictEqual(localEndpoint('/tmp/far-away', 'linux'), {
      transport: 'unix-domain-socket', path: '/tmp/far-away/companion.sock',
    });
    assert.throws(() => localEndpoint('relative', 'linux'), /absolute/);
    assert.throws(() => localEndpoint('/' + 'a'.repeat(100), 'linux'), /too long/);
  });

  test('two clients handshake and read against one running Companion; disconnect is isolated',
    async function () {
      this.timeout(15000);
      const root = await mkdtemp(join(tmpdir(), 'far-away-real-client-'));
      const application = pathToFileURL(resolve(__dirname, '../../../../companion/dist/src/application.js')).href;
      const script = `
        import { CompanionApplication } from ${JSON.stringify(application)};
        const app = new CompanionApplication({ paths: { testDataRoot: process.argv[1] } });
        try {
          await app.start();
          process.stdout.write('READY\\n');
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', async (data) => {
            if (data.includes('STOP')) {
              try { await app.stop(); process.stdout.write('STOPPED\\n'); process.exit(0); }
              catch { process.exit(1); }
            }
          });
        } catch { process.exit(1); }
      `;
      const child: ChildProcessWithoutNullStreams = spawn(process.execPath,
        ['--input-type=module', '-e', script, root], { stdio: ['pipe', 'pipe', 'pipe'] });
      const a = new CompanionClient({ paths: { testDataRoot: root } });
      const b = new CompanionClient({ paths: { testDataRoot: root } });
      const aStates: CompanionStatusText[] = [];
      const bStates: CompanionStatusText[] = [];
      const aProjection = createCompanionStatusProjection(a, (state) => aStates.push(state));
      const bProjection = createCompanionStatusProjection(b, (state) => bStates.push(state));
      let output = '';
      let errors = '';
      child.stdout.on('data', (data: Buffer) => { output += data.toString('utf8'); });
      child.stderr.on('data', (data: Buffer) => { errors += data.toString('utf8'); });
      const until = async (predicate: () => boolean) => {
        const deadline = Date.now() + 5000;
        while (!predicate()) {
          if (child.exitCode !== null) {throw new Error(`Test Companion exited before READY: ${errors.slice(-500)}`);}
          if (Date.now() > deadline) {throw new Error(`Test Companion timed out: ${errors.slice(-500)}`);}
          await new Promise((done) => setTimeout(done, 10));
        }
      };
      try {
        await until(() => output.includes('READY'));
        await a.connect();
        assert.strictEqual((await a.healthGet()).service, 'responsive');
        assert.deepStrictEqual(await a.companionStatus(), {
          state: 'ready', transport: process.platform === 'win32' ? 'named-pipe' : 'unix-domain-socket',
          protocol: { major: 1, minor: 0 },
        });
        await b.connect();
        assert.strictEqual((await b.healthGet()).service, 'responsive');
        await aProjection.probe();
        await bProjection.probe();
        assert.strictEqual(aStates.at(-1), 'Companion: Connected (last check)');
        assert.strictEqual(bStates.at(-1), 'Companion: Connected (last check)');
        aProjection.dispose();
        assert.strictEqual((await b.companionStatus()).state, 'ready');
        await bProjection.probe();
        assert.strictEqual(bStates.at(-1), 'Companion: Connected (last check)');
        child.stdin.write('STOP\n');
        if (child.exitCode === null) {
          await new Promise<void>((done) => child.once('exit', () => done()));
        }
        await assert.rejects(b.companionStatus(), { code: 'disconnected' });
        // The prior result remains explicitly historical after the actual socket closes.
        assert.strictEqual(bStates.at(-1), 'Companion: Connected (last check)');
      } finally {
        aProjection.dispose();
        bProjection.dispose();
        if (child.exitCode === null) {
          child.stdin.write('STOP\n');
          try { await until(() => output.includes('STOPPED')); }
          catch { child.kill(); }
        }
        if (child.exitCode === null) {
          await new Promise<void>((done) => child.once('exit', () => done()));
        }
        await rm(root, { recursive: true, force: true });
      }
    });
});
