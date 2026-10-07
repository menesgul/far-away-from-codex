import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.platform === 'win32') {
  const require = createRequire(import.meta.url);
  const command = require.resolve('node-gyp/bin/node-gyp.js');
  const result = spawnSync(process.execPath, [command, 'rebuild'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
