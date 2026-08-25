export const INVITE_VERSION = 2 as const;
export const MAX_INVITE_LENGTH = 4096;

export interface InviteEnvelopeV2 {
  v: typeof INVITE_VERSION;
  serverUrl: string;
  roomId: string;
  inviteToken: string;
  expiresAt?: number;
}

export const WEB_BRIDGE_VERSION = 1 as const;
export const MAX_BRIDGE_REQUEST_ID_LENGTH = 128;

export type BsyncWebBridgeRequest =
  | {
      source: 'bsync:web';
      version: typeof WEB_BRIDGE_VERSION;
      type: 'bsync:extension-probe';
      requestId: string;
    }
  | {
      source: 'bsync:web';
      version: typeof WEB_BRIDGE_VERSION;
      type: 'bsync:join-invite';
      requestId: string;
      payload: { invite: InviteEnvelopeV2; nonce: string };
    };

export type BsyncWebBridgeResponse = {
  source: 'bsync:extension';
  version: typeof WEB_BRIDGE_VERSION;
  type: 'bsync:extension-ready' | 'bsync:join-result';
  requestId: string;
  ok: boolean;
  error?: string;
  payload?: { nonce: string };
};

export interface InviteValidationOptions {
  allowLocal?: boolean;
  now?: number;
  maxLength?: number;
}

export type InviteErrorCode =
  | 'too-long'
  | 'malformed'
  | 'unsupported-version'
  | 'invalid-server'
  | 'invalid-room'
  | 'invalid-token'
  | 'expired';

export class InviteValidationError extends Error {
  constructor(
    readonly code: InviteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InviteValidationError';
  }
}

export function encodeInviteEnvelope(
  envelope: InviteEnvelopeV2,
  options: InviteValidationOptions = {},
): string {
  const validated = validateInviteEnvelope(envelope, options);
  const bytes = new TextEncoder().encode(JSON.stringify(validated));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
  if (encoded.length > (options.maxLength ?? MAX_INVITE_LENGTH)) {
    throw new InviteValidationError('too-long', 'Invite is too long');
  }
  return encoded;
}

export function decodeInviteEnvelope(
  input: string,
  options: InviteValidationOptions = {},
): InviteEnvelopeV2 {
  const maxLength = options.maxLength ?? MAX_INVITE_LENGTH;
  if (input.length > maxLength) {
    throw new InviteValidationError('too-long', 'Invite is too long');
  }
  const encoded = extractInviteFragment(input);
  if (!encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new InviteValidationError('malformed', 'Invite payload is malformed');
  }
  if (encoded.length > maxLength) {
    throw new InviteValidationError('too-long', 'Invite is too long');
  }

  try {
    const padded = encoded.replaceAll('-', '+').replaceAll('_', '/').padEnd(
      encoded.length + ((4 - (encoded.length % 4)) % 4),
      '=',
    );
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return validateInviteEnvelope(decoded, options);
  } catch (error) {
    if (error instanceof InviteValidationError) throw error;
    throw new InviteValidationError('malformed', 'Invite payload is malformed');
  }
}

export function createInviteUrl(
  publicWebOrigin: string,
  envelope: InviteEnvelopeV2,
  options: InviteValidationOptions = {},
): string {
  let url: URL;
  try {
    url = new URL('/invite', publicWebOrigin);
  } catch {
    throw new InviteValidationError('malformed', 'Public web origin is invalid');
  }
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(options.allowLocal && url.protocol === 'http:' && isLocalHostname(url.hostname)))
  ) {
    throw new InviteValidationError('malformed', 'Public web origin must use HTTPS');
  }
  url.search = '';
  url.hash = encodeInviteEnvelope(envelope, options);
  return url.href;
}

export function validateInviteEnvelope(
  value: unknown,
  options: InviteValidationOptions = {},
): InviteEnvelopeV2 {
  if (!isRecord(value)) {
    throw new InviteValidationError('malformed', 'Invite payload must be an object');
  }
  const allowedKeys = new Set(['v', 'serverUrl', 'roomId', 'inviteToken', 'expiresAt']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new InviteValidationError('malformed', 'Invite payload contains unknown fields');
  }
  if (value.v !== INVITE_VERSION) {
    throw new InviteValidationError('unsupported-version', 'Invite version is not supported');
  }
  if (typeof value.roomId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/u.test(value.roomId)) {
    throw new InviteValidationError('invalid-room', 'Room identifier is invalid');
  }
  if (
    typeof value.inviteToken !== 'string' ||
    !/^[A-Za-z0-9_-]{16,256}$/u.test(value.inviteToken)
  ) {
    throw new InviteValidationError('invalid-token', 'Invite token is invalid');
  }
  if (typeof value.serverUrl !== 'string' || !isAllowedServerUrl(value.serverUrl, options.allowLocal)) {
    throw new InviteValidationError('invalid-server', 'Invite server must use WSS');
  }
  if (
    value.expiresAt !== undefined &&
    (!Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= 0)
  ) {
    throw new InviteValidationError('malformed', 'Invite expiration is invalid');
  }
  if (typeof value.expiresAt === 'number' && value.expiresAt <= (options.now ?? Date.now())) {
    throw new InviteValidationError('expired', 'Invite has expired');
  }

  return {
    v: INVITE_VERSION,
    serverUrl: value.serverUrl,
    roomId: value.roomId,
    inviteToken: value.inviteToken,
    ...(typeof value.expiresAt === 'number' ? { expiresAt: value.expiresAt } : {}),
  };
}

export function isBsyncWebBridgeRequest(value: unknown): value is BsyncWebBridgeRequest {
  if (!isRecord(value) || !hasExactKeys(value, ['source', 'version', 'type', 'requestId'], ['payload'])) {
    return false;
  }
  if (
    value.source !== 'bsync:web' ||
    value.version !== WEB_BRIDGE_VERSION ||
    !isBridgeRequestId(value.requestId)
  ) {
    return false;
  }
  if (value.type === 'bsync:extension-probe') return value.payload === undefined;
  if (value.type !== 'bsync:join-invite' || !isRecord(value.payload)) return false;
  if (!hasExactKeys(value.payload, ['invite', 'nonce'])) return false;
  return isInviteEnvelopeShape(value.payload.invite) && isBridgeRequestId(value.payload.nonce);
}

export function isBsyncWebBridgeResponse(value: unknown): value is BsyncWebBridgeResponse {
  if (!isRecord(value) || !hasExactKeys(value, ['source', 'version', 'type', 'requestId', 'ok'], ['error', 'payload'])) {
    return false;
  }
  return (
    value.source === 'bsync:extension' &&
    value.version === WEB_BRIDGE_VERSION &&
    (value.type === 'bsync:extension-ready' || value.type === 'bsync:join-result') &&
    isBridgeRequestId(value.requestId) &&
    typeof value.ok === 'boolean' &&
    (value.error === undefined || (typeof value.error === 'string' && value.error.length <= 512)) &&
    (value.payload === undefined || (
      isRecord(value.payload) &&
      hasExactKeys(value.payload, ['nonce']) &&
      isBridgeRequestId(value.payload.nonce)
    ))
  );
}

function extractInviteFragment(input: string): string {
  const trimmed = input.trim();
  const fragmentIndex = trimmed.indexOf('#');
  return (fragmentIndex >= 0 ? trimmed.slice(fragmentIndex + 1) : trimmed).replace(/^#/u, '');
}

function isAllowedServerUrl(value: string, allowLocal = false): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    if (url.protocol === 'wss:') return true;
    return allowLocal && url.protocol === 'ws:' && isLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function isBridgeRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_BRIDGE_REQUEST_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

function isInviteEnvelopeShape(value: unknown): value is InviteEnvelopeV2 {
  if (!isRecord(value) || !hasExactKeys(value, ['v', 'serverUrl', 'roomId', 'inviteToken'], ['expiresAt'])) {
    return false;
  }
  return (
    value.v === INVITE_VERSION &&
    typeof value.serverUrl === 'string' &&
    value.serverUrl.length <= 2048 &&
    typeof value.roomId === 'string' &&
    value.roomId.length <= 64 &&
    typeof value.inviteToken === 'string' &&
    value.inviteToken.length <= 256 &&
    (value.expiresAt === undefined || Number.isSafeInteger(value.expiresAt))
  );
}
