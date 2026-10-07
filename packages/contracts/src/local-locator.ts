/// <reference types="node" />
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, resolve, win32, posix } from 'node:path';

export interface LocalPathEnvironment {
  platform?: NodeJS.Platform;
  home?: string;
  localAppData?: string;
  xdgDataHome?: string;
  testDataRoot?: string;
}

export type LocalEndpoint =
  | { readonly transport: 'named-pipe'; readonly path: string }
  | { readonly transport: 'unix-domain-socket'; readonly path: string };

/** Pure per-user locator. Its result is public location information, never a credential. */
export function localDataRoot(options: LocalPathEnvironment = {}): string {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const home = options.home ?? homedir();
  if (options.testDataRoot !== undefined) {
    if (!isAbsolute(options.testDataRoot)) throw new Error('Companion test data root must be absolute');
    return resolve(options.testDataRoot);
  }
  if (platform === 'win32') {
    const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
    if (!localAppData || !paths.isAbsolute(localAppData)) throw new Error('LOCALAPPDATA must be an absolute path for Companion data');
    return paths.join(localAppData, 'Far Away');
  }
  if (platform === 'darwin') {
    if (!paths.isAbsolute(home)) throw new Error('Home directory must be absolute for Companion data');
    return paths.join(home, 'Library', 'Application Support', 'Far Away');
  }
  const xdgDataHome = options.xdgDataHome ?? process.env.XDG_DATA_HOME;
  const base = xdgDataHome || paths.join(home, '.local', 'share');
  if (!paths.isAbsolute(base)) throw new Error('XDG data directory must be absolute for Companion data');
  return paths.join(base, 'far-away');
}

/** Exact M0.7 Named Pipe / UDS derivation from the selected data root. */
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
