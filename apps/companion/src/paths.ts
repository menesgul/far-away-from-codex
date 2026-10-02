import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, win32, posix } from 'node:path';

export interface CompanionPaths {
  dataRoot: string;
  database: string;
  ownership: string;
}

export interface PathEnvironment {
  platform?: NodeJS.Platform;
  home?: string;
  localAppData?: string;
  xdgDataHome?: string;
  testDataRoot?: string;
}

export function resolveCompanionPaths(options: PathEnvironment = {}): CompanionPaths {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const home = options.home ?? homedir();
  let dataRoot: string;
  if (options.testDataRoot !== undefined) {
    if (!isAbsolute(options.testDataRoot)) throw new Error('Companion test data root must be absolute');
    dataRoot = resolve(options.testDataRoot);
  } else if (platform === 'win32') {
    const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
    if (!localAppData || !paths.isAbsolute(localAppData)) throw new Error('LOCALAPPDATA must be an absolute path for Companion data');
    dataRoot = paths.join(localAppData, 'Far Away');
  } else if (platform === 'darwin') {
    if (!paths.isAbsolute(home)) throw new Error('Home directory must be absolute for Companion data');
    dataRoot = paths.join(home, 'Library', 'Application Support', 'Far Away');
  } else {
    const xdgDataHome = options.xdgDataHome ?? process.env.XDG_DATA_HOME;
    const base = xdgDataHome || paths.join(home, '.local', 'share');
    if (!paths.isAbsolute(base)) throw new Error('XDG data directory must be absolute for Companion data');
    dataRoot = paths.join(base, 'far-away');
  }
  return {
    dataRoot,
    database: paths.join(dataRoot, 'companion.sqlite'),
    ownership: paths.join(dataRoot, 'companion.owner'),
  };
}

export async function createDataRoot(paths: CompanionPaths, platform = process.platform): Promise<void> {
  try {
    await mkdir(paths.dataRoot, { recursive: true, mode: platform === 'win32' ? undefined : 0o700 });
  } catch (error) {
    throw new Error(`Cannot create Companion data directory ${paths.dataRoot}`, { cause: error });
  }
}
