import { createHash } from 'node:crypto';
import { appendFile, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSZip from 'jszip';

type BrowserName = 'chrome' | 'firefox';
type ExtensionManifest = {
  manifest_version?: number;
  version?: string;
  browser_specific_settings?: {
    gecko?: {
      id?: string;
      data_collection_permissions?: { required?: string[] };
    };
  };
};

const browserName = process.argv[2] as BrowserName | undefined;
if (browserName !== 'chrome' && browserName !== 'firefox') {
  throw new Error('Usage: bun scripts/validate-extension-artifact.ts <chrome|firefox>');
}

const repositoryRoot = resolve(import.meta.dir, '..');
const extensionRoot = resolve(repositoryRoot, 'apps/extension');
const packageJson = JSON.parse(
  await readFile(resolve(extensionRoot, 'package.json'), 'utf8'),
) as { version?: string };
if (!packageJson.version) throw new Error('apps/extension/package.json has no version.');

const expectedTag = `v${packageJson.version}`;
const releaseTag = process.env.RELEASE_TAG;
if (releaseTag && releaseTag !== expectedTag) {
  throw new Error(`Release tag ${releaseTag} does not match extension version ${expectedTag}.`);
}

const outputRoot = resolve(extensionRoot, '.output');
const extensionPath = resolve(outputRoot, `bsync-${packageJson.version}-${browserName}.zip`);

async function loadZip(path: string): Promise<{ bytes: Buffer; zip: JSZip }> {
  const details = await stat(path);
  if (!details.isFile() || details.size === 0) throw new Error(`${path} is empty or not a file.`);
  const bytes = await readFile(path);
  return { bytes, zip: await JSZip.loadAsync(bytes, { checkCRC32: true }) };
}

function printArtifact(path: string, bytes: Buffer) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  console.log(`${path}\n  size=${bytes.byteLength} bytes\n  sha256=${hash}`);
}

async function setOutput(name: string, value: string) {
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

const extension = await loadZip(extensionPath);
const manifestEntry = extension.zip.file('manifest.json');
if (!manifestEntry) throw new Error(`${extensionPath} does not contain manifest.json at its root.`);
const manifest = JSON.parse(await manifestEntry.async('text')) as ExtensionManifest;

if (manifest.manifest_version !== 3) throw new Error('Extension artifact must use manifest_version 3.');
if (manifest.version !== packageJson.version) {
  throw new Error(`Manifest version ${manifest.version} does not match ${packageJson.version}.`);
}

printArtifact(extensionPath, extension.bytes);
await setOutput(`${browserName}_zip`, extensionPath);
await setOutput('version', packageJson.version);

if (browserName === 'firefox') {
  const expectedId = process.env.WXT_FIREFOX_EXTENSION_ID;
  if (!expectedId) throw new Error('WXT_FIREFOX_EXTENSION_ID is required for Firefox validation.');
  const validFirefoxId = /^(?:\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}|[a-z0-9._-]+@[a-z0-9._-]+)$/i;
  if (!validFirefoxId.test(expectedId)) {
    throw new Error('WXT_FIREFOX_EXTENSION_ID must be a {UUID} or an email-like Firefox ID.');
  }
  const gecko = manifest.browser_specific_settings?.gecko;
  if (gecko?.id !== expectedId) {
    throw new Error(`Firefox manifest ID ${gecko?.id ?? '<missing>'} does not match ${expectedId}.`);
  }
  if (!gecko.data_collection_permissions?.required?.length) {
    throw new Error('Firefox manifest is missing gecko.data_collection_permissions.required.');
  }

  const sourcesPath = resolve(outputRoot, `bsync-${packageJson.version}-sources.zip`);
  const sources = await loadZip(sourcesPath);
  const requiredSources = [
    'SOURCE_CODE_REVIEW.md',
    'package.json',
    'bun.lock',
    'apps/extension/package.json',
    'packages/sync-protocol/src/index.ts',
  ];
  for (const path of requiredSources) {
    if (!sources.zip.file(path)) throw new Error(`${sourcesPath} is missing ${path}.`);
  }
  printArtifact(sourcesPath, sources.bytes);
  await setOutput('sources_zip', sourcesPath);
}

console.log(`Validated BSync ${packageJson.version} ${browserName} artifact.`);
