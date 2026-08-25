import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '..');
const wxtPackage = JSON.parse(
  await readFile(resolve(repositoryRoot, 'apps/extension/node_modules/wxt/package.json'), 'utf8'),
) as { version?: string };
const lockfile = await readFile(resolve(repositoryRoot, 'bun.lock'), 'utf8');
const publisherVersion = lockfile.match(
  /"publish-browser-extension": \["publish-browser-extension@([^"]+)"/,
)?.[1];

console.log(`Bun ${Bun.version}`);
console.log(`WXT ${wxtPackage.version ?? '<unknown>'}`);
console.log(`publish-browser-extension ${publisherVersion ?? '<not installed>'}`);
