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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
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

async function getAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: requireEnv('CHROME_CLIENT_ID'),
    client_secret: requireEnv('CHROME_CLIENT_SECRET'),
    refresh_token: requireEnv('CHROME_REFRESH_TOKEN'),
    grant_type: 'refresh_token',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body,
  });
  const payload = (await readJsonResponse(response)) as TokenResponse;
  assertOk(response, payload, 'Refreshing Chrome Web Store access token');

  if (!payload.access_token) {
    throw new Error('Chrome Web Store token response did not include access_token.');
  }

  return payload.access_token;
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
