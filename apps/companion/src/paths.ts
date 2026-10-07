import { mkdir } from 'node:fs/promises';
import { win32, posix } from 'node:path';
import { localDataRoot, type LocalPathEnvironment } from '@far-away/contracts';

export interface CompanionPaths {
  dataRoot: string;
  database: string;
  ownership: string;
}

export type PathEnvironment = LocalPathEnvironment;

export function resolveCompanionPaths(options: PathEnvironment = {}): CompanionPaths {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const dataRoot = localDataRoot(options);
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
