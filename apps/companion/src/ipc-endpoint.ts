import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

export type LocalEndpoint =
  | { readonly transport: 'named-pipe'; readonly path: string }
  | { readonly transport: 'unix-domain-socket'; readonly path: string };

/** A stable locator derived from the selected data root. The name is public, never a credential. */
export function localEndpoint(dataRoot: string, platform: NodeJS.Platform = process.platform): LocalEndpoint {
  if (platform === 'win32') {
    if (!win32.isAbsolute(dataRoot)) throw new Error('IPC data root must be absolute');
    const identity = win32.normalize(dataRoot).toLowerCase();
    const digest = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 32);
    return { transport: 'named-pipe', path: `\\\\.\\pipe\\far-away-${digest}` };
  }
  if (!posix.isAbsolute(dataRoot)) throw new Error('IPC data root must be absolute');
  const path = posix.join(posix.resolve(dataRoot), 'companion.sock');
  if (Buffer.byteLength(path, 'utf8') > 100) throw new Error('Unix IPC socket path is too long');
  return { transport: 'unix-domain-socket', path };
}
