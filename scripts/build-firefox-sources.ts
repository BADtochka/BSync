import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import JSZip from 'jszip';

const repositoryRoot = resolve(import.meta.dir, '..');
const extensionRoot = resolve(repositoryRoot, 'apps/extension');
const packageJson = JSON.parse(
  await readFile(resolve(extensionRoot, 'package.json'), 'utf8'),
) as { version?: string };

if (!packageJson.version) throw new Error('apps/extension/package.json has no version.');

const excludedNames = new Set(['.output', '.wxt', 'node_modules']);
const inputPaths = [
  'package.json',
  'bun.lock',
  'SOURCE_CODE_REVIEW.md',
  'apps/extension',
  'packages/sync-protocol',
  'scripts/build-firefox-sources.ts',
];
const zip = new JSZip();
const archiveDate = new Date('2020-01-01T00:00:00.000Z');

async function addPath(path: string): Promise<void> {
  const absolutePath = resolve(repositoryRoot, path);
  if (!absolutePath.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error(`Refusing to archive path outside the repository: ${path}`);
  }
  const details = await lstat(absolutePath);
  if (details.isSymbolicLink()) throw new Error(`Refusing to archive symlink: ${path}`);

  if (details.isDirectory()) {
    const entries = await readdir(absolutePath);
    entries.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    for (const entry of entries) {
      if (excludedNames.has(entry) || entry === '.env' || entry.startsWith('.env.')) continue;
      await addPath(relative(repositoryRoot, resolve(absolutePath, entry)));
    }
    return;
  }

  const archivePath = relative(repositoryRoot, absolutePath).split(sep).join('/');
  zip.file(archivePath, await readFile(absolutePath), {
    date: archiveDate,
    createFolders: false,
  });
}

for (const path of inputPaths) await addPath(path);

const outputPath = resolve(
  extensionRoot,
  `.output/bsync-${packageJson.version}-sources.zip`,
);
const archive = await zip.generateAsync({
  type: 'uint8array',
  compression: 'DEFLATE',
  compressionOptions: { level: 9 },
  platform: 'UNIX',
});
await writeFile(outputPath, archive);
console.log(`Created reproducible source archive: ${outputPath}`);
