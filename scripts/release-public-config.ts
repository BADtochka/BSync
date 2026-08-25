import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type ReleasePublicConfig = {
  syncServer: string;
  publicWebOrigin: string;
  firefoxExtensionId: string;
};

const path = resolve(import.meta.dir, '../apps/extension/release-config.json');
const mode = process.argv[2];

if (mode === 'write') {
  const config: ReleasePublicConfig = {
    syncServer: process.env.WXT_WS_SERVER ?? '',
    publicWebOrigin: process.env.WXT_PUBLIC_WEB_ORIGIN ?? '',
    firefoxExtensionId: process.env.WXT_FIREFOX_EXTENSION_ID ?? '',
  };
  if (Object.values(config).some((value) => !value)) {
    throw new Error('Public release configuration is incomplete.');
  }
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
} else if (mode === 'export') {
  const config = JSON.parse(await readFile(path, 'utf8')) as ReleasePublicConfig;
  const output = process.env.GITHUB_ENV;
  if (!output) throw new Error('GITHUB_ENV is required when exporting release configuration.');
  await appendFile(
    output,
    [
      `WXT_WS_SERVER=${config.syncServer}`,
      `WXT_PUBLIC_WEB_ORIGIN=${config.publicWebOrigin}`,
      `WXT_FIREFOX_EXTENSION_ID=${config.firefoxExtensionId}`,
      '',
    ].join('\n'),
  );
} else {
  throw new Error('Usage: bun scripts/release-public-config.ts <write|export>');
}
