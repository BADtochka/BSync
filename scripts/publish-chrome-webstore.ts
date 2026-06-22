import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

type TokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

type ApiResponse = {
  uploadState?: string;
  itemError?: Array<{ error_detail?: string }>;
  status?: Array<string>;
  statusDetail?: string[];
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function readJsonResponse(response: Response): Promise<ApiResponse | TokenResponse> {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text) as ApiResponse | TokenResponse;
  } catch {
    return { error: { message: text } } as ApiResponse;
  }
}

function assertOk(response: Response, payload: ApiResponse | TokenResponse, action: string) {
  if (response.ok) return;

  const details =
    'error_description' in payload && payload.error_description
      ? payload.error_description
      : 'error' in payload && typeof payload.error === 'object'
        ? payload.error?.message
        : JSON.stringify(payload);

  throw new Error(`${action} failed with HTTP ${response.status}: ${details}`);
}

async function getServiceAccountAccessToken(key: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claimSet = base64UrlEncode(
    JSON.stringify({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/chromewebstore',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    }),
  );
  const unsignedToken = `${header}.${claimSet}`;
  const sign = createSign('RSA-SHA256');
  sign.update(unsignedToken);
  sign.end();
  const jwt = `${unsignedToken}.${base64UrlEncode(sign.sign(key.private_key))}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const payload = (await readJsonResponse(response)) as TokenResponse;
  assertOk(response, payload, 'Requesting Chrome Web Store access token from service account');

  if (!payload.access_token) {
    throw new Error('Service account token response did not include access_token.');
  }

  return payload.access_token;
}

async function getAccessToken(): Promise<string> {
  const directToken = process.env.CHROME_ACCESS_TOKEN;
  if (directToken) return directToken;

  const keyJson = process.env.CHROME_SERVICE_ACCOUNT_KEY;
  if (keyJson) {
    const key = JSON.parse(keyJson) as ServiceAccountKey;
    if (!key.client_email || !key.private_key) {
      throw new Error('CHROME_SERVICE_ACCOUNT_KEY must include client_email and private_key.');
    }

    return getServiceAccountAccessToken(key);
  }

  throw new Error('CHROME_ACCESS_TOKEN or CHROME_SERVICE_ACCOUNT_KEY is required.');
}

async function main() {
  const [zipPath] = process.argv.slice(2);
  if (!zipPath) {
    throw new Error('Usage: bun scripts/publish-chrome-webstore.ts <chrome-extension.zip>');
  }

  const extensionId = requireEnv('CHROME_EXTENSION_ID');
  const publisherId = requireEnv('CHROME_PUBLISHER_ID');
  const dryRun = process.env.DRY_RUN === 'true';
  const publish = process.env.CHROME_PUBLISH !== 'false';

  if (dryRun) {
    console.log(`[dry-run] Would upload ${basename(zipPath)} to Chrome item ${extensionId}.`);
    console.log(`[dry-run] Would ${publish ? 'publish' : 'skip publish for'} Chrome item ${extensionId}.`);
    return;
  }

  const token = await getAccessToken();
  const zip = await readFile(zipPath);
  const baseUrl = `https://chromewebstore.googleapis.com/v2/publishers/${publisherId}/items/${extensionId}`;

  const uploadResponse = await fetch(`https://chromewebstore.googleapis.com/upload/v2/publishers/${publisherId}/items/${extensionId}:upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/zip',
    },
    body: zip,
  });
  const uploadPayload = (await readJsonResponse(uploadResponse)) as ApiResponse;
  assertOk(uploadResponse, uploadPayload, 'Uploading Chrome extension package');

  if (uploadPayload.uploadState && uploadPayload.uploadState !== 'SUCCESS') {
    const errors = uploadPayload.itemError?.map((item) => item.error_detail).filter(Boolean).join('; ');
    throw new Error(`Chrome upload state is ${uploadPayload.uploadState}${errors ? `: ${errors}` : ''}`);
  }

  console.log(`Uploaded ${basename(zipPath)} to Chrome Web Store.`);

  if (!publish) {
    console.log('Skipping Chrome publish because CHROME_PUBLISH=false.');
    return;
  }

  const publishResponse = await fetch(`${baseUrl}:publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  const publishPayload = (await readJsonResponse(publishResponse)) as ApiResponse;
  assertOk(publishResponse, publishPayload, 'Publishing Chrome extension package');

  console.log(`Submitted Chrome item ${extensionId} for publishing.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
