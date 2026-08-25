import { createInviteUrl, validateInviteEnvelope } from '../packages/invite/src/index';

const serverUrl = process.env.WXT_WS_SERVER?.trim() ?? '';
const publicWebOrigin = process.env.WXT_PUBLIC_WEB_ORIGIN?.trim() ?? '';

if (!serverUrl || !publicWebOrigin) {
  throw new Error('WXT_WS_SERVER and WXT_PUBLIC_WEB_ORIGIN are required');
}

validateInviteEnvelope({
  v: 2,
  serverUrl,
  roomId: 'CONFIG1',
  inviteToken: 'configuration_token_0001',
});

const origin = new URL(publicWebOrigin);
if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
  throw new Error('WXT_PUBLIC_WEB_ORIGIN must be an HTTPS origin without a path, query, or credentials');
}

createInviteUrl(publicWebOrigin, {
  v: 2,
  serverUrl,
  roomId: 'CONFIG1',
  inviteToken: 'configuration_token_0001',
});

console.log(`Validated public config: ${origin.origin} -> ${new URL(serverUrl).origin}`);
