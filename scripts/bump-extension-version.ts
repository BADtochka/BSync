import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type BumpKind = 'major' | 'minor' | 'patch' | 'none';

const bumpKind = (process.argv[2] ?? 'patch') as BumpKind;
const packagePath = resolve(import.meta.dir, '../apps/extension/package.json');

function bumpVersion(version: string, kind: BumpKind): string {
  if (kind === 'none') return version;

  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Unsupported extension version "${version}". Expected x.y.z.`);
  }

  const [, major, minor, patch] = match;
  const parts = [Number(major), Number(minor), Number(patch)] as const;

  if (kind === 'major') return `${parts[0] + 1}.0.0`;
  if (kind === 'minor') return `${parts[0]}.${parts[1] + 1}.0`;
  if (kind === 'patch') return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;

  throw new Error(`Unsupported bump kind "${kind}". Use major, minor, patch, or none.`);
}

const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
  version?: string;
};

if (!packageJson.version) {
  throw new Error('apps/extension/package.json has no version field.');
}

const previousVersion = packageJson.version;
const nextVersion = bumpVersion(previousVersion, bumpKind);
packageJson.version = nextVersion;

await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(nextVersion);

if (nextVersion !== previousVersion) {
  console.error(`Bumped extension version ${previousVersion} -> ${nextVersion}`);
}
