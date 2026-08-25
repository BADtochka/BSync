import { createHmac, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

type JsonObject = Record<string, unknown>;
type UploadResponse = JsonObject & {
  uuid?: string;
  processed?: boolean;
  valid?: boolean;
};

const API_ROOT = 'https://addons.mozilla.org/api/v5/addons';
const POLL_INTERVAL_MS = 5000;
const VALIDATION_TIMEOUT_MS = 10 * 60 * 1000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function createJwt(issuer: string, secret: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    iss: issuer,
    jti: randomUUID(),
    iat: issuedAt,
    exp: issuedAt + 60,
  }));
  const unsigned = `${header}.${payload}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest();
  return `${unsigned}.${base64Url(signature)}`;
}

async function requestJson(
  url: string,
  issuer: string,
  secret: string,
  init: RequestInit = {},
): Promise<JsonObject> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `JWT ${createJwt(issuer, secret)}`,
    },
  });
  const text = await response.text();
  let payload: JsonObject;
  try {
    payload = text ? JSON.parse(text) as JsonObject : {};
  } catch {
    payload = { rawResponse: text };
  }

  if (!response.ok) {
    console.error(`AMO ${init.method ?? 'GET'} ${url} -> ${response.status} ${response.statusText}`);
    console.error(JSON.stringify(payload, null, 2));
    throw new Error(`AMO request failed with HTTP ${response.status}.`);
  }
  return payload;
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function compareVersions(left: string, right: string): number {
  const parse = (version: string) => version.split('.').map((part) => Number(part));
  const leftParts = parse(left);
  const rightParts = parse(right);
  if ([...leftParts, ...rightParts].some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`Cannot compare AMO versions "${left}" and "${right}".`);
  }
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

async function fileBlob(path: string): Promise<Blob> {
  const bytes = await readFile(path);
  return new Blob([new Uint8Array(bytes)], { type: 'application/zip' });
}

async function main() {
  const extensionPath = readArgument('--firefox-zip');
  const sourcesPath = readArgument('--sources-zip');
  const channel = readArgument('--channel') ?? process.env.FIREFOX_CHANNEL ?? 'listed';
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';
  if (!extensionPath || !sourcesPath || !['listed', 'unlisted'].includes(channel)) {
    throw new Error('Usage: publish-firefox-addons.ts --firefox-zip <zip> --sources-zip <zip> --channel <listed|unlisted> [--dry-run]');
  }

  await Promise.all([stat(extensionPath), stat(sourcesPath)]);
  const extensionId = requireEnv('WXT_FIREFOX_EXTENSION_ID');
  const issuer = requireEnv('FIREFOX_JWT_ISSUER');
  const secret = requireEnv('FIREFOX_JWT_SECRET');
  const packageJson = JSON.parse(
    await readFile(resolve(import.meta.dir, '../apps/extension/package.json'), 'utf8'),
  ) as { version?: string };
  if (!packageJson.version) throw new Error('Extension package version is missing.');

  const addonUrl = `${API_ROOT}/addon/${encodeURIComponent(extensionId)}/`;
  await requestJson(addonUrl, issuer, secret);
  const versionsResponse = await requestJson(
    `${addonUrl}versions/?filter=all_with_unlisted&page_size=50`,
    issuer,
    secret,
  );
  const versions = Array.isArray(versionsResponse.results)
    ? versionsResponse.results
        .map((entry) => (entry as JsonObject).version)
        .filter((version): version is string => typeof version === 'string')
    : [];
  const newestVersion = versions.reduce<string | undefined>((newest, version) => {
    if (!newest || compareVersions(version, newest) > 0) return version;
    return newest;
  }, undefined);
  if (newestVersion && compareVersions(packageJson.version, newestVersion) <= 0) {
    throw new Error(`Extension version ${packageJson.version} must be newer than existing AMO version ${newestVersion}.`);
  }
  console.log(`AMO credentials and add-on identity verified for ${extensionId}.`);
  console.log(`Local version=${packageJson.version}; newest AMO version=${newestVersion ?? '<none>'}; channel=${channel}.`);

  if (dryRun) {
    console.log(`[dry-run] Validated ${basename(extensionPath)} and ${basename(sourcesPath)} without upload.`);
    return;
  }

  const uploadForm = new FormData();
  uploadForm.set('channel', channel);
  uploadForm.set('upload', await fileBlob(extensionPath), basename(extensionPath));
  let upload = await requestJson(`${API_ROOT}/upload/`, issuer, secret, {
    method: 'POST',
    body: uploadForm,
  }) as UploadResponse;
  if (!upload.uuid) throw new Error(`AMO upload response has no UUID: ${JSON.stringify(upload)}`);
  console.log(`AMO upload UUID: ${upload.uuid}`);

  const deadline = Date.now() + VALIDATION_TIMEOUT_MS;
  while (!upload.processed && Date.now() < deadline) {
    await Bun.sleep(POLL_INTERVAL_MS);
    upload = await requestJson(`${API_ROOT}/upload/${upload.uuid}/`, issuer, secret) as UploadResponse;
    console.log(`AMO validation status: processed=${Boolean(upload.processed)} valid=${String(upload.valid)}`);
  }

  console.log('Full AMO validation report:');
  console.log(JSON.stringify(upload, null, 2));
  if (!upload.processed) throw new Error(`AMO validation timed out for upload ${upload.uuid}.`);
  if (!upload.valid) throw new Error(`AMO rejected upload ${upload.uuid}; see the full report above.`);

  const versionForm = new FormData();
  versionForm.set('upload', upload.uuid);
  versionForm.set('source', await fileBlob(sourcesPath), basename(sourcesPath));
  const version = await requestJson(addonUrl + 'versions/', issuer, secret, {
    method: 'POST',
    body: versionForm,
  });
  console.log('AMO version creation response:');
  console.log(JSON.stringify(version, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
