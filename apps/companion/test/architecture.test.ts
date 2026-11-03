import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

type Manifest = {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

test('workspace package dependencies preserve the M0 authority boundary', async () => {
  const cases = [
    ['packages/domain', []],
    ['packages/contracts', []],
    ['packages/agent-adapter-sdk', ['@far-away/domain']],
    ['apps/companion', ['@far-away/contracts', '@far-away/windows-ipc-security']],
    ['apps/vscode', ['@far-away/contracts']],
    ['apps/cloud', []],
  ] as const;
  const localPackage = (name: string) =>
    name.startsWith('@far-away/') || name === 'far-away-from-codex' ||
    name === 'far-away-from-codex-worker';
  for (const [directory, allowed] of cases) {
    const manifest = JSON.parse(await readFile(new URL(`../../../../${directory}/package.json`, import.meta.url), 'utf8')) as Manifest;
    const localDependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
      .filter(localPackage).sort();
    assert.deepEqual(localDependencies, [...allowed].sort(), `${manifest.name} workspace dependencies`);
  }
});
